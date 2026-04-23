# Review: window-following annotations

Scope: the changes described in `window-following-changes.md` and implemented
across `mutter/src/compositor/meta-annotation-layer.{c,h}`,
`mutter/src/compositor/compositor.c`, `mutter/src/core/meta-annotation-dbus.c`,
and `annotations-shell-extension/extension.js`.

Below is an ordered list of defects and risks, worst first. Line numbers
refer to the post-change files (what `git diff` shows as the "M" version).

---

## 1. Pause bit leaks across extension disable / re-enable

Severity: high (causes "ink doesn't appear anymore, have to reboot" class of
bug).

In `annotations-shell-extension/extension.js`:

- `enable()` only sends `SetPaused(true)` when `Main.overview.visible` at
  enable time. It never explicitly sends `SetPaused(false)`.
- `disable()` does not send `SetPaused(false)` at all.

Mutter's `paused` bit is process-lifetime; it is not reset between extension
cycles. So:

1. User opens overview while the extension is enabled → Mutter paused=true.
2. User disables the extension (e.g. via Extensions app) while overview is
   up. `disable()` sends `SetActive(false)` but leaves paused=true.
3. User closes overview. Nothing resends `SetPaused(false)` because no
   extension-owned `overview::hidden` handler exists anymore.
4. User re-enables extension with overview closed. `enable()` skips the
   `SetPaused(true)` branch, but also never sends `SetPaused(false)`.
5. `SetActive(true)` runs, but `update_actor_visibility` requires
   `active && !paused`, so the actor stays hidden. The user sees nothing.

Fix options:

- `enable()`: always `SetPaused(Main.overview.visible)` (not just when
  visible).
- `disable()`: `SetPaused(false)` before (or after) `SetActive(false)`.

Either fix alone closes the hole; doing both is safest because the current
code also has no safeguard for the case where mutter is restarted between
enables.

---

## 2. Ink accumulates invisibly while overview is showing

Severity: medium-high (surprising UX; hidden strokes reappear when overview
closes).

`meta_annotation_layer_handle_event` gates on `layer->active` and
`layer->surface` but not on `layer->paused`:

```1099:1100:mutter/src/compositor/meta-annotation-layer.c
  if (!layer->active || !layer->surface)
    return FALSE;
```

The document (section "Pause for overview") says the actor is hidden while
paused but "Pointer isolation, active state, and chrome regions are
untouched". Combined with the fact that the stage still delivers events to
the annotation input path, this means a user who keeps stroking with the
stylus while the overview is open will silently paint onto the matching
windows' `WindowInk` surfaces. On `SetPaused(false)`, the next recompose
draws all of that ink.

Pointer isolation does not save us, because the stylus *is* a non-mouse
pointer and therefore still isolated — the strokes don't drive the cursor
but they *are* delivered to the annotation layer for drawing.

Fix: early return `FALSE` from `meta_annotation_layer_handle_event` when
`layer->paused`, and also call `end_stroke(layer)` from
`meta_annotation_layer_set_paused` when transitioning to paused so any
in-flight stroke is cleanly terminated (otherwise the stroke will see its
stage coordinates continue to update the "last" point in the wrong frame of
reference while paused, depending on the above fix ordering).

---

## 3. `last_pressure` carries across input sources

Severity: medium (contradicts documented behavior, visible to users).

Document, section "Pressure-sensitive ink":

> Mouse button strokes and non-pressure touch fall back to a cached
> `last_pressure` which starts at `1.0`, so they render at full width.

Actual behavior: `last_pressure` is initialized to `1.0f` in
`meta_annotation_layer_new`, but it is then mutated by every pressure-known
event in `begin_stroke` and `continue_stroke`. It is **never reset**. So:

1. User draws with a tablet stylus. Last segment ends with pressure, say,
   `0.22`. `last_pressure` is now `0.22`.
2. User switches to a mouse. Mouse events have `pressure_known == FALSE`.
3. In `continue_stroke`, `p_end = pressure_known ? pressure :
   layer->last_pressure;` → `p_end = 0.22`. The mouse stroke renders
   at `BASE * sqrt(0.22) ≈ 47%` of full width, not full width.

Same problem applies to non-pressure touch after a stylus session.

Fix: reset `last_pressure = 1.0f` whenever we enter a stroke without a known
pressure (i.e. in `begin_stroke` when `!pressure_known`), or whenever a
motion event without a tool is seen. The simpler patch:

```c
if (pressure_known)
  layer->last_pressure = pressure;
else
  layer->last_pressure = 1.0f;
```

in both `begin_stroke` and `continue_stroke`.

---

## 4. `g_signal_connect_object (stage, ..., layer, ...)` is a no-op

Severity: medium (silently broken behavior on monitor/stage resize).

Note: this is **pre-existing**, not introduced by the window-following
patch. But the bug interacts badly with the new per-window surfaces, so
it is worth fixing while we're here.

