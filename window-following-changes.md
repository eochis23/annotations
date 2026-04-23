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
model. After compositing window + unattached ink each frame, `recompose`
clears every currently-published chrome region rectangle from the
uploaded surface with `CAIRO_OPERATOR_CLEAR`, so ink can never appear
on top of the annotation dock (buttons, separator, padding, or the
dock-body region). `set_chrome_regions` / `clear_chrome_regions` now
schedule a recompose so the dock mask tracks the dock's geometry.

- `surface` - stage-sized composite surface. Rebuilt by `recompose()`;
  uploaded into the actor's `CoglTexture` by the existing
  `sync_texture_from_surface` path.
- `unattached_surface` - stage-sized surface catching strokes that started
  over no window (desktop).
- `per_window` - `GHashTable<MetaWindow*, WindowInk*>`, lazily populated
  the first time a window receives ink.

`WindowInk` owns a `cairo_surface_t` sized to the window's logical
`frame_rect`, a `GPtrArray *strokes` of vector `Stroke` objects (the
stored history used for object-erasing and for re-rasterization after
resize or deletion), and per-window signal handler ids
(`position-changed`, `size-changed`, `notify::minimized`,
`workspace-changed`, `unmanaged`). On `size-changed` the surface is
reallocated and its pixels are rebuilt from the stored strokes rather
than blitted from the old bitmap, so ink survives window resize within
the bounds of the stroke coordinates (anything outside the new frame
is naturally clipped by cairo).

The matching `unattached_strokes` list lives on the layer itself and
tracks strokes that landed over the desktop; on stage resize the
desktop surface is re-rasterized from those strokes for the same
reason.

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
- In addition to the raster feedback in the surface, every ink point
  is appended to the in-flight `Stroke` on the current target buffer
  (`WindowInk->strokes` or `unattached_strokes`). Storing the polyline
  turns erase into an object-level operation (see below) and lets
  resize / post-erase repaints regenerate pixels without loss.

#### Tilt-widened ink

