# Mutter changes: annotation layer

This document describes every change made to this Mutter tree to implement a compositor-owned **annotation overlay**: non-mouse pointer-like input is handled (and blocked from normal Wayland delivery) on a full-screen drawable layer, while the core mouse pointer continues to use the usual picking path. The GNOME Shell side re-parents the overlay actor above `uiGroup` so ink appears over shell chrome; that is documented separately in the parent repository.

No changes were made under `mutter/clutter/` for this feature; routing is done entirely in the display event path.

---

## 1. New source files

### 1.1 `src/compositor/meta-annotation-layer.h` / `meta-annotation-layer.c`

**Purpose:** Owns the visual annotation surface and stroke state.

**Data structures**

- Opaque `MetaAnnotationLayer` holding:
  - `MetaBackend` (referenced) for stage size and Cogl/Clutter backend access.
  - `ClutterActor` named `"annotation-layer"` with **`clutter_actor_set_reactive(FALSE)`** so **hit-testing skips this actor** and the physical mouse continues to interact with windows and shell UI underneath (the layer is paint-only for pointer picking).
  - Cairo `ARGB32` image surface sized to the stage, kept in sync with a `CoglTexture2D` via `cogl_texture_set_data()` using `COGL_PIXEL_FORMAT_CAIRO_ARGB32_COMPAT`.
  - `ClutterTextureContent` + `clutter_actor_set_content()` for painting the texture each frame; `clutter_content_invalidate()` after CPU-side drawing updates.
  - Default stroke color (red-ish), `active` flag, last stroke coordinates, `stroke_active` for button/touch drag state.
  - `notify::width` / `notify::height` handlers on the stage to recreate buffers on resolution change.

**Public API** (all exported with `META_EXPORT` in the header where applicable)

| Function | Behavior |
|----------|----------|
| `meta_annotation_layer_new(MetaBackend *)` | Builds layer; does **not** parent the actor to the stage (Shell inserts it with `insert_child_above`). |
| `meta_annotation_layer_destroy` | Disconnects stage signals, frees Cairo/Cogl/actor. |
| `meta_annotation_layer_get_actor` | Returns the `ClutterActor *` for Shell stacking. |
| `meta_annotation_layer_clear` | Clears Cairo surface (operator clear), re-uploads texture. |
| `meta_annotation_layer_set_active` / `get_active` | Toggles visibility with `clutter_actor_show` / `hide`; when inactive, routing still consults active flag in the compositor helper. |
| `meta_annotation_layer_set_color` | Stores `float` RGBA used for subsequent strokes. |
| `meta_annotation_layer_handle_event` | Interprets overlay events and returns `TRUE` if the event should **not** propagate to Wayland handling. |

**Drawing logic** (`meta_annotation_layer_handle_event`)

- **Primary button** (`CLUTTER_BUTTON_PRIMARY`): press sets anchor; motion with button mask or while `stroke_active` draws line segments with round caps/joins (width 4); release finalizes segment.
- **Touch** `BEGIN` / `UPDATE` / `END` / `CANCEL`: finger stroke analogous to button drag.
- **Motion** without draw button: still returns `TRUE` when classified as overlay (e.g. stylus hover) so clients do not see hover motion; no ink until button down.
- **Scroll** and other types: layer’s `switch` returns `FALSE` for unhandled types so callers may fall through (scroll classification is mainly in the input helper).

**Dependencies**

- `backends/meta-backend-private.h` for `meta_backend_get_clutter_backend()` and thus `clutter_backend_get_cogl_context()`.

---

### 1.2 `src/core/meta-annotation-input.h` / `meta-annotation-input.c`

**Purpose:** Single place for **device policy**: which Clutter events are treated as “overlay” (annotation) vs normal window/stream delivery.

**API**

- `gboolean meta_annotation_event_targets_overlay(const ClutterEvent *event)`

**Rules**

