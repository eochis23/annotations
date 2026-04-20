# Annotation input routing (Wayland)

This fork routes **pointer-like** events to the compositor annotation surface **before** they reach `meta_wayland_compositor_handle_event()`, so Wayland clients do not see stylus/touch drawing streams while the layer is active.

## Classifier (`meta_annotation_event_targets_overlay`)

Events are considered **overlay** when the `ClutterInputDevice` from `clutter_event_get_source_device()` is one of:

- `CLUTTER_TOUCHSCREEN_DEVICE`
- `CLUTTER_TABLET_DEVICE`, `CLUTTER_PEN_DEVICE`, `CLUTTER_ERASER_DEVICE`, `CLUTTER_CURSOR_DEVICE`
- `CLUTTER_POINTER_DEVICE` with `CLUTTER_INPUT_CAPABILITY_TABLET_TOOL` (e.g. tool on a master pointer)

**Normal window interaction** (not routed to the annotation layer):

- `CLUTTER_POINTER_DEVICE` without tablet-tool capability (typical USB mouse and core pointer)
- `CLUTTER_TOUCHPAD_DEVICE` (touchpad scrolling and gestures stay with focused clients)
- `CLUTTER_PAD_DEVICE` (ExpressKey / pad ring events are left to existing pad/tablet mapper handling where applicable)
- Keyboard and other non-pointer event types

## Event types consumed on the overlay path

Only motion, button, touch, and scroll events pass the type gate in `meta-annotation-input.c`. The layer draws from motion/button/touch; scroll is classified for routing but may fall through if the layer does not handle it.

## D-Bus (`org.gnome.Mutter.Annotation`)

- Path: `/org/gnome/Mutter/Annotation`
- Methods: `Clear`, `SetActive(b)`, `SetColor(d,d,d,d)`
- The shell extension dock calls these over the session bus.

## Manual checks

1. Mouse: move and click through the annotation texture onto a terminal or browser; focus and clicks should behave as before.
2. Touchscreen or tablet pen: drawing should appear on the overlay and not reach underlying surfaces.
3. Touchpad: two-finger scroll in a focused window should still scroll the client.
4. Trash button on the dock: clears strokes via `Clear`.

If a device is misclassified, adjust `meta_annotation_event_targets_overlay()` in `mutter/src/core/meta-annotation-input.c`.