In addition to pressure, `draw_segment` now takes a per-endpoint tilt
factor `>= 1` that scales the half-width. Tilt is read from
`CLUTTER_INPUT_AXIS_XTILT` / `CLUTTER_INPUT_AXIS_YTILT` (both in
degrees, libinput's native units), only for real tablet tools
(`clutter_event_get_device_tool` non-NULL). Magnitude is normalised by
`ANNOT_TILT_DEG_FULL = 60` and clamped to `[0, 1]`; the factor is
`1 + ANNOT_TILT_WIDTH_BOOST * magnitude` with `ANNOT_TILT_WIDTH_BOOST =
1.875` (bumped 25% stronger than the original 1.5 so the tilt effect
is more visible), i.e. a vertical pen is unchanged and a fully tilted
pen is up to ~2.875x wider. The factor multiplies into the existing
pressure-based width, is cached between events as `last_tilt_factor`,
and renders through the existing trapezoid + circular-cap geometry -
no directional nib; the effect is an isotropic widening reminiscent
of pressing the side of a marker onto the paper.

#### Tap-to-clear gestures

Per the non-mouse-only routing on this layer, every press/release pair
is a tap candidate. A tap is recorded when:

- `press -> release` duration `<= TAP_MAX_DURATION_US = 300 ms`, and
- stage-space distance between press and release points is
  `<= TAP_MAX_MOVE_PX = 10` logical px.

Exceeding either threshold (including drift detected during MOTION /
TOUCH_UPDATE) cancels the pending tap so a stroke never counts as one.

Each recorded tap carries a timestamp plus its anchor window (or NULL
for the unattached / desktop surface) and is appended to a rolling
4-slot history. After each append we prune entries older than 750 ms
and then check, in order:

1. **Quad tap** - 4 taps within 750 ms (anywhere) -> call
   `meta_annotation_layer_clear`, reset history.
2. **Triple tap** - last 3 taps share an anchor and span
   `<= TRIPLE_TAP_WINDOW_US = 500 ms` -> clear only that anchor's ink
   (`clear_ink_for_anchor`, which clears the matching per-window surface
   or the unattached surface), reset history.

Because the 3-tap gesture fires as soon as its threshold is met, doing
4 fast taps on the same window will hit the 3-tap clear on the third
tap; the 4th tap then starts a new burst. 4 fast taps spread across
more than one window or the desktop still hit the 4-tap clear-all.

A dying anchor window clears any matching entries out of the pending
tap and rolling history in `on_window_unmanaged`, so the gesture
machinery never holds a dangling `MetaWindow*`.

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
- `_publishChromeRegions` now prepends a single `__dock-body` region
  covering the whole dock's transformed bounds before the per-button
  regions. Because Mutter's chrome picker walks the region list in
  reverse, per-button regions still win hit tests; the dock-body
  region only catches presses that fell in the separator or padding.
  `_activateRegion` already ignores unknown ids, so the resulting
  `RegionActivated` signal for `__dock-body` is a deliberate no-op.

## Behavior summary

- Drawing a stroke over window W attaches the stroke to W. Moving,
  resizing, or restacking W causes the ink to move, resize-clip, or be
  reoccluded on the very next idle tick.
- Strokes over the desktop land on `unattached_surface` and stay
  stage-anchored.
- Strokes never appear on top of the annotation dock. Chrome regions
  (buttons + dock body) consume presses before the stroke path sees
  them, and at composite time the dock's rectangles are cleared out of
  the uploaded surface, so ink that belongs to a window occluded by
  the dock never bleeds onto it.
- Minimizing or switching away from W hides its ink; restoring it brings
  the ink back untouched.
- Closing W destroys the `WindowInk` and its strokes. There is no
  persistence.
- Entering the overview fully hides the annotation overlay; exiting
  shows it again with all ink intact.
- Pen pressure modulates line width with a square-root response curve;
  mouse and non-pressure-touch strokes are full width.
- Pen tilt additionally widens the stroke (up to 2.5x at ~60 degrees
  from vertical); direction is not used.
- Three quick pen/touch taps on the same window within 500 ms clear
  just that window's ink; four quick taps within 750 ms (any
  combination of windows or the desktop) clear every window's ink.
- Holding any pen barrel button puts the stroke path in erase mode.
  Erase is now an **object eraser**: each eraser sub-segment is
  tested for proximity against the stored `Stroke` polylines on the
  current target buffer, and any stroke that the eraser's footprint
  touches is removed in full from the list. When one or more strokes
  are removed, the entire target surface is cleared and re-rasterized
  from the surviving strokes, so the deletion is visible immediately
  and no stroke is left with a partial gap. The eraser footprint is
  the stroke half-width the pen would draw at the current pressure /
  tilt scaled by `ANNOT_ERASE_WIDTH_FACTOR = 2.0`, with a floor of
  `ANNOT_ERASE_MIN_RADIUS = 8 px` so light touches still connect.
  The broad-phase uses a per-stroke cached bbox so hit-testing stays
  cheap even on dense canvases. Releasing the barrel switches back to
  ink on the very next segment; the tip never has to lift. Using the
  pen's flip-side eraser tool triggers the same erase mode even
  without a barrel press. Barrel presses over the dock are silently
  consumed (no color/clear activation).

## Scroll-following (Kate)

Layered on top of window-following. Goal: ink drawn over a Kate
editor pane moves with the document as the user scrolls; ink drawn
anywhere else on Kate's window (terminal pane, tool views, tabs,
menu) stays pinned to the window as before.

### Data model additions

- `Stroke.follow_scroll` (bool). When `TRUE`, `InkPoint` coordinates
  are in *editor content space*: `x` relative to the editor region's
  left edge, `y` in document pixels inclusive of the scroll offset at
  the time the point was recorded. When `FALSE`, behavior is identical
  to pre-scroll builds.
- `WindowInk.has_editor_region` + `editor_x, editor_y, editor_w,
  editor_h` (window-local logical pixels). Published externally via
  `SetWindowEditorRegion`. Marks the hot-zone that qualifies new
  strokes for follow-scroll semantics and clips their rendering.
