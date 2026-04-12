# Screen Annotations (GNOME Shell)

Desktop pen annotations **inside GNOME Shell** (D3 plan): transparent overlay, stacking, and input behavior are implemented as an extension instead of a standalone Wayland client.

The old **GTK / libadwaita** app lives under [`legacy/gtk-application/`](legacy/gtk-application/) (MIT) for reference or non-GNOME experiments.

## Requirements

- GNOME Shell **45+** (ESM extension entrypoint).
- Wayland or X11 session under GNOME.

## Development install

The extension UUID is **`annotations@eochis23.github.io`**. The folder you install **must** use that exact name.

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
glib-compile-schemas schemas/
ln -sf "$(pwd)" ~/.local/share/gnome-shell/extensions/annotations@eochis23.github.io
```

Then **log out and back in** (Wayland) or restart GNOME Shell so schemas and the extension load.

Enable from *Extensions* or:

```bash
gnome-extensions enable annotations@eochis23.github.io
```

You should see a **tablet** status icon.

### Drawing on screen

1. Open the tablet menu → **Toggle drawing layer**, or press **Super+Alt+A** (default; avoids clashes with **Super+Shift+A** on some setups). Change via `gsettings` / dconf key `toggle-overlay`, then restart the extension or session.
2. Draw with **mouse, pen, or tablet** (pressure when available). **Right or middle button** erases.
3. **Dock** (top-left): color swatches and **Clear all**. **Eraser**: stylus barrel / right or middle button while inking.
4. Toggle the layer off again when you need to click through to apps (the overlay captures the pointer while visible).

After changing code, recompile schemas if `gschema.xml` changed, then disable/enable the extension or log out/in.

## Native motion helper (`anno-motion`)

The C helper compares two raw **grey8** buffers (`width × height` bytes) and prints JSON `{"dx","dy","c","mse"}`.

```bash
meson setup native/build && meson compile -C native/build
python3 native/test-scroll.py   # sanity check
```

`lib/motionClient.js` looks for `bin/anno-motion` first, then `native/build/anno-motion`.

## Pack a zip

```bash
make pack
# or see docs/packaging-ego-native.md for gnome-extensions pack flags
```

## Roadmap (see `docs/`)

- [`docs/shell-extension-input.md`](docs/shell-extension-input.md) — overlay input notes.
- [`docs/content-movement-spike.md`](docs/content-movement-spike.md) — AT-SPI vs ROI vs compositor signals.
- [`docs/packaging-ego-native.md`](docs/packaging-ego-native.md) — EGO vs self-host when shipping `anno-motion`.

Shell overlay + full drawing UI: still to be built on top of this scaffold.

## License

Extension code: **GPL-2.0-or-later** ([`LICENSE`](LICENSE)).  
Legacy GTK tree: **MIT** ([`legacy/gtk-application/COPYING`](legacy/gtk-application/COPYING)).
