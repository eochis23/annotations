# Content movement detection — signal spike (Phase 6)

This document captures **feasible approaches** to detect that **underlying application content** moved (scroll, pan, sub-surface scroll) so ink can be **translated** in overlay space. It informs what we implement in **gjs** first vs what needs the **C ROI matcher** ([`native/anno-motion`](../native/anno-motion/)).

## Goals

- Estimate **(dx, dy)** of content between two samples with a **confidence** score.
- Prefer **cheap, event-driven** sources before **pixel ROI correlation** (C).

## Option A — Forwarded / observed scroll events (gjs, low cost)

| Mechanism | Works when | Fails when |
|-----------|------------|------------|
| Shell captures **scroll** events on a **reactive** overlay | Overlay receives wheel/touchpad scroll and we treat it as “content scrolled under pointer” | Overlay is non-reactive (mouse-through); or scroll is captured by app first; or touchpad is smoothed differently |
| **Keybinding / dock** “nudge” | User-assisted calibration | Not automatic |

**Verdict:** Useful as a **supplement** or demo path; **not** a universal “content moved” detector for all apps.

## Option B — AT-SPI2 (a11y bus) (gjs via introspection or small helper)

| Mechanism | Works when | Fails when |
|-----------|------------|------------|
| Subscribe to **AtkDocument** / **scroll** signals or periodic bounds queries on focused accessible | GTK/Qt apps expose rich trees; terminal emulators vary | Electron/Chromium often **partial** tree; games; privacy toggles; performance if polling |
| **Document** scroll offset APIs where exposed | Some toolkits report scrollable state | Wayland does not standardize “scroll offset” to Shell; AT-SPI is **best-effort per toolkit** |

**Verdict:** **Spike per target app** (Firefox, Terminal, Evince). If offsets are reliable, **no C** needed for those apps. Keep **confidence** and fall back to pixels.

## Option C — Compositor / Meta hints (gjs + Shell private APIs)

| Mechanism | Works when | Fails when |
|-----------|------------|------------|
| Internal Shell signals on **MetaSurfaceActor** / **MetaWindow** | Theoretical future hooks | **Unstable across releases**; often **not exposed** to extensions; EGO reviewers dislike private API |

**Verdict:** Avoid for v1; revisit only if upstream adds a **supported** “content scroll” protocol.

## Option D — ROI pixel correlation (C helper, Phase 7)

| Mechanism | Works when | Fails when |
|-----------|------------|------------|
| Two **grey8 ROI** snapshots (same geometry); **block SSD / NCC** search for integer shift | Static-ish UI, moderate resolution ROI, bounded search | Video, heavy animations, transparent layers, DRM fullscreen, **GPU** compositing changes pixel noise |
| **Strict budget**: max Hz, max ROI, async subprocess | Predictable CPU | Mis-tuning can still jank if invoked on main thread (must not) |

**Verdict:** Default **portable** path for “unknown app”; gated by **user consent** in preferences (see README “Privacy”).

## App-class matrix (expected behavior)

| Class | AT-SPI | Wheel proxy | ROI (C) |
|-------|--------|-------------|---------|
| GTK3/4 native | Often good | Partial | Good |
| Qt (many apps) | Variable | Partial | Good |
| Chromium / Electron | Weak tree | Partial | Moderate |
| Terminal (VTE, etc.) | Varies | Partial | Good for text buffer scroll |
| Games / GL fullscreen | Poor | Poor | Poor (disable) |
| Video playback | Poor | Poor | Poor (disable) |

## Chosen rollout

1. **Ship C helper** for ROI → `(dx, dy, confidence)` ([`native/anno-motion`](../native/anno-motion/)).
2. **gjs** [`lib/motionClient.js`](../lib/motionClient.js) runs helper **off the main thread** via `Gio.Subprocess` + async completion; **throttle** Hz from settings.
3. **Integrate** with stroke model [`translateAll`](../lib/strokes.js) when `confidence ≥ threshold` (settings).
4. **Later:** optional AT-SPI spike module per high-value app to **skip pixels** when signals suffice.

## Failure modes (document for users)

- **Low confidence:** ink stays in **screen coordinates** (no spurious jump).
- **Fullscreen exclusive / protected content:** disable movement sync automatically if ROI capture fails.
