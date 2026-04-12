# Screen Annotations (GNOME Shell)

Desktop pen annotations **inside GNOME Shell** (D3 plan): transparent overlay, stacking, and input behavior are implemented as an extension instead of a standalone Wayland client.

The old **GTK / libadwaita** app lives under [`legacy/gtk-application/`](legacy/gtk-application/) (MIT) for reference or non-GNOME experiments.

## Requirements

- GNOME Shell **45+** (ESM extension entrypoint).
- Wayland or X11 session under GNOME.

## Development install

The extension UUID is **`annotations@eochis23.github.io`**. The folder you install **must** use that exact name.

```bash
ln -sf "$(pwd)" ~/.local/share/gnome-shell/extensions/annotations@eochis23.github.io
# Log out and back in, or Alt+F2 → r (X11 only) to reload Shell on unsupported reload paths use restart session
```

Then enable **Screen Annotations** in *Extensions* or:

```bash
gnome-extensions enable annotations@eochis23.github.io
```

You should see a **tablet** status icon and a one-time notification on enable.

## Pack a zip

```bash
gnome-extensions pack --force --extra-source=stylesheet.css .
# produces annotations@eochis23.github.io.shell-extension.zip
```

## Roadmap (see `docs/shell-extension-input.md`)

1. Phase 0: layer tree + input model spikes on target Shell versions.
2. Phase 1: fullscreen Clutter overlay, multi-monitor.
3. Phase 2: Cairo stroke engine, eraser, clear.
4. Phase 3: floating dock, keybindings.
5. Phase 4: extensions.gnome.org packaging.

## License

Extension code: **GPL-2.0-or-later** ([`LICENSE`](LICENSE)).  
Legacy GTK tree: **MIT** ([`legacy/gtk-application/COPYING`](legacy/gtk-application/COPYING)).