- `WindowInk.scroll_x, scroll_y` (document pixels). Published
  externally via `SetWindowScroll`. Subtracted from content-space
  points at render time.
- `MetaAnnotationLayer.stroke_follow_scroll` (bool). Caches the
  begin-stroke hit-test result for the duration of a single press so
  `append_ink_point` can stamp new Strokes consistently.

### Coordinate math

At draw time (inside editor region, follow stroke):

    content_x = window_x - editor_x + scroll_x
    content_y = window_y - editor_y + scroll_y

At render time:

    window_x = content_x + editor_x - scroll_x
    window_y = content_y + editor_y - scroll_y

Live feedback in `continue_stroke` still paints at window-local
coordinates — that's where the pen visibly is *now*, and scrolls
mid-stroke are prevented by ending the stroke on scroll update. The
stored `InkPoint` is what gets translated; the live pixels will be
cleared and repainted from storage at the next rasterize pass.

### Rasterizer (two-pass)

`rasterize_all_strokes_with_ink` clears the surface and then:

1. **Non-follow pass.** One cairo_t, identity transform, no clip.
   Paints every non-follow stroke. Matches pre-scroll behavior
   exactly.
2. **Follow pass (only if `has_editor_region` and at least one
   follow stroke exists).** One cairo_t clipped to the editor
   rectangle and translated by
   `(editor_x - scroll_x, editor_y - scroll_y)`. Paints every
   follow stroke. The clip guarantees follow ink cannot bleed onto
   neighboring chrome (tabs, terminal, toolbars, scrollbar).

`rasterize_all_strokes` is now a thin wrapper that passes `NULL` ink
for the unattached (stage-sized) surface, which never has follow
strokes.

### `draw_segment_full` -> `draw_segment_on_cr`

The per-segment painter now takes a caller-provided `cairo_t` and
wraps its state changes in `cairo_save` / `cairo_restore`. This lets
the rasterizer install one clip + translate for an entire stroke
batch instead of building a fresh cairo_t per segment (which would
drop the clip). Live-feedback callers in `continue_stroke` create and
destroy their own short-lived cairo_t; performance is unchanged for
that path (cairo contexts are cheap to allocate against an image
surface).

### Erase hit-test for follow strokes

`erase_strokes_hit_by_segment` now accepts a `WindowInk *ink`
argument (`NULL` for unattached strokes) and handles each stroke
according to its `follow_scroll` bit:

- Non-follow strokes: identical to the previous behavior — the
  eraser segment (already in window-local coords) is tested directly
  against the stored (also window-local) polyline.
- Follow strokes: the eraser segment is translated into editor
  content space before the segment-to-segment distance test. Also,
  if *neither* eraser endpoint is inside the editor region, the
  stroke is skipped entirely, so flailing the eraser over the
  terminal pane can never delete invisible ink below or above the
  editor viewport.

### Mid-stroke scroll / editor-region change

Both `SetWindowScroll` and `SetWindowEditorRegion` call `end_stroke`
on any in-flight stroke anchored to the affected window (scroll only
ends it if that stroke is `follow_scroll`; region change always
ends it, since the content-vs-window decision could flip). This
avoids a smeared line on sudden scroll jumps and avoids half-
converting coordinates mid-polyline.

### D-Bus surface

Two new methods on `org.gnome.Mutter.Annotation`, both keyed by PID:

| Method                       | Signature               | Semantics                                                                 |
|------------------------------|-------------------------|---------------------------------------------------------------------------|
| `SetWindowEditorRegion(...)` | `(u pid, i x,y,w,h)`    | Register the editor hot-zone on every MetaWindow with this PID; `w=0` or `h=0` clears it. |
| `SetWindowScroll(...)`       | `(u pid, i sx, i sy)`   | Update scroll offset on every MetaWindow with this PID; triggers re-rasterize. |

