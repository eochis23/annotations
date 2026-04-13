# Mutter + GNOME Shell fork (pointer passthrough hook)

This repository holds **documentation**, **patch files**, and **scripts** to build a personal fork of **Mutter** and **GNOME Shell** that adds a compositor-side hook to rewrite **`wl_pointer`** focus while leaving the **tablet tool** path unchanged. It supports the [Screen Annotations](https://github.com/eochis23/annotations) goal: pen on an overlay, pointer to clients below.

**Upstream clones** (`mutter-src/`, `gnome-shell-src/`) are gitignored here; use `scripts/clone-sources.sh` to populate them.

## Contents

| Path | Purpose |
|------|---------|
| [VERSIONS.md](VERSIONS.md) | Pinned versions and commit SHAs when patches were generated. |
| [patches/](patches/) | `0001` mutter, `0002` gnome-shell — apply in order after clone. |
| [docs/input-trace.md](docs/input-trace.md) | Where pointer vs tablet split in Mutter 49.x. |
| [docs/shell-integration.md](docs/shell-integration.md) | How Shell should toggle the hook. |
| [docs/VALIDATION.md](docs/VALIDATION.md) | Manual test matrix. |
| [docs/PACKAGING-ROLLBACK.md](docs/PACKAGING-ROLLBACK.md) | Packaging notes and rollback. |
| [docs/SCROLL_SYNC.md](docs/SCROLL_SYNC.md) | Scroll / content-movement strategy (post–per-window ink). |
| [scripts/clone-sources.sh](scripts/clone-sources.sh) | Shallow-clone Mutter + Shell at a tag. |
| [scripts/apply-patches.sh](scripts/apply-patches.sh) | Apply `patches/*.patch` to clones. |
| [scripts/rollback-hint.sh](scripts/rollback-hint.sh) | Print rollback reminders. |

## Quick start

```bash
./scripts/clone-sources.sh
./scripts/apply-patches.sh
# Then build mutter + gnome-shell using your distro’s PKGBUILD / mock workflow.
```

## GNOME Shell extension (development tree)

The **annotations** Shell extension (`extension.js`, `lib/`, `schemas/`, `Makefile`, `native/`) lives at the **repository root**. With the forked Shell package, the extension toggles **`org.gnome.shell` `annotation-pointer-passthrough`** so the compositor re-picks **`wl_pointer`** targets under Shell chrome while the overlay is visible.

## Archived implementations

Older snapshots and non-Shell code live under [`archive/`](archive/README.md): [`archive/legacy/`](archive/legacy/README.md), packaged zips, etc.

## API added (fork)

- **`meta_fork_annotation_set_pointer_passthrough (MetaWaylandCompositor *, gboolean)`** — public in `meta/meta-wayland-compositor.h`.
- **`meta_fork_annotation_seat_set_pointer_passthrough (MetaWaylandSeat *, gboolean)`** — internal; used by the wrapper above.

## License

Patch context is derived from **GPL-2.0-or-later** Mutter and Shell sources; your combined binaries remain under those licenses.
