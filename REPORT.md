# Code review: annotation layer, install path, and safety

Review date: 2026-04-20. Scope: `mutter/src/compositor/meta-annotation-layer.c`, related Mutter integration (`compositor.c`, `events.c`, `meta-annotation-input.c`, `meta-annotation-dbus.c`), GNOME Shell stacking (`gnome-shell/js/ui/layout.js`), chroot install scripts (`install_second_partition.sh`, `scripts/install-annotation-extension-chroot.sh`), and the annotations shell extension (`annotations-shell-extension/extension.js`).

## Executive summary

The annotation overlay is created when the compositor finishes `manage()`, defaults to **active and visible**, and is stacked **above** `uiGroup` when the patched Shell’s `LayoutManager` runs—so ink appears over shell chrome. The chroot install path builds and installs Mutter, then installs and **enables** the shell extension via dconf; the extension provides the color/clear dock and D-Bus calls but does **not** need to call `SetActive(true)` because the layer already starts active.

Main risks are **hard-coded debug logging** (path, volume, and portability), **missing error checks** after Cairo/Cogl allocation, and **touch state** modeled as a single stroke (multi-touch ambiguity). None of these are proven crashers on a healthy system, but they are real robustness gaps.

---

## 1. Crash safety and robustness (`meta-annotation-layer.c`)

### 1.1 Defensive patterns that help

- Public APIs use `g_return_if_fail` / `g_return_val_if_fail` on `layer` and `event` where applicable.
- `draw_segment`, `clear_surface`, `sync_texture_from_surface`, and `meta_annotation_layer_handle_event` bail out when `layer->surface` is missing.
- `recreate_buffers` returns early for `width < 1 || height < 1`, avoiding zero-sized textures.
- Stage `notify::width` / `notify::height` use `g_signal_connect_object` so handlers are disconnected if the stage outlives the layer (unlikely, but correct style).
- `meta_annotation_layer_destroy` clears signal handlers before destroying the actor and surface.

### 1.2 Gaps that could crash or misbehave under stress

1. **`cairo_image_surface_create` is unchecked**  
   On allocation failure Cairo returns a surface in an error state (or under memory pressure, NULL-like behavior is still surfaced via status). The code immediately uses `cairo_create` and drawing without `cairo_surface_status` checks. A failed surface can lead to undefined behavior or crashes inside Cairo.

2. **`cogl_texture_allocate` and `clutter_texture_content_new_from_texture` are not checked for failure**  
   If GPU allocation fails, downstream use may assert or crash depending on Clutter/Cogl internals.

3. **`cogl_texture_set_data` failure**  
   Only a `g_warning` is emitted; the Cairo surface and Cogl texture may diverge (stale or blank framebuffer). Not a crash by itself, but visually wrong.

4. **Hard-coded agent log path**  
   `ANNOTATION_AGENT_LOG_PRIMARY` points at `/home/eochis/Projects/annotations/.cursor/debug-338895.log`. On other machines this path usually fails open and falls back to `/tmp/...`, but **every handled event may call `fopen`/`fprintf`/`fclose`**, which is heavy and can slow the compositor or fill disk if the path exists and traffic is high. This is inappropriate for a production compositor build.

5. **Texture vs surface dimensions**  
   `sync_texture_from_surface` logs when Cairo and Cogl sizes differ but still calls `cogl_texture_set_data`. A mismatch should not happen if `recreate_buffers` is the single source of truth; if it ever did, behavior depends on Cogl (at best failed upload with warning).

### 1.3 Event handling and logic risks

- **Input gating is centralized** in `meta_annotation_event_targets_overlay()` (`meta-annotation-input.c`): normal **core pointer** devices (without tablet-tool capability) do **not** route to the annotation layer, so the main mouse is not “stolen” by this path. Pen, tablet, touchscreen, cursor, and pointer-with-tablet-tool go through.
- **`CLUTTER_BUTTON_PRESS` for non-primary button returns `TRUE`** when the event is routed to the layer, which **stops propagation** even though no drawing started. This only matters for devices that pass the overlay filter (e.g. some tablet configurations); worth knowing for odd button combinations.
- **Touch uses a single `stroke_active` / `last_x` / `last_y`**. Concurrent touches can interleave `TOUCH_BEGIN`/`TOUCH_UPDATE` and corrupt a stroke logically (not necessarily a crash).
- **`CLUTTER_BUTTON_RELEASE` does not verify the primary button**; any button release clears `stroke_active`. Usually acceptable.

### 1.4 Lifecycle and stacking

