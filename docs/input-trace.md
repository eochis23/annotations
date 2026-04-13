# Mutter input trace: pointer vs tablet tool (GNOME 49.x)

This documents where **Wayland seat** code splits **core pointer** (`wl_pointer`) from **stylus / tablet tool** (`zwp_tablet_tool_v2`) for the annotations fork. Paths are relative to the **mutter** source root.

## 1. Single choke point: `default_focus` in `meta-wayland-seat.c`

`MetaWaylandSeat` installs a default `MetaWaylandEventHandler` whose `focus` vfunc is `default_focus` (see `meta_wayland_seat_new()` in `src/wayland/meta-wayland-seat.c`).

For a `ClutterFocus` that is a **sprite** (not keyboard, not touch sequence), `default_focus`:

1. Reads `ClutterInputDevice *device` from the sprite.
2. If `caps & CLUTTER_INPUT_CAPABILITY_TABLET_TOOL`, calls **`meta_wayland_tablet_seat_focus_surface()`** — tablet tool focus path.
3. Separately, if `caps` includes **pointer / touchpad / trackball / trackpoint**, calls **`meta_wayland_pointer_focus_surface()`** — `wl_pointer` focus path.

Both branches receive the **same** `MetaWaylandSurface *surface` argument that upstream already resolved for this focus change. The fork’s first hook is to **rewrite only the surface passed to (3)** while leaving (2) unchanged.

**Relevant symbols**

- `default_focus` — `src/wayland/meta-wayland-seat.c`
- `meta_wayland_pointer_focus_surface` — `src/wayland/meta-wayland-pointer.c` (sets `pointer->focus_surface`, emits enter/leave)
- `meta_wayland_tablet_seat_focus_surface` — `src/wayland/meta-wayland-tablet-seat.c` → `meta_wayland_tablet_tool_focus_surface` in `meta-wayland-tablet-tool.c`

## 2. How `surface` is chosen before `default_focus`

`meta_wayland_input_invalidate_focus()` (`src/wayland/meta-wayland-input.c`) calls the handler’s `get_focus_surface`, then `focus`.

The default `get_focus_surface` is `default_get_focus_surface` in `meta-wayland-seat.c`, which may return `meta_wayland_pointer_get_implicit_grab_surface()` or else **`meta_wayland_seat_get_current_surface()`**.

`meta_wayland_seat_get_current_surface()` branches on device capabilities:

- **Tablet tool** → `meta_wayland_tablet_seat_get_current_surface()`
- **Pointer-like** → `meta_wayland_pointer_get_current_surface()` (typically `pointer->current`)

So **current** vs **focus** updates are related but distinct; the fork patch targets the **`default_focus` → `meta_wayland_pointer_focus_surface`** line to influence **which client receives `wl_pointer.enter`**.

## 3. Why Shell extension ink is still hard

GNOME Shell’s annotation overlay is usually **Clutter chrome**, not a **`MetaWaylandSurface`**. The resolved `surface` for pointer may be **NULL** or a **non-toplevel** edge case when the sprite is over UI that does not map to a client surface. The **TODO** in the fork is to combine this hook with **scene picking** (or a second pass) so that when passthrough is enabled, **`wl_pointer`** targets the **topmost client surface under** the shell chrome at the cursor, while tablet focus behavior stays as today.

## 4. Patch reference

Implementation (stub resolver + public API): `patches/0001-mutter-annotation-fork-pointer-hook.patch`.
