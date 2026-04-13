# GNOME Shell integration (fork)

## What the Shell patch does

`patches/0002-gnome-shell-plugin-annotation-fork-init.patch` updates:

- `data/org.gnome.shell.gschema.xml.in` — adds boolean **`annotation-pointer-passthrough`** (default `false`) on **`org.gnome.shell`**.
- `src/gnome-shell-plugin.c` — on startup, creates a **`GSettings`** for `org.gnome.shell`, listens for **`changed::annotation-pointer-passthrough`**, and calls **`meta_fork_annotation_set_pointer_passthrough`** on the **`MetaWaylandCompositor`** whenever the key changes.

## Extension wiring

The in-tree extension (`extension.js`) uses **`Gio.Settings`** for `org.gnome.shell` when the key exists (forked schema installed). **`Extension.syncShellPointerPassthrough(visible)`** mirrors overlay visibility so **pointer** clients receive focus under Shell chrome while the layer is on; **tablet / stylus** routing stays on the overlay (Mutter fork).

## Build note

This Shell patch must be built against **the same forked libmutter** that exports `meta_fork_annotation_set_pointer_passthrough`. Stock distro `libmutter` will fail at link time until you install your rebuilt mutter.

## X11 sessions

`meta_context_get_wayland_compositor()` may be `NULL`; the plugin guards with `if (wayland_compositor)`.
