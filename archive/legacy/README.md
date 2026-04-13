# Legacy GTK application

This directory holds the **previous** standalone GTK 4 / libadwaita application (`gtk-application/`), preserved for reference, comparison, or building outside GNOME Shell.

**Product strategy:** the supported direction in this repository is the **Mutter + Shell fork** at the repo root (`patches/`, `scripts/`, …). The **Shell extension** scaffold lives under [`archive/shell-extension/`](../shell-extension/README.md). This GTK tree is **non-GNOME fallback / reference** only unless you revive it explicitly.

Build (from that subdirectory):

```bash
cd gtk-application
meson setup build && meson compile -C build
```

License: **MIT** — see `gtk-application/COPYING`.
