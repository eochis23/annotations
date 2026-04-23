# Window-following annotations: implementation notes

This document describes the changes that added per-window ink to the
annotation compositor layer, so that pen strokes visually follow the window
they were drawn on (moves, resizes, minimize, workspace switch, stacking
changes) without re-rasterizing through animations. It also covers
overview pause and pen-pressure-sensitive stroke width.

The MVP is intentionally narrow: rectangular (frame-rect) occlusion only,
no animation handling, no persistence, and the whole annotation overlay is
hidden while the overview is showing.

## What changed, by file

### `mutter/src/compositor/meta-annotation-layer.h`

- `meta_annotation_layer_new` now takes a second parameter,
  `MetaDisplay *display`, so the layer can enumerate windows and subscribe
  to global stacking / workspace signals.
- New public setter `meta_annotation_layer_set_paused(layer, paused)` that
  hides or shows the overlay actor without touching `active`, pointer
  isolation, or chrome regions.

### `mutter/src/compositor/meta-annotation-layer.c`

Essentially rewritten. The single cairo surface became a small composite
model:

- `surface` - stage-sized composite surface. Rebuilt by `recompose()`;
  uploaded into the actor's `CoglTexture` by the existing
  `sync_texture_from_surface` path.
- `unattached_surface` - stage-sized surface catching strokes that started
  over no window (desktop).
- `per_window` - `GHashTable<MetaWindow*, WindowInk*>`, lazily populated
  the first time a window receives ink.

`WindowInk` owns a `cairo_surface_t` sized to the window's logical
`frame_rect` plus per-window signal handler ids (`position-changed`,
`size-changed`, `notify::minimized`, `workspace-changed`, `unmanaged`).
On `size-changed` the surface is reallocated with the existing pixels
blitted to the top-left (shrinks clip, grows show transparent).

Stroke state tracks the anchor window (or `NULL` for unattached), the last
segment endpoint in target-local coordinates, and the last known tablet
pressure.

#### Anchor pick

`pick_anchor_window(layer, x, y)` uses
`meta_display_list_all_windows` + `meta_display_sort_windows_by_stacking`
(reversed for top-down traversal). It skips:

- override-redirect windows (menus, tooltips, the dock),
- hidden and minimized windows,
- `META_WINDOW_DESKTOP` and `META_WINDOW_DOCK`,
- windows not on the active workspace unless they are sticky
  (`meta_window_is_on_all_workspaces`).

The first remaining window whose `meta_window_get_frame_rect` contains
the point wins. No hit returns `NULL` and strokes fall back to
`unattached_surface`.

#### Event handling

`meta_annotation_layer_handle_event` now routes through three helpers:

- `begin_stroke`  picks the anchor, ensures its `WindowInk`, converts
  stage coords to target-local, records the starting pressure.
- `continue_stroke` converts the current point, calls `draw_segment` on
  the target surface, schedules a recompose.
- `end_stroke` clears the anchor and schedules a recompose.

Button-press, button-release, touch-begin/update/end/cancel, and pointer
motion all map onto these helpers. Pen and touch flow through the same
path; only pressure handling differs (see below).

#### Recompose

`recompose()` runs on a coalesced `g_idle_add`. Its flow:

1. Clear the composite `surface`.
2. Walk `meta_display_list_all_windows` sorted by stacking, keeping only
   eligible, non-minimized, non-zero-size windows.
3. For each kept window, compute its visible rectangular region as
   `frame_rect - union_of_higher_frame_rects` using `cairo_region_t`.
4. Paint `unattached_surface` clipped to
   `stage_rect - union_of_all_visible_frame_rects`.
5. Paint each window's `WindowInk->surface` at `(fr.x, fr.y)` clipped to
   its visible region.
6. Flush and do a single `sync_texture_from_surface` to upload to the
   actor texture.

Only rectangular frame-rect occlusion is done; shaped windows and
per-pixel transparency are out of scope for the MVP.

Global signals wired by the layer itself:

- `MetaDisplay::restacked` -> schedule recompose (raise/lower).
- `MetaWorkspaceManager::active-workspace-changed` -> schedule recompose.
- Stage `notify::width` / `notify::height` -> reallocate stage-sized
  buffers and schedule recompose.

#### Pause for overview

`meta_annotation_layer_set_paused(layer, paused)` flips an internal bit
and hides / shows the actor via `update_actor_visibility`. Pointer
isolation, active state, and chrome regions are untouched, so dragging a
pen across the overview doesn't accidentally move the cursor and the
exact same dock is ready the moment the overview closes.

#### Pressure-sensitive ink

Pressure is read from `clutter_event_get_axes` with
`CLUTTER_INPUT_AXIS_PRESSURE`, but only trusted when
`clutter_event_get_device_tool(event)` is non-NULL (real tablet stylus).
Mouse button strokes and non-pressure touch fall back to a cached
`last_pressure` which starts at `1.0`, so they render at full width.

- Effective width is `ANNOT_BASE_WIDTH * sqrt(clamp(p, 0.1, 1.0))`
  (`ANNOT_BASE_WIDTH = 6.0f`). The square-root gamma keeps light taps
  readable.
- `draw_segment` now takes `(p1, p2)`. For real strokes it fills a
  trapezoid whose short edges are `2 * half_width * normal` at each
  endpoint plus two circular caps at `(x1, y1)` and `(x2, y2)` so
  consecutive segments join smoothly and zero-length taps render as a
  round dot.
- Pressure is baked into pixels on the per-window cairo surface - we do
  not store a stroke-point history. Future persistence features would
  have to add one.

### `mutter/src/core/meta-annotation-dbus.c`

Added a `SetPaused(b)` method to the `org.gnome.Mutter.Annotation` D-Bus
interface, both in the introspection XML and in `handle_method_call`,
forwarding to `meta_annotation_layer_set_paused`.

### `mutter/src/compositor/compositor.c`

`meta_compositor_real_manage` now passes the `MetaDisplay` into
`meta_annotation_layer_new`. No change to the chrome-region /
RegionActivated routing.

### `annotations-shell-extension/extension.js`

- `Main.overview::showing` now calls `SetPaused(true)` in addition to the
  existing dock-hide and `ClearChromeRegions`.
- `Main.overview::hidden` calls `SetPaused(false)` in addition to the
  dock re-show and chrome republish.
- If the overview is already visible at `enable()` time, we fire
  `SetPaused(true)` immediately.

## Behavior summary

- Drawing a stroke over window W attaches the stroke to W. Moving,
  resizing, or restacking W causes the ink to move, resize-clip, or be
  reoccluded on the very next idle tick.
- Strokes over the desktop (or over the dock, since the dock is an
  override-redirect overlay) land on `unattached_surface` and stay stage-
  anchored.
- Minimizing or switching away from W hides its ink; restoring it brings
  the ink back untouched.
- Closing W destroys the `WindowInk` and its strokes. There is no
  persistence.
- Entering the overview fully hides the annotation overlay; exiting
  shows it again with all ink intact.
- Pen pressure modulates line width with a square-root response curve;
  mouse and non-pressure-touch strokes are full width.

## Known limitations / out of scope

- Rectangular occlusion only. Shaped and rounded-corner windows will
  leak ink into their "transparent" corners.
- No animation handling. Minimize / maximize / workspace transitions
  snap ink on signal completion rather than following the animation.
- No stretch-on-resize. A window that doubles in size keeps the ink at
  its original position and clips on the new bounds.
- No overview preview painting. Overview thumbnails do not render ink.
- One stroke in flight globally; multi-seat concurrent strokes are not
  modeled.
- No tilt / rotation / barrel-pressure; only `CLUTTER_INPUT_AXIS_PRESSURE`
  is consumed.
- Per-device pressure calibration is a fixed `[0.1, 1.0]` clamp with a
  hard-coded `sqrt` gamma and `BASE_WIDTH = 6.0` logical px.
