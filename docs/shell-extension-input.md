# Phase 0: Shell layering and input model (filled)

This documents the **chosen** approach for `annotations@eochis23.github.io`. Re-validate on your GNOME Shell tag if behavior diverges.

## Layering (implemented)

| GNOME construct | Role |
|-----------------|------|
| `Main.uiGroup` | Public alias of `Main.layoutManager.uiGroup`. Child actors here paint **above** normal application windows (same band as shell OSD / chrome). |
| `Main.layoutManager.monitors` | Per-monitor layout state; we instead union `Meta.Display.get_monitor_geometry(i)` for all `i` in `[0, n_monitors)` to size one root `St.Widget`. |
| Root placement | One `St.Widget` at `(union.x, union.y)` with size `(union.width, union.height)` added to `Main.uiGroup`. |

**Z-order:** Above `window_group` content (typical apps). Shell panels and modal layers may still paint above us depending on version—acceptable for v1.

**Multi-monitor:** `monitors-changed` on `Meta.Display` recomputes the union rectangle and resizes the root + `Clutter.Canvas`.

## Input (implemented strategy)

**Constraint:** Clutter hit-testing does not offer “mouse through this fullscreen actor but tablet hits it” if both use the same pick path. `EVENT_PROPAGATE` from a top `uiGroup` actor does **not** deliver events to Wayland clients the way `gdk_surface_set_input_region` holes do.

**Chosen behavior:**

1. The overlay is **`reactive: true`** while visible so pen/tablet motion and pressure reach the drawing `Clutter.Canvas`.
2. **Only** events classified as **stylus/tablet** (see `lib/devices.js`) modify strokes. Mouse and touchpad clicks do not draw.
3. While the overlay is visible, **mouse input on the covered area is still captured by the overlay** (Clutter limitation). Users must **hide the overlay** to operate underlying windows. Hide via:
   - default shortcut **Super+Shift+A** (configurable in preferences), or
   - panel indicator menu **“Hide drawing layer”**.

**Device classification** (mirrors legacy GTK heuristics where possible):

- `Clutter.InputDeviceType.TABLET_TOOL` → stylus.
- Pointer device with **pressure axis** above a small threshold on press/motion → treat as stylus (covers “tablet as core pointer” routing).

**Eraser:** secondary button, middle button, or tool type when exposed by Clutter.

## Future work

- If Mutter/Shell ever exposes a supported “forward pointer to surface below” API from extensions, revisit true mouse-through without hiding overlay.
- Optional: split reactive dock + non-reactive canvas **if** tablet events are proven to reach a non-reactive actor on your hardware (Phase 0 spike on device—currently not assumed).

## Checklist (for QA on your machine)

- [ ] Pen draws with pressure width; mouse does not draw.
- [ ] Super+Shift+A toggles overlay; mouse works again when overlay hidden.
- [ ] Multi-monitor: geometry tracks `monitors-changed`.
- [ ] Lock/unlock session: extension disable/enable leaves no stray actors (manual test).