Unknown PIDs are no-ops. Matching by PID means multi-top-level apps
sharing a process will share the same region + scroll (fine for
Kate, a known limitation if another target app ever matters).

### Kate wiring (`kateTracker.js`)

A new module `annotations-shell-extension/kateTracker.js` discovers
Kate via AT-SPI and drives the two D-Bus methods:

- `Atspi.init()` once on extension enable; two global event
  listeners registered for `object:value-changed` (scroll events)
  and `object:bounds-changed` (editor widget layout shifts).
- Per Kate top-level (matched by `wm_class == "kate"` /
  `"org.kde.kate"`), a `KateWindowTracker` walks the AT-SPI tree
  with exponential-backoff retries (Kate registers asynchronously
  after window-map):
  - Finds the *largest* `ROLE_TEXT` descendant that does **not**
    have a `ROLE_TERMINAL` ancestor. This is the "separate the
    terminal and the code editing portion" filter: Konsole's
    text display is rooted under a TERMINAL, so it's skipped even
    though it too is TEXT-role.
  - Finds a vertical `ROLE_SCROLL_BAR` adjacent to the editor
    (right-edge, y-overlap) during the same walk.
- The editor's window-local extents are pushed via
  `SetWindowEditorRegion`; they're republished on window
  `size-changed` / `position-changed` and on AT-SPI
  bounds-changed events targeting the editor.
- Scroll is computed from the editor's `Text.getCharacterExtents(0,
  WINDOW)` y-delta vs. a baseline captured at discovery, so we
  don't have to care whether Kate's scrollbar reports values in
  lines or pixels. If the Text interface is unavailable, falls
  back to the raw scrollbar `current_value`.
- Value-changed events are filtered to Kate by PID, then to the
  editor scrollbar by either cached reference equality or
  adjacency to the cached editor region. Terminal scrollbar events
  are ignored because the terminal's scrollbar is never adjacent
  to the editor.
- `MetaWindow::unmanaged` tears the tracker down and sends
  `SetWindowEditorRegion(pid, 0, 0, 0, 0)` so Mutter forgets the
  region; extension `disable()` tears down all trackers and
  deregisters AT-SPI listeners.

### Known limits of the Kate path

- Multi-window Kate (multiple top-levels under one process) shares
  a single editor region + scroll offset. Multi-tab-single-window
  Kate is fine: tabs reuse the same view, so switching tabs just
  updates char 0's position and yields a scroll delta.
- AT-SPI must be running (standard on any system with Qt
  accessibility enabled). If `Atspi.init()` throws, the dock + ink
  continue to work but without scroll-following.
- First stroke on a freshly-opened Kate window may land up to a
  few seconds before discovery completes (exponential backoff is
  ~14s total). Such strokes are stored as non-follow and stay
  pinned to the window, which is consistent with "no region
  published".
- `KTextEditor::View` reports `getCharacterExtents` in pixels on
  all current Qt versions we tested against; on stacks where it
  doesn't, the scrollbar fallback still produces correct direction
  and approximate magnitude (line-quantized).

## Known limitations / out of scope

- Rectangular occlusion only. Shaped and rounded-corner windows will
  leak ink into their "transparent" corners.
- No animation handling. Minimize / maximize / workspace transitions
  snap ink on signal completion rather than following the animation.
- No stretch-on-resize. A window that doubles in size keeps the ink at
  its original (surface-local) position and re-rasterizes within the
  new bounds; anything that lies outside the new frame is clipped.
- No overview preview painting. Overview thumbnails do not render ink.
- One stroke in flight globally; multi-seat concurrent strokes are not
  modeled.
- No rotation / barrel-pressure and no directional tilt nib; only
  `CLUTTER_INPUT_AXIS_PRESSURE` and tilt magnitude (via XTILT/YTILT)
  is consumed.
- Per-device pressure calibration is a fixed `[0.1, 1.0]` clamp with a
  hard-coded `sqrt` gamma and `BASE_WIDTH = 6.0` logical px.
- Scroll-following only for Kate (via AT-SPI). Other editors would
  need their own tracker.