- `meta_annotation_layer_new()` creates an actor, shows it, but **does not parent it to the stage** (by design). Patched Shell does `global.stage.insert_child_above(annotationLayer, this.uiGroup)` in `layout.js`, so the layer is visible above shell UI.
- On Shell `shutdown`, the snippet reparents `window_group`, `top_window_group`, and `feedback_group` back to the stage but **does not mention the annotation actor**. The actor remains a stage child until Mutter destroys the layer in `meta_compositor_real_unmanage()` via `meta_annotation_layer_destroy()`, which destroys the actor. This matches the intended teardown order as long as the compositor unmanag runs; if that order ever differed, you could get a leak or double-free—worth a quick manual test on session exit, but nothing in the snippet obviously violates GObject ownership.

---

## 2. “Active on install” and install pipeline

### 2.1 Layer default state

In `meta_annotation_layer_new()`, `layer->active = TRUE` and `clutter_actor_show(layer->actor)` are set immediately. So the **compositor-side overlay is on by default** after `meta_compositor_manage()` succeeds (`compositor.c` creates the layer right after the plugin manager starts).

### 2.2 D-Bus

`meta_annotation_dbus_new()` registers `org.gnome.Mutter.Annotation` on the session bus. Nothing in the D-Bus layer forces `SetActive(false)` at startup, so defaults remain **active** until a client calls `SetActive`.

### 2.3 `install_second_partition.sh`

- Mounts the target, runs `install.sh` in chroot for the repo, runs `meson setup` / `ninja` / `ninja install` for Mutter (and optionally Shell), then `scripts/verify-mutter-install.sh`, then **`scripts/install-annotation-extension-chroot.sh`**.
- The extension installer copies files to `/usr/share/gnome-shell/extensions/annotation@annotations.local/` and writes `/etc/dconf/db/local.d/99-annotation-extension` with `enabled-extensions=['annotation@annotations.local']`, then runs `dconf update` in the chroot when possible.

So **after this install path**, the user gets:

1. Forked Mutter with the annotation layer and session D-Bus API installed under `/usr`.
2. Shell extension enabled by default (dock: colors + clear).

The **extension `enable()` path does not call `SetActive`**. That is consistent with the layer already being active in Mutter; the dock is additive UI.

### 2.4 Caveats for “enabled on first boot”

- System `dconf` defaults only apply when they compose correctly with other `local.d` fragments. The installer comment notes merging if another fragment already sets `enabled-extensions`.
- If `dconf` is missing in the chroot, `dconf update` is skipped (`|| true`); the extension files are still installed but may not be **enabled** until the database is updated on the target system.

---

## 3. Functional behavior (high level)

- **Drawing**: Pointer-like overlay devices update a Cairo ARGB image, upload to a Cogl texture, and invalidate `ClutterContent` so the actor repaints.
- **Hit testing**: `clutter_actor_set_reactive(FALSE)` on the annotation actor keeps picking from targeting the ink layer; combined with Wayland pointer passthrough work (separate fork in the Wayland seat), the design aims to let **clients** receive pointer events while ink is drawn from **synthetic / tablet** overlay routing (`events.c` routes to `meta_compositor_route_annotation_event` before Wayland handling when the handler returns true).
- **Shell extension**: Calls `SetColor` and `Clear` over D-Bus; errors are logged to the Shell journal only. No toggle for “drawing mode” in the reviewed `extension.js`—mode is effectively “whenever overlay-eligible input is routed.”

---

## 4. Recommendations (prioritized)

1. **Remove or gate debug logging** behind an environment variable or build flag, and avoid hard-coded home-directory paths in Mutter.
2. **After `cairo_image_surface_create` and texture allocation**, check status / null and fail gracefully (skip upload, leave layer empty, log once).
3. **Consider touch sequence IDs** (or ignore secondary touches while a stroke is active) if multi-touch tablets are in scope.
4. **Document or automate** dconf merge for `enabled-extensions` if other products ship fragments on the same image.
5. **Optional**: run a short session under ASan/UBSan on the fork to validate Cairo/Cogl error paths.

---

## 5. Files referenced

| Area | Path |
|------|------|
| Layer implementation | `mutter/src/compositor/meta-annotation-layer.c` |
| Compositor wiring | `mutter/src/compositor/compositor.c` |
| Event routing | `mutter/src/core/events.c` |
| Overlay device filter | `mutter/src/core/meta-annotation-input.c` |
| Session API | `mutter/src/core/meta-annotation-dbus.c` |
| Stage stacking | `gnome-shell/js/ui/layout.js` |
| Chroot orchestration | `install_second_partition.sh` |
| Extension + dconf | `scripts/install-annotation-extension-chroot.sh`, `annotations-shell-extension/extension.js` |

This report is based on static analysis of the repository as of the review date; runtime validation on target hardware was not performed in this pass.
