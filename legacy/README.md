# Legacy GTK application

This directory holds the **previous** standalone GTK 4 / libadwaita application (`gtk-application/`), preserved for reference, comparison, or building outside GNOME Shell.

**Product strategy:** the supported path on GNOME is the **Shell extension** at the repository root (`extension.js`, `lib/`, `native/`, …). This GTK tree is **non-GNOME fallback / reference** only unless you revive it explicitly.

Build (from that subdirectory):

```bash
cd gtk-application
meson setup build && meson compile -C build
```

License: **MIT** — see `gtk-application/COPYING`.
