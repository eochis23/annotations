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
| [scripts/clone-sources.sh](scripts/clone-sources.sh) | Shallow-clone Mutter + Shell at a tag. |
| [scripts/apply-patches.sh](scripts/apply-patches.sh) | Apply `patches/*.patch` to clones. |
| [scripts/rollback-hint.sh](scripts/rollback-hint.sh) | Print rollback reminders. |

## Quick start

```bash
./scripts/clone-sources.sh
./scripts/apply-patches.sh
# Then build mutter + gnome-shell using your distro’s PKGBUILD / mock workflow.
```

## Archived implementations

Earlier experiments and the in-tree **GNOME Shell extension** (gjs overlay + optional `anno-motion` helper) live under [`archive/`](archive/README.md): [`archive/shell-extension/`](archive/shell-extension/README.md), [`archive/native/`](archive/native/), [`archive/legacy/`](archive/legacy/README.md).

The **`fork_annotation_resolve_pointer_surface`** stub in `0001` returns the incoming surface unchanged until you implement scene picking (see [docs/input-trace.md](docs/input-trace.md)).

## API added (fork)

- **`meta_fork_annotation_set_pointer_passthrough (MetaWaylandCompositor *, gboolean)`** — public in `meta/meta-wayland-compositor.h`.
- **`meta_fork_annotation_seat_set_pointer_passthrough (MetaWaylandSeat *, gboolean)`** — internal; used by the wrapper above.

## License

Patch context is derived from **GPL-2.0-or-later** Mutter and Shell sources; your combined binaries remain under those licenses.
