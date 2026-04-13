# Scroll sync (SPEC phase 6)

After per-window ink and stable window targeting exist, choose one or combine:

1. **ROI greyscale matcher (`anno-motion`)** — Compare small cropped regions between frames; get `(dx, dy, confidence)`; throttle; translate strokes via `StrokeModel.translateAll`. See [`content-movement-spike.md`](extension/content-movement-spike.md) (extension notes) and the `native/` helper at repo root. Best generic signal when compositor does not expose scroll.

2. **AT-SPI / app-specific signals** — Where accessible APIs report viewport scroll (e.g. large web views), skip pixels and translate ink from events. High precision when available; high maintenance.

3. **Compositor / protocol hints** — If a future protocol or Mutter hook exposes surface scroll offsets for toplevels, prefer that over ROI. Depends on upstream.

**Recommendation:** Implement (1) behind existing extension settings (`movement-sync`, consent, threshold, max Hz) once per-window stroke coordinates are stable; treat (2) as optional fast paths per application class.