1. Requires `clutter_event_get_source_device()` non-`NULL`; otherwise `FALSE`.
2. Event type must be one of: `MOTION`, `BUTTON_PRESS` / `BUTTON_RELEASE`, touch lifecycle events, `SCROLL`. All other types → `FALSE`.
3. Device type:
   - **Overlay (`TRUE`):** `TOUCHSCREEN_DEVICE`, `TABLET_DEVICE`, `PEN_DEVICE`, `ERASER_DEVICE`, `CURSOR_DEVICE`.
   - **Overlay if tool:** `POINTER_DEVICE` **and** `CLUTTER_INPUT_CAPABILITY_TABLET_TOOL`.
   - **Not overlay (`FALSE`):** plain `POINTER_DEVICE` (mouse), `TOUCHPAD_DEVICE`, `PAD_DEVICE`, keyboard, extension, joystick, etc.

Touchpad scrolling and pad hardware therefore remain on the normal compositor → Wayland path.

---

### 1.3 `src/core/meta-annotation-dbus.h` / `meta-annotation-dbus.c`

**Purpose:** Session-bus control surface for the shell extension (or any client) without linking Shell to Mutter internals.

**Bus details**

| Item | Value |
|------|--------|
| Well-known name | `org.gnome.Mutter.Annotation` |
| Object path | `/org/gnome/Mutter/Annotation` |
| Interface | `org.gnome.Mutter.Annotation` |
| Name flags | `ALLOW_REPLACEMENT \| REPLACE` (same pattern family as other Mutter session services) |

**Introspection / methods**

| Method | Parameters | Effect |
|--------|--------------|--------|
| `Clear` | — | `meta_annotation_layer_clear()` |
| `SetActive` | `(b)` | `meta_annotation_layer_set_active()` |
| `SetColor` | four `d` (r,g,b,a) | `meta_annotation_layer_set_color()` |

Implementation uses `g_dbus_node_info_new_for_xml()`, `g_dbus_connection_register_object()` with a static `GDBusInterfaceVTable`, and `g_bus_own_name()`. `MetaAnnotationDBus` stores the `GDBusConnection`, registration id, and name owner id; `meta_annotation_dbus_free()` unowns the name and unregisters the object if still registered.

---

## 2. Modified existing files

### 2.1 `src/meson.build`

Appended to `mutter_sources`:

- `compositor/meta-annotation-layer.c`, `compositor/meta-annotation-layer.h`
- `core/meta-annotation-input.c`, `core/meta-annotation-input.h`
- `core/meta-annotation-dbus.c`, `core/meta-annotation-dbus.h`

So the new objects link into `libmutter`.

---

### 2.2 `src/compositor/compositor.c`

**Includes added**

- `compositor/meta-annotation-layer.h`
- `core/meta-annotation-dbus.h`
- `core/meta-annotation-input.h`

**`MetaCompositorPrivate` (local struct in this file)**

- `MetaAnnotationLayer *annotation_layer`
- `MetaAnnotationDBus *annotation_dbus`

**`meta_compositor_manage()`**

After `meta_plugin_manager_start()`:

1. `priv->annotation_layer = meta_annotation_layer_new(priv->backend);`
2. `priv->annotation_dbus = meta_annotation_dbus_new(priv->annotation_layer);`

So the layer and D-Bus service exist for the full compositor lifetime after manage succeeds.

**`meta_compositor_real_unmanage()`**

Before destroying window groups:

1. `g_clear_pointer(&priv->annotation_dbus, meta_annotation_dbus_free);`
2. `g_clear_pointer(&priv->annotation_layer, meta_annotation_layer_destroy);`

**New public function** `meta_compositor_get_annotation_layer()`

- Returns `NULL` if no layer; otherwise `meta_annotation_layer_get_actor()`.
- Documented in-file with gtk-doc style comment: transfer none, nullable `ClutterActor *`.

**New internal function** `meta_compositor_route_annotation_event()`

