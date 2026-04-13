# GNOME Shell integration (fork)

## What the Shell patch does

`mutter-fork/patches/0002-gnome-shell-plugin-annotation-fork-init.patch` updates `src/gnome-shell-plugin.c`:

- Includes **`meta/meta-wayland-compositor.h`**.
- In **`gnome_shell_plugin_start()`**, after `_shell_global_set_plugin()`, obtains  
  `MetaDisplay` → `MetaContext` → **`MetaWaylandCompositor`** and calls  
  **`meta_fork_annotation_set_pointer_passthrough (wayland_compositor, FALSE)`**.

So the compositor hook is **initialized to off** on every session start. **Toggling** passthrough when the annotations overlay becomes visible still requires a small amount of C (or a GObject-introspected path if you expose one later).

## Recommended next wiring steps

1. **When the drawing layer is shown** (your extension’s equivalent of `OverlaySession.toggle` visible **true**): call  
   `meta_fork_annotation_set_pointer_passthrough (wc, TRUE)`  
   **When hidden**: `FALSE`.

2. **How to reach C from the extension** (pick one for a personal fork):

   - **GSettings in Shell C**: add a boolean key under `org.gnome.shell` (forked schema) and a `GSettings` listener in `gnome-shell-plugin.c` or `shell-global.c` that calls `meta_fork_annotation_set_pointer_passthrough` when the key flips. The extension toggles the key via `Gio.Settings` from JS (same process as Shell for in-process extensions).

   - **Minimal native module** loaded by Shell (advanced): export a tiny C function callable from GJS via `GIRepository` — high maintenance.

3. **X11 sessions**: `meta_context_get_wayland_compositor()` may be `NULL`; the patch already guards with `if (wayland_compositor)`.

## Build note

This Shell patch must be built against **the same forked libmutter** that exports `meta_fork_annotation_set_pointer_passthrough`. Stock distro `libmutter` will fail at link time until you install your rebuilt mutter.