```727:733:mutter/src/compositor/meta-annotation-layer.c
  layer->width_notify_id =
    g_signal_connect_object (stage, "notify::width",
                             G_CALLBACK (on_stage_size_changed),
                             layer, G_CONNECT_DEFAULT);
  layer->height_notify_id =
    g_signal_connect_object (stage, "notify::height",
                             G_CALLBACK (on_stage_size_changed),
                             layer, G_CONNECT_DEFAULT);
```

`g_signal_connect_object`'s fourth argument must be a `GObject`.
`MetaAnnotationLayer` is a plain `g_new0`'d C struct (see the struct
definition at lines 42–81 of the file). GLib enforces this with
`g_return_val_if_fail (G_IS_OBJECT (gobject), 0)`; the call returns `0` and
prints a `g_critical` to the journal.

Consequences:

- The handler ID is `0`, so `g_clear_signal_handler` in `_destroy` is a
  no-op — no leak, but also no unregistration is ever needed because the
  handler was never registered.
- Stage size changes (e.g. hot-plug a monitor, change resolution, undock a
  laptop) are **never delivered**. `layer->stage_width/height` stay at the
  values captured by the one explicit call to `on_stage_size_changed` at
  init time. The composite surface and unattached surface keep their old
  size.
- With the new per-window surfaces, this means that a user who hot-plugs
  a monitor, moves a window to the new monitor, and strokes on it will
  see ink correctly on the per-window surface, but the recompose clip
  rectangle `{0, 0, stage_width, stage_height}` truncates anything on
  the newly-added area of the stage.

Fix: use `g_signal_connect` + explicit `g_clear_signal_handler` in
`_destroy` (the destroy code already handles this shape), or rework the
layer to be a `GObject` subclass.

---

## 5. `pick_anchor_window` allocates and sorts per event, not per idle

Severity: medium (performance; not correctness).

Every `CLUTTER_MOTION` with the draw button held calls `continue_stroke`,
which is fine — the hot path doesn't re-pick. But `CLUTTER_BUTTON_PRESS`,
`CLUTTER_TOUCH_BEGIN`, and the motion-starts-stroke path in
`meta_annotation_layer_handle_event` all call `pick_anchor_window`, which:

- calls `meta_display_list_all_windows` (allocates a new `GList`);
- copies it into a `GSList` via `g_slist_prepend` in a loop;
- calls `meta_display_sort_windows_by_stacking`, which internally
  `g_slist_copy` + `g_slist_sort`s;
- reverses the sorted list.

That's four list allocations + a sort for every stroke start. Not a
regression on its own, but worth caching (e.g. memoize the sorted list and
invalidate on `restacked` / `workspace-changed` / `size-changed` /
`position-changed`). This also affects `recompose()`, which does the same
dance on every idle.

---

## 6. `recompose()` runs even when the actor is hidden or paused

Severity: low (wasted CPU / texture upload bandwidth).

`schedule_recompose` is called from every signal handler regardless of
`active` or `paused`. The idle does a full stage-size Cairo composite, a
full texture upload via `cogl_texture_set_data`, and a
`clutter_content_invalidate` + `clutter_actor_queue_redraw`. When the actor
is hidden, all of that is thrown away.

Cheap fix: in `schedule_recompose`, bail if `!layer->active || layer->paused`,
and set a "dirty" flag. In `set_active`/`set_paused`, if transitioning to a
showing state and `dirty`, schedule a recompose.

---

## 7. `meta_annotation_layer_clear` runs `recompose` synchronously but
    doesn't cancel the already-scheduled idle

Severity: low.

```830:833:mutter/src/compositor/meta-annotation-layer.c
  layer->stroke_active = FALSE;
  layer->stroke_anchor = NULL;

  recompose (layer);
```

If `schedule_recompose` had queued an idle earlier, `recompose_idle_id` is
still non-zero when `_clear` returns. The idle will fire later and do a
second full recompose. Not a bug — just wasteful.

Fix: pair `recompose (layer)` with
`g_clear_handle_id (&layer->recompose_idle_id, g_source_remove)` (or call
`schedule_recompose` + let the idle dispatch the already-cleared state).

---

## 8. `stroke_anchor` isn't ref-counted

Severity: low today, fragile going forward.

`pick_anchor_window` returns a raw `MetaWindow *`. `begin_stroke` stores
that pointer in `layer->stroke_anchor` *before* calling
`ensure_window_ink`, which is what attaches the `unmanaged` handler.
Between those two lines, no GLib main-loop iteration happens, so no
signal can fire and the pointer can't dangle in practice.

However, the struct comment says:

```c
  MetaWindow *stroke_anchor;    /* NULL = targeting unattached_surface */
```

with no liveness contract. If a future refactor moves `ensure_window_ink`
out of `begin_stroke`, or introduces an async hop between picking and
ensuring (e.g. a portal-style confirmation), the invariant breaks silently
and we get a use-after-free in `stroke_target_surface` /
`convert_stage_to_local`.

