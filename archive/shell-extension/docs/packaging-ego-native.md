# Packaging: extensions.gnome.org (EGO) and native `anno-motion`

## Self-hosted zip (recommended first)

1. Build schemas: `glib-compile-schemas schemas/`
2. Build native helper: `cd ../native && meson setup build && meson compile -C build`
3. Copy the binary next to the extension (so `findAnnoMotionBinary` finds it):
   `mkdir -p bin && cp ../native/build/anno-motion bin/anno-motion`
4. Pack (include every non-`metadata`/`extension` source you `import`):

```bash
gnome-extensions pack --force \
  --extra-source=prefs.js \
  --extra-source=stylesheet.css \
  --extra-source=lib/strokes.js \
  --extra-source=lib/devices.js \
  --extra-source=lib/motionClient.js \
  --extra-source=lib/motionSync.js \
  --extra-source=schemas/gschemas.compiled \
  --extra-source=schemas/org.gnome.shell.extensions.annotations.gschema.xml \
  --extra-source=bin/anno-motion \
  .
```

Or use `make pack` from this directory’s [`Makefile`](../Makefile).

## extensions.gnome.org

- Reviewers expect **no blocking I/O** on the main thread: the matcher already uses `Gio.Subprocess` asynchronously from gjs.
- **Bundling a compiled binary** is unusual for EGO; expect extra scrutiny or rejection unless you document reproducible builds (Meson) and target architectures.
- Practical split: ship **JS-only** to EGO (matcher disabled unless `bin/anno-motion` exists), and document **“full build”** on GitHub Releases with the binary for each arch you support.

## Privacy (user-facing)

- Preferences copy states that **only small grey ROIs** are intended for the helper once the overlay wires capture—**no full-screen** capture without separate explicit consent (add a second key if you add that later).
- Movement sync **does nothing useful** until ROI snapshots are hooked up; the timer is a no-op placeholder except for the **synthetic self-test** menu entry.
