# Kate scroll-following compatibility

The annotation project's follow-scroll feature (ink that tracks the
document as the user scrolls) is implemented against AT-SPI, not against
Kate's internal APIs. What actually matters is:

1. **Kate exposes its editor widget as an AT-SPI `TEXT` accessible** with
   a working `Text` interface (`get_character_extents(0)` returns a
   non-degenerate rect when character 0 is on-screen).
2. **The embedded Konsole is exposed as `TERMINAL`**, or at minimum as
   something whose descendants our walker won't mistake for the editor.
3. **A vertical `SCROLL_BAR` accessible** lives adjacent to the editor,
   and fires `object:value-changed` as the user scrolls.
4. **The AT-SPI registry is running** on the session bus
   (`at-spi2-registryd` via `at-spi2-core`). Without it, Qt's
   accessibility bridge stays dormant and the tracker gets nothing.

Kate and Qt don't version-lock any of this; see the "what actually gates
compatibility" section below for the real dependency matrix.

## Known-good versions

These are combinations we've run the project against. Anything at or
above a listed row *should* work; anything below is untested and may
fail on role reporting or `get_character_extents` behavior.

| Kate version | Qt version | KF6 version | at-spi2-core | Result                          |
| ------------ | ---------- | ----------- | ------------ | ------------------------------- |
| 24.02+       | 6.6+       | 6.0+        | 2.50+        | Known-good. Editor + scroll.    |
| 23.08        | 6.5        | 5.115       | 2.48         | Editor detection works; scroll  |
|              |            |             |              | occasionally reports stale      |
|              |            |             |              | char0 extents on very fast      |
|              |            |             |              | flicks. Workable.               |
| < 23.08      | -          | -           | -            | Untested. Don't rely on it.     |

The `install-kate-runtime-chroot.sh` helper installs whatever the target
distro's current `kate` and `at-spi2-core` happen to be; on Arch that
tracks upstream closely, so new installs land well inside the
known-good range.

## What actually gates compatibility

The scroll-following code's dependencies in order of fragility:

### Qt's AT-SPI bridge being active

Qt 6 ships an AT-SPI bridge as part of `qt6-base`, but it only *turns on*
when `at-spi2-core` is running on the session bus. On a fresh distro
install without the AT-SPI service, Kate's accessibility tree is simply
empty. Symptom: the Shell log says

```
KateTrackerManager: discovery exhausted for pid <N> without finding an editor
```

Fix: ensure `at-spi2-core` is installed and the session bus has
`org.a11y.Bus` on it. GNOME pulls it in transitively; on minimal setups
install it explicitly.

### `Text.get_character_extents(0)` accuracy

Our `kateTracker.js` uses the window-local y of character 0 as a scroll
reference frame. This avoids having to know whether the scrollbar reports
pixels, lines, or arbitrary document units. It requires Qt's text
accessibility to return a correct, non-zero rect for character 0 when
that character is on-screen.

Known Qt quirk: when character 0 is scrolled far out of view, Qt has
been observed to hand back an all-zero rect. `kateTracker.js` already
guards against this and defers the baseline. If you ever see scroll
"snap" to a nonsense offset for one frame, first suspect this and
check that the guard is still in place
(see `_captureBaseline` and `_republishScroll`).

### Role stability

Changes to Kate's widget tree that renames or repositions the
editor/terminal accessibles would break detection. We pick the largest
`TEXT`-role descendant that isn't under a `TERMINAL` ancestor and has
width ≥ 200 px, height ≥ 200 px. If Kate adds a large non-editor `TEXT`
accessible (e.g. a "welcome screen" pane that meets our size
thresholds), bump `MIN_EDITOR_WIDTH` / `MIN_EDITOR_HEIGHT` or add a
parent-role exclusion.

## Test procedure

1. Boot the second partition (or your dev install) with the annotations
   Mutter + shell extension.
2. Launch `kate <your-project>` with at least ~50 lines of content.
3. Open the Konsole pane (`Settings → Show Tool Views → Terminal`) to
   exercise the TERMINAL-role exclusion.
4. Activate the annotation pen (stylus or touch), draw a shape on the
   visible text.
5. Scroll the document with the scrollbar / wheel / keyboard.
6. **Expected:** the drawn ink moves up/down with the text, stops at
   the editor's top/bottom edge (clipped by the editor region).
7. **Expected:** ink drawn on the Konsole pane does *not* follow scroll
   (terminal is excluded by design).
8. Scroll so your drawing goes off-screen, then scroll back: ink
   returns at the same document offset.

If any of these fail, the Shell log (`journalctl --user -b -u
gnome-shell`) is the first place to look; the tracker logs warnings
with specific causes.

## Diagnosing failures from the journal

Grep for `KateTracker` / `Annotation` in `journalctl --user -b -u
gnome-shell`:

- `KateTrackerManager: Atspi.init failed`
    at-spi2-core isn't running.
    `systemctl --user start at-spi-dbus-bus` and retry.

- `KateTrackerManager: discovery exhausted for pid <N> without finding an editor`
    Kate's AT-SPI tree has no `TEXT` role of sufficient size.
    Likely cause: Qt accessibility bridge is off, OR Kate was just
    launched and the tree wasn't built yet (we retry for ~14 s;
    beyond that we give up).

- `KateTrackerManager: editor found for pid <N> but baseline capture
  never succeeded`
    We see a `TEXT` accessible but `get_character_extents(0)` keeps
    returning garbage. This is the Qt/text-interface bug above; in
    practice it's a sign the editor's document is empty or its
    accessibility plugin is misbehaving. Open a non-empty file.

## Updating this matrix

When you test against a new Kate/Qt/KF6 combo, add a row above and
record the specific result. Don't delete rows unless the toolchain is
no longer reasonably reachable (e.g. a distro has EOL'd the version
entirely) — the history helps future-you narrow down when behavior
changed.