Fix: either `g_object_add_weak_pointer (G_OBJECT (anchor),
(gpointer *) &layer->stroke_anchor)` at begin and `remove_weak_pointer` at
end, or make the "anchor" a reference to the owning `WindowInk *` (which
is explicitly destroyed on `unmanaged`, and is already tracked in
`per_window`).

---

## 9. Stroke after anchor window is unmanaged mid-stroke is subtly wrong

Severity: low (minor visual glitch, not a crash).

`on_window_unmanaged` handles the case where `stroke_anchor == win`:

```476:480:mutter/src/compositor/meta-annotation-layer.c
  if (layer->stroke_anchor == win)
    {
      layer->stroke_anchor = NULL;
      layer->stroke_active = FALSE;
    }
```

Good for safety. But there's a subtle issue: if the window is unmanaged
but the user is still holding the button down, the next motion event will
see `stroke_active == FALSE` and `btn == TRUE`, which calls `begin_stroke`
again, which calls `pick_anchor_window` for the new position. That's
actually the correct behavior ("roll off the dying window, start a new
stroke under the pointer") — worth a comment so future readers don't
"simplify" it.

---

## 10. `workspace-changed` on windows-on-all-workspaces is never delivered

Severity: low (edge case).

`on_window_workspace_changed` is attached per-window in `ensure_window_ink`.
For a window that is on-all-workspaces, moving between workspaces does not
emit `workspace-changed` on that window; instead the
`active-workspace-changed` signal on the workspace manager fires. The code
already handles that via `on_active_workspace_changed`, so this is fine —
but note that the document's bullet "Minimizing or switching away from W
hides its ink; restoring it brings the ink back untouched" is only true
because of the workspace-manager subscription, not the per-window
`workspace-changed` one. Consider dropping `workspace-changed` entirely,
since `active-workspace-changed` + `notify::minimized` cover all cases:

- W is on active ws: visible; `active-workspace-changed` flips it off.
- W is on all workspaces: always visible; no event needed.
- W is moved to a different workspace: that's a `workspace-changed` on W,
  but it also flips the result of `meta_window_located_on_workspace`. Keep
  the handler for this case.

So actually `workspace-changed` is needed for user-initiated
"move to workspace N" actions on pinned windows. Leave it, but add a
comment explaining why.

---

## 11. `recompose` doesn't short-circuit on `paused`

Severity: low (subset of issue #6).

`if (!layer->surface || !layer->display) return;` is the only guard. Worth
adding `|| layer->paused` since the upload is invisible anyway.

---

## 12. Cap overdraw causes a visible "bead" with semi-transparent ink

Severity: cosmetic.

`draw_segment` uses `CAIRO_OPERATOR_OVER` to draw:

1. a filled trapezoid,
2. a cap arc at `(x1, y1)`,
3. a cap arc at `(x2, y2)`.

With `rgba[3] == 1.0`, each pixel is fully opaque and double-painting is
invisible. With `rgba[3] < 1.0`, the two caps overdraw the trapezoid ends,
making them darker than the stroke body (`1 - (1-a)^2` vs `a`). Since
`meta_annotation_layer_set_color` exposes `a`, this can bite.

Fix: build a single filled path (trapezoid with caps), or use
`cairo_set_operator (cr, CAIRO_OPERATOR_OVER)` on an intermediate group
surface and paint the group with `cairo_paint_with_alpha`.

---

## 13. Full-stage texture upload per motion event

Severity: perf, not correctness.

Every `continue_stroke` schedules a recompose that rebuilds the composite
surface (`stage_width × stage_height × 4 bytes`) and uploads the whole
thing. On a 4K stage that's ~33 MiB per motion event at the idle tick
cadence. The existing per-window surfaces already track where ink lives,
so a future optimization could:

- recompose only the bounding box of damage, or
- upload a sub-rect via `cogl_texture_set_region`.

Not a launch blocker but worth noting for the follow-up document.

---

## 14. No handling of window `position-changed` during a stroke-in-flight

Severity: low (minor visual).

If the user drags a window while simultaneously holding the stylus button
and moving it (e.g. by accident on a multi-tool tablet), the anchor
window's `frame_rect` changes while `continue_stroke` is converting stage
coords to local. Because the conversion uses the *current* `frame_rect`,
the stroke point jumps to the new window-local offset, and the segment
from the previous (old-local) to current (new-local) cuts across the
window. `stroke_last_x/y` is not rebased on `position-changed`.

Fix (if we care): in `on_window_position_changed`, if the anchor is this
window, recompute `stroke_last_x/y` relative to the new position. In
practice, pen + drag isn't something users do, so this can be deferred.

---

## 15. `visible_windows` and `rects` built but could be a single struct

Severity: style.

`recompose()` carries two parallel arrays (`g_ptr_array` of windows,
`g_array` of rects). Indexing bugs in parallel-array code are a common
source of defects. A single `GArray` of `{MetaWindow *, MtkRectangle}`
structs is simpler and cheaper. Not a correctness issue today, but flags a
refactor opportunity.

---

## 16. `meta_annotation_layer_destroy` order vs. pending idle

Severity: low.

`_destroy` removes `recompose_idle_id` first, then unrefs `per_window`,
then destroys `surface` and the actor. Correct order — a pending idle that
had fired between `if (layer->recompose_idle_id)` and `g_source_remove` is
impossible on the main loop. Good.

But: `_destroy` never calls `g_source_remove` on the idle returned by
`g_idle_add`; it just resets the integer. The code does call
`g_source_remove` via the `if` block:

```767:771:mutter/src/compositor/meta-annotation-layer.c
  if (layer->recompose_idle_id)
    {
      g_source_remove (layer->recompose_idle_id);
      layer->recompose_idle_id = 0;
    }
```

Fine, just noting for completeness.

---

## 17. Extension: `SetPaused` is fire-and-forget

Severity: trivial / stylistic.

```c
dbusCall('SetPaused', new GLib.Variant('(b)', [true]), null);
```

The null callback means if the D-Bus call fails (e.g. compositor not
running annotation service), the failure is silently swallowed. The
existing `SetActive`/`ClearChromeRegions` also use this pattern, so it's
consistent, but worth being aware that there is no retry logic on
`SetPaused` failures — unlike `SetActive`, which has a retry scheduler.
For paused, a missed message means the user draws on top of the overview
thumbnails until the next transition. Consider a single retry.

---

## Summary of recommended fixes before merge

Must-fix (user-visible correctness):

- #1 Extension: send `SetPaused` on `enable()` and `disable()` based on
  current overview state (close the "invisible overlay after disable"
  trap).
- #2 Mutter: treat `paused` as a no-draw gate in
  `meta_annotation_layer_handle_event` and end any in-flight stroke on
  transition to paused.
- #3 Mutter: reset `last_pressure` to `1.0f` when beginning a stroke
  without known pressure (or whenever a non-tool motion is seen).

Should-fix (pre-existing but trivially adjacent):

- #4 Replace `g_signal_connect_object` with `g_signal_connect` for stage
  width/height notifies.
- #6/#11 Skip recompose when not visible; set a dirty flag and recompose
  on next show.

Nice-to-have:

- #5 Cache the sorted window list between `restacked` events.
- #13 Partial texture upload for motion events.
- #12 Fix cap overdraw bead.
- #15 Merge parallel arrays in `recompose`.

Nothing I looked at appears to cause an outright crash on the happy path,
but items #1 and #3 are definitely going to show up as user-reported bugs
within the first day of use.

---

# Follow-up review: after the fix pass

The fixes landed as six targeted patches covering all three must-fix items
(#1–#3), both should-fix items (#4, #6/#11), and two of the nice-to-haves
(#7 "cancel pending idle in clear", #8 "weak-ref stroke_anchor"). A walk
through the new code:

- #1 Extension: `enable()` now calls `_setPaused(Main.overview.visible)`
  unconditionally; `disable()` sends `SetPaused(false)` before
  `SetActive(false)` and cancels any pending retry timer. Closes the
  "stuck-paused" trap. Good.
- #2 Mutter: `handle_event` now bails on `layer->paused`;
  `meta_annotation_layer_set_paused` ends the in-flight stroke on the
  FALSE→TRUE transition. Good.
- #3 Mutter: `begin_stroke` now does
  `layer->last_pressure = pressure_known ? pressure : 1.0f;`. Good.
- #4 Mutter: `g_signal_connect_object(stage, ..., layer, ...)` replaced
  with `g_signal_connect`, with a comment explaining why. Paired
  `g_clear_signal_handler` in `_destroy` already existed. Good.
- #6/#11 Mutter: `schedule_recompose` and `recompose` both early-return
  with `recompose_dirty = TRUE` when `!active || paused`;
  `update_actor_visibility` schedules a catch-up recompose on the
  hidden→shown transition. Good.
- #7 Mutter: `meta_annotation_layer_clear` now does
  `g_clear_handle_id (&layer->recompose_idle_id, g_source_remove)` before
  its synchronous `recompose`. Good.
- #8 Mutter: new `set_stroke_anchor` helper attaches/detaches a
  `g_object_add_weak_pointer` around all `stroke_anchor` writes;
  `_destroy` clears the anchor before tearing down `per_window`. Good.

The fixes are clean, localized, and preserve the existing control flow.
Below are problems introduced or left unaddressed by the fix pass.

---

## F1. Extension `_setPaused` does not cancel its retry timer on success (critical)

Severity: high — re-introduces the exact class of bug #1 was trying to
eliminate, just less often.

```131:154:annotations-shell-extension/extension.js
    _setPaused(paused) {
        ...
        const variant = new GLib.Variant('(b)', [paused]);
        dbusCall('SetPaused', variant, err => {
            if (!err)
                return;
            if (!this._dock)
                return;
            this._setPausedRetryId = removeSource(this._setPausedRetryId);
            this._setPausedRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                ...
                dbusCall('SetPaused', new GLib.Variant('(b)', [paused]), ...);
                ...
            });
        });
    }
```

The retry is only scheduled on failure, and is only cancelled by a
*subsequent failure*, by `disable()`, or by the 300 ms timeout firing.
Successful `_setPaused(newValue)` calls never touch `_setPausedRetryId`.

Concrete sequence that bites:

1. `t = 0`: overview opens → `_setPaused(true)` → bus name not yet owned,
   `dbusCall` fails → retry scheduled for `t = 300` carrying `paused=true`
   in its closure.
2. `t = 100`: overview closes → `_setPaused(false)` → bus is now up,
   succeeds. The `if (!err) return;` branch does **not** clear the
   pending retry.
3. `t = 300`: retry fires, resends `SetPaused(true)`. Mutter goes paused
   with overview closed. Actor is hidden, user stares at nothing, thinks
   the extension broke.

Minimum fix: call `this._setPausedRetryId = removeSource(this._setPausedRetryId);`
unconditionally at the top of `_setPaused`, before issuing the new D-Bus
call. Each new intent supersedes any earlier intent that hadn't committed
yet.

Ideal fix: track a monotonic "paused target" epoch and let the retry's
callback bail if the epoch no longer matches, so a retry for an
already-superseded value never lands even in weird reorderings.

---

## F2. Stale ink may flash on overview close

Severity: low (one-frame visual glitch).

`meta_annotation_layer_set_paused(FALSE)` → `update_actor_visibility` →
`clutter_actor_show` → `schedule_recompose` (if dirty). The idle fires
at the next main-loop iteration, not before the frame that re-shows the
actor. The actor therefore briefly displays whatever was last uploaded
into the Cogl texture before pause, which may include:

- ink that was present at pause time, in now-stale window positions if
  any were moved during the overview, **or**
- if `meta_annotation_layer_clear` ran while paused (e.g. the user hit
  the clear button in the overview via some other path), a composite
  that was never re-uploaded post-clear, so the *old pre-clear* pixels
  show until the scheduled idle runs.

Both cases resolve within one idle tick, but the blink is visible at 60
Hz. If the clear-during-paused path matters, simplest fix is to replace
`schedule_recompose (layer)` with `recompose (layer)` inside
`update_actor_visibility` when `recompose_dirty` is set — pay one
synchronous composite at pause-exit time in exchange for a clean frame.

---

## F3. `pressure_known` but `pressure == 0.0` edge case in `begin_stroke`

Severity: low (cosmetic, unintended minimum-width stroke).

Fix #3 resets `last_pressure` to 1.0 only when `!pressure_known`:

```1124:mutter/src/compositor/meta-annotation-layer.c
  layer->last_pressure = pressure_known ? pressure : 1.0f;
```

But a stylus with a pen-button-press event at zero pressure (hover-click
with button) is `pressure_known=TRUE, pressure=0.0`. That is kept as-is
and clamped to `ANNOT_MIN_PRESSURE = 0.1f` by
`pressure_to_width_multiplier`, so the first segment renders at
`BASE * sqrt(0.1) ≈ 1.9 px`. Probably not what the user expects from a
pen-button click — they'd either expect no stroke (hover) or full width
(click). Two cheap fixes:

- Reject begin with `pressure_known && pressure == 0.0` in the
  `CLUTTER_BUTTON_PRESS` handler (treat it like hover).
- Or, in `begin_stroke`, treat `pressure_known && pressure <= 0.0` the
  same as `!pressure_known` (fall back to 1.0).

The motion handler already guards against this via
`pressure_tip = pressure_known && pressure > 0.0f`, so the asymmetry is
new and specifically affects button-press-at-zero-pressure events.

---

## F4. Weak-pointer ordering vs. `window_ink_free` assumes unmanaged-before-finalize

Severity: low (defensive note).

`set_stroke_anchor` adds `g_object_add_weak_pointer` on the window. The
weak pointer fires during `dispose`, before `finalize`. In Mutter's
current flow, `unmanaged` is emitted before the last unref, so
`on_window_unmanaged` always sees a live window and disconnects its
signals via `window_ink_free` before the object is disposed. The new
weak pointer is therefore only belt-and-braces, as the struct comment
says, and the real guarantee remains "unmanaged fires first".

If a future refactor inside mutter emits `unmanaged` inside `dispose`
(or skips `unmanaged` for some edge-case window death path), the weak
pointer would correctly null `stroke_anchor`, but `window_ink_free`
would be invoked out of the hash table destructor at layer-destroy time
with `ink->window` pointing at a freed object, and the
`g_clear_signal_handler` calls there would crash.

Not a bug today. Worth a one-line comment in `window_ink_free` noting
that it relies on `unmanaged` having run first, or switching
`ink->window` itself to a weak pointer for full defensive depth. Either
way, the `set_stroke_anchor` weak-pointer fix has closed the main
stroke-path hole.

---

## F5. `recompose_dirty` can remain set across a clear

Severity: very low (cosmetic, ink correctly clears on resume).

When `meta_annotation_layer_clear` runs while paused:

```876:883:mutter/src/compositor/meta-annotation-layer.c
  layer->stroke_active = FALSE;
  set_stroke_anchor (layer, NULL);

  g_clear_handle_id (&layer->recompose_idle_id, g_source_remove);
  recompose (layer);
```

Per-window surfaces and `unattached_surface` are cleared, pending idle
is cancelled, then `recompose` is called — but `recompose` early-returns
on `!active || paused`, setting `recompose_dirty = TRUE`. That's
correct: on resume, `update_actor_visibility` will catch up. However:

- The composite `layer->surface` still holds pre-clear pixels after
  `_clear` returns (since the early-return skips the initial
  `surface_clear`). This matters because the `CoglTexture` also still
  holds pre-clear pixels. If a code path anywhere in Mutter sneaks a
  peek at the composite between clear-while-paused and unpause, it sees
  the wrong thing. Today nothing does, so this is latent.

If we wanted airtight semantics, `meta_annotation_layer_clear` could
unconditionally `surface_clear(layer->surface)` before the
early-returning `recompose` call, and skip the texture upload when
paused. Optional.

---

## F6. Re-entrance on `recompose` during recompose

Severity: low (not worse than before, but worth knowing).

`recompose` calls `cogl_texture_set_data` and
`clutter_content_invalidate` / `clutter_actor_queue_redraw`. Any of
those can indirectly trigger a stage layout which could fire
`notify::width` or `notify::height`, which calls `on_stage_size_changed`
→ `recreate_buffers`, which replaces the composite surface and the
Cogl texture under our feet.

The existing `sync_texture_from_surface` takes a ref on the texture for
the duration of the upload, which defends that one call. But
`recompose` takes no ref on `layer->surface`, and the cairo writes a few
lines earlier would crash if the surface were swapped mid-function.

This is a pre-existing concern and is not introduced by the fixes.
Calling it out because #6/#11 made `schedule_recompose` more dynamic
(idle may be debounced or rescheduled) which slightly increases the
chance of weird ordering. A safe-ish mitigation: take a local
`cairo_surface_reference (layer->surface)` at the top of `recompose` and
`cairo_surface_destroy` at the end.

---

## F7. Unaddressed items from the original review

Not regressions, just noting they are still open:

- #5 (pick_anchor_window / recompose re-enumerate windows per call) —
  perf only.
- #9 (workspace-changed handler on pinned windows) — documented as
  needed; no fix needed, comment in the code would help future readers.
- #12 (cap overdraw darkening at alpha < 1) — still present.
- #13 (full-stage texture upload per motion event) — still present.
- #15 (parallel arrays in `recompose`) — still present.

---

## Verdict

All three must-fixes are correctly implemented on the Mutter side. Two
should-fixes (#4, #6/#11) and two of the nice-to-haves (#7, #8) were
taken. On the extension side, the `_setPaused` helper's retry logic
(F1 above) reintroduces a visible misordering bug that should be
patched before shipping. F2 is a one-frame blink at pause-exit that is
worth fixing if polish matters; F3 is a minor cosmetic edge case for
pen-button clicks. F4–F6 are defensive notes, not active defects.

Overall the fix pass closes the reported issues cleanly; the only new
defect I can point at is F1, and it's a two-line fix.

---

# Second follow-up review: after the F1–F6 fix pass

The second round took aim at F1–F6 and landed a clean patch for each.
Summary:

- **F1** (extension stale retry): `_setPaused` now cancels
  `_setPausedRetryId` unconditionally at entry, bumps a monotonic
  `_setPausedEpoch`, captures it in the `dbusCall` error closure and in
  the 300 ms retry timer, and both closures bail when the epoch no
  longer matches. This closes the "late retry clobbers a newer
  successful send" race cleanly.
- **F2** (one-frame stale blink on unpause): `update_actor_visibility`
  now calls `recompose (layer)` synchronously (after cancelling any
  queued idle) before `clutter_actor_show`, so the first visible frame
  after unpause is always fresh.
- **F3** (pressure==0 at begin): `begin_stroke` now falls back to
  `last_pressure = 1.0f` when `!pressure_known || pressure <= 0.0f`.
- **F4** (window-ink ordering assumption): added a comment in
  `window_ink_free` documenting the "unmanaged fires before finalize"
  invariant and what would need to change if mutter ever broke it.
- **F5** (clear-while-paused leaving pre-clear pixels in the composite):
  `meta_annotation_layer_clear` now also calls
  `surface_clear (layer->surface)` on the composite.
- **F6** (re-entrance during `recompose` replacing the surface):
  `recompose` now takes `cairo_surface_reference (layer->surface)` at
  the top, does all cairo writes into that local, and skips the texture
  upload (setting `recompose_dirty = TRUE`) if `layer->surface` was
  swapped mid-function.

Below are the problems I found in this pass.

---

## G1. F3 is asymmetric: `continue_stroke` still draws thin at `pressure_known && pressure == 0`

Severity: low (cosmetic, affects pen-barrel-button drags while hovering).

`begin_stroke` was updated to treat a known-but-zero pressure the same
as "no pressure":

```1151:1161:mutter/src/compositor/meta-annotation-layer.c
  /* Reset on unknown pressure so mouse / non-pressure touch after a
   * low-pressure stylus session renders at full width. ...
   * Also treat pressure==0 (e.g. a pen-button press while hovering) as
   * unknown; rendering such an event at MIN_PRESSURE would produce a
   * ~1.9px stroke that the user didn't ask for. */
  layer->last_pressure =
    (pressure_known && pressure > 0.0f) ? pressure : 1.0f;
```

`continue_stroke` was not given the same treatment:

```1137:continue_stroke
  p_end = pressure_known ? pressure : layer->last_pressure;
```

Concrete failure path (reproducible on a Wacom with barrel button):

1. Stylus hovers over a window. `clutter_event_get_device_tool != NULL`,
   pressure axis = 0.
2. User presses the barrel button without tip contact. `BUTTON_PRESS`
   arrives with `btn != PRIMARY`; `tool != NULL` allows begin_stroke to
   run. `pressure_known = TRUE`, `pressure = 0.0`. F3 maps that to
   `last_pressure = 1.0`. First segment (if any) begins at 1.0.
3. User drags with barrel button held, still hovering.
   `CLUTTER_MOTION` events arrive at `pressure = 0.0`. `stroke_active`
   is TRUE, so the handler calls `continue_stroke` with
   `pressure_known=TRUE, pressure=0.0`. `p_end = pressure` → `0.0`. The
   segment is drawn with `p1 = last_pressure` (which was 1.0 after
   begin, but after this segment gets set to `p_end = 0.0`) and
   `p2 = 0.0` → clamped to MIN → sqrt(0.1) → ~1.9 px.
4. From the second motion onward, both p1 and p2 are 0.0, rendering a
   uniform ~1.9 px line until the user releases the barrel button.

The user sees a normal-width starting dot, a taper to thin, then a thin
line. Not the "no-stroke while hovering" or "full-width fallback" the
F3 comment implies.

Symmetric fix: apply the same predicate in `continue_stroke`:

```c
p_end = (pressure_known && pressure > 0.0f) ? pressure : layer->last_pressure;
```

And also update the line that stores it:

```c
layer->last_pressure = p_end;
```

stays as-is; what changes is that a lift-off mid-stroke no longer
decays `last_pressure` to 0, and subsequent zero-pressure motions fall
back to the last known real pressure instead of clamping to MIN.

An alternative, more conservative policy is to not draw segments at all
when `pressure_known && pressure == 0` after begin (treat hover as
lift-off). Whichever policy is chosen should apply in both
`begin_stroke` and `continue_stroke`; right now they disagree.

---

## G2. Synchronous `recompose` inside `update_actor_visibility` — cost and re-entrance

Severity: low (observation, not a bug).

F2 replaced `schedule_recompose` with a synchronous `recompose` call in
the "becoming visible" branch of `update_actor_visibility`. Two
consequences worth calling out:

1. **Cost on hot paths.** `update_actor_visibility` is called from
   `meta_annotation_layer_set_active` and `set_paused`. Both come from
   D-Bus method calls on the compositor thread. A synchronous recompose
   does a cleared stage-size Cairo composite (~stage_w*stage_h*4 bytes)
   plus a `cogl_texture_set_data` upload. On a 4K stage that's ~33 MiB
   of writes per toggle. Acceptable for interactive toggle rates, but
   if anything ever drives `SetActive` or `SetPaused` at sub-second
   frequency (e.g. a debugging loop, a hook into
   `notify::monitors-changed`, or a future "flash the annotation
   briefly" feature), we'd want to re-introduce an idle here and
   tolerate the one-frame blink.

2. **Re-entrance window.** `recompose` calls
   `cogl_texture_set_data` and `clutter_actor_queue_redraw`; either of
   those can, in principle, run a stage validation pass that emits
   `notify::width` / `notify::height`, re-entering
   `on_stage_size_changed` → `recreate_buffers`. F6 defends the cairo
   writes, and the final `if (layer->surface == composite)` check
   guards the upload, so this path is safe. But the guard sets
   `recompose_dirty = TRUE` on mismatch and **does not schedule a
   fresh recompose itself** — it relies on `recreate_buffers` having
   called `schedule_recompose` already. Today that's correct, but the
   contract is now "every code path that replaces `layer->surface`
   must also call `schedule_recompose`". Worth a one-line assertion or
   at minimum a comment on `layer->surface` declaration.

Neither is an active defect; flagging for the follow-up document.

---

## G3. `sync_texture_from_surface` is not pinned with the same reference as `recompose`

Severity: low (pre-existing, slightly more visible after F6).

F6 takes `cairo_surface_reference (layer->surface)` at the top of
`recompose` and uses `composite` for all cairo writes, then calls
`sync_texture_from_surface (layer)` after verifying
`layer->surface == composite`. The function it hands off to re-reads
`layer->surface`:

```165:183:mutter/src/compositor/meta-annotation-layer.c
  stride = cairo_image_surface_get_stride (layer->surface);
  data = cairo_image_surface_get_data (layer->surface);

  if (!cogl_texture_set_data (tex,
                              COGL_PIXEL_FORMAT_CAIRO_ARGB32_COMPAT,
                              stride,
                              data,
                              0,
                              NULL))
    ...
```

In the current main-thread-only world, nothing can swap `layer->surface`
between the `==` check at line 714 and the `get_data` at line 167, so
this is safe. But F6's defensive shape implies "distrust
`layer->surface` mid-function". For consistency, `sync_texture_from_surface`
should either accept a pinned `cairo_surface_t *` parameter or take its
own `cairo_surface_reference` at entry. Two-line tidy-up; no user-visible
bug today.

---

## G4. `disable()` path for `SetPaused(false)` bypasses the epoch retry

Severity: low (recovered-by-enable, worth tidying).

`disable()` still sends the "clear paused" message through the raw
helper:

```js
dbusCall('SetPaused', new GLib.Variant('(b)', [false]), null);
this._setPausedRetryId = removeSource(this._setPausedRetryId);
```

It **does not** go through `_setPaused(false)`. Consequences:

- If the D-Bus call fails (bus down, compositor mid-restart, etc.),
  nothing retries. Mutter retains `paused=true` across the extension's
  death.
- The next `enable()` calls `_setPaused(Main.overview.visible)`
  unconditionally, which *does* retry and recovers. So the hole is
  closed, but only because re-enable is the safety net.
- The epoch is not bumped here, so any in-flight `_setPaused(true)`
  callback that is still racing the disable could schedule a retry
  with `_dock` still non-null for a brief window. That retry's timer
  will check `this._dock`, which becomes NULL near the end of
  `disable()`, and bail — but the order of operations in `disable()`
  puts `this._dock = null` about 30 lines after the raw
  `dbusCall('SetPaused', false)`. A failing-callback from *before*
  disable can still schedule a retry in that window; the retry will
  eventually fire with `_dock === null` and bail. So functionally
  safe.

Cleanest fix: route through `_setPaused(false)` in `disable()` too
(the epoch bump + retry makes it identical in intent), and remove the
now-redundant manual `removeSource` line. Alternative: keep the raw
call but bump `_setPausedEpoch` manually to cancel any in-flight
callbacks' ability to schedule a retry.

---

## G5. `meta_annotation_layer_clear` now writes the composite while paused, but the CoglTexture still holds pre-clear pixels

Severity: very low (latent; invisible today).

F5 added `surface_clear (layer->surface)` to `_clear`. Good — the
cairo composite is now consistent immediately after the call. However,
`recompose` is then invoked, and because the layer is paused it
early-returns with `recompose_dirty = TRUE` **without** running
`sync_texture_from_surface`. The Cogl texture therefore still contains
pre-clear pixels until the unpause synchronous recompose runs and
uploads the cleared composite.

The actor is hidden, so nothing renders those pixels. But any
hypothetical code path that reads the Cogl texture (for debugging,
screenshot, overview preview, etc.) would see stale content between
clear-while-paused and unpause.

Fix if we want complete consistency: have `_clear` upload once even in
the paused case. A simpler alternative: call
`sync_texture_from_surface (layer)` unconditionally at the tail of
`_clear` after the synchronous `surface_clear`. Both add cost for a
case that doesn't currently matter, so this is purely a "future-proof
if we add overview preview" observation.

---

## G6. `recompose` early-return leaves `composite` unallocated; the guard is necessary and correctly ordered

Severity: none (confirmation of non-bug).

Reading F6 carefully: the `cairo_surface_reference (layer->surface)`
call happens *after* the `!active || paused` early-return. If the
function returned before that point, no reference is taken and no
`cairo_surface_destroy (composite)` runs. That ordering is correct.
Flagging only because a future refactor that hoists the reference
before the early-return (e.g. to also cover the paused-guarded path)
would need to pair it with an early `cairo_surface_destroy`.

---

## G7. Still-open items from prior reviews

Not touched this pass; all acceptable:

- #5 (window list re-enumerated per event / idle) — perf, stays.
- #9 (workspace-changed handler retention documented in text but not in
  code comment) — documentation stays verbal.
- #12 (alpha-cap darkening) — stays.
- #13 (full-stage texture upload per motion event) — stays.
- #15 (parallel arrays in `recompose`) — stays.

---

## Verdict

The F1–F6 fix pass is clean. The only substantive finding is **G1**:
F3's asymmetry between `begin_stroke` and `continue_stroke` means the
pen-barrel-button-during-hover case still renders a thin line after the
first segment, undercutting the fix's stated intent. A one-line change
in `continue_stroke` closes it.

G2–G6 are observations and defensive cleanups rather than defects.
Nothing in this pass introduces a regression; the extension
`_setPaused` is now correct under all realistic D-Bus error
sequences I can construct.