- Declared in `compositor-private.h` (not in the public `meta/compositor.h`).
- Returns `TRUE` when the event is consumed (caller should return `CLUTTER_EVENT_STOP`):
  - No layer or layer inactive → `FALSE`.
  - `!meta_annotation_event_targets_overlay(event)` → `FALSE`.
  - Else returns whatever `meta_annotation_layer_handle_event()` returns (typically `TRUE` for handled overlay pointer/touch types).

---

### 2.3 `src/compositor/compositor-private.h`

**Declaration added**

```c
gboolean meta_compositor_route_annotation_event (MetaCompositor    *compositor,
                                                 const ClutterEvent *event);
```

Used from `events.c` in the same shared library.

---

### 2.4 `src/meta/compositor.h`

**Declaration added**

```c
ClutterActor * meta_compositor_get_annotation_layer (MetaCompositor *compositor);
```

Exposed for GObject-Introspection / GNOME Shell (`global.compositor.get_annotation_layer()`).

---

### 2.5 `src/core/events.c`

**Behavior change in `meta_display_handle_event()`**

Immediately **before** the existing call to `meta_wayland_compositor_handle_event()`:

```c
if (meta_compositor_route_annotation_event (compositor, event))
  return CLUTTER_EVENT_STOP;
```

**Ordering rationale**

- Runs after keybindings, pad/tablet mapper branches, grab checks, and window-specific handling that already ran earlier in the function, but **before** Wayland compositor delivery of the same event to clients.
- Therefore overlay-classified motion/button/touch (per policy) can be absorbed for drawing without updating Wayland pointer/touch focus for underlying surfaces.

**No change** to `meta-wayland-pointer.c` or other Wayland files in this iteration; blocking is achieved by stopping the Clutter filter path before `meta_wayland_compositor_handle_event()`.

---

## 3. What was intentionally not changed

- **Clutter fork** (`mutter/clutter/`): no edits.
- **Wayland protocol objects** (`meta-wayland-pointer.c`, seat, etc.): no separate per-device branch; reliance is on the single `meta_display_handle_event` filter ordering.
- **X11 session path:** no extra branch; annotation routing is driven from the same `meta_display_handle_event` path used when Wayland compositor handling is invoked from the display.

If X11-only sessions need identical policy, a follow-up would audit whether all relevant events still reach this function unchanged.

---

## 4. Integration outside this `mutter/` directory (reference only)

These are **not** part of the Mutter tree but are required for the feature to behave as designed end-to-end:

- **GNOME Shell** (`../gnome-shell/js/ui/layout.js`): after adding `uiGroup` to the stage, optional `global.compositor.get_annotation_layer?.()` and `insert_child_above(annotationLayer, this.uiGroup)` so the texture draws above shell chrome.
- **Shell extension** and **install scripts** in the parent `annotations` repository: install path, dconf `enabled-extensions`, dock D-Bus calls.

---

## 5. File checklist

| Path | Action |
|------|--------|
| `src/compositor/meta-annotation-layer.c` | **New** |
| `src/compositor/meta-annotation-layer.h` | **New** |
| `src/core/meta-annotation-input.c` | **New** |
| `src/core/meta-annotation-input.h` | **New** |
| `src/core/meta-annotation-dbus.c` | **New** |
| `src/core/meta-annotation-dbus.h` | **New** |
| `src/meson.build` | **Modified** (sources list) |
| `src/compositor/compositor.c` | **Modified** |
| `src/compositor/compositor-private.h` | **Modified** |
| `src/meta/compositor.h` | **Modified** |
| `src/core/events.c` | **Modified** |

---

## 6. Rebasing / upstream merges

When rebasing onto newer Mutter:

1. Re-resolve conflicts in `events.c` around `meta_wayland_compositor_handle_event` — keep the `meta_compositor_route_annotation_event` call **immediately before** it unless upstream refactors event flow.
2. Re-check `meta_compositor_manage` / `real_unmanage` ordering relative to plugin manager lifecycle.
3. Confirm `MetaCompositorPrivate` field offsets if the private struct grows upstream.
4. Re-run `meson compile` and a quick session test: mouse through, stylus/touch on overlay, D-Bus `Clear`.
