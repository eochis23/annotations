# Screen Annotations (GNOME 50.1)

This repository is a **working fork of Mutter 50.1 and GNOME Shell 50.1** plus **GNOME Shell extensions** for **pen-first screen annotations** on Wayland. The compositor owns a full-screen annotation surface: **tablet / stylus ink** is drawn in Mutter while the **core mouse pointer** keeps normal hit-testing so windows and shell UI underneath behave as if the overlay were not there—aligned with the original [Screen Annotations](https://github.com/eochis23/annotations) goal.

Older patch-only workflows and snapshots remain documented under [`patches/`](patches/), [`scripts/`](scripts/), and [`archive/`](archive/README.md). The **authoritative sources** for day-to-day work are the vendored trees [`mutter/`](mutter/) and [`gnome-shell/`](gnome-shell/) (both `meson.build` report **version 50.1**).

## What is in the tree (current layout)

| Area | Role |
|------|------|
| [`mutter/`](mutter/) | Forked compositor: annotation layer, input policy (pen vs mouse), session D-Bus `org.gnome.Mutter.Annotation`, public hooks used by Shell. See [`mutter/ANNOTATION_MUTTER_CHANGES.md`](mutter/ANNOTATION_MUTTER_CHANGES.md). |
| [`gnome-shell/`](gnome-shell/) | Forked Shell: schema key `annotation-pointer-passthrough` on `org.gnome.shell`, plugin wiring to libmutter so the extension can toggle pointer passthrough. |
| [`annotations-shell-extension/`](annotations-shell-extension/) | Extension installed by the chroot scripts (`annotation@annotations.local`): dock, colors, clear/undo, D-Bus to Mutter, Kate tracker for optional motion features. |
| Root [`extension.js`](extension.js), [`lib/`](lib/), [`schemas/`](schemas/), [`Makefile`](Makefile) | Alternate / extended extension (`annotations@eochis23.github.io`): overlay session, stroke model, optional movement sync, prefs; `make pack` builds a zip. Uses fork gsettings when the patched schema is installed. |
| [`install_second_partition.sh`](install_second_partition.sh), [`install.sh`](install.sh), [`compile_target.local.example`](compile_target.local.example) | Arch-centric flow: mount a target root, **arch-chroot**, sync repo, install build deps, **Meson/Ninja install into that root’s `/usr`**, then extension + optional Kate runtime. |
| [`patches/`](patches/) | Historical / portable diffs if you prefer applying on top of a fresh upstream clone instead of this vendored tree. |
| [`docs/`](docs/) | Input tracing, Shell integration, validation, packaging rollback, scroll/movement strategy. |
| [`VERSIONS.md`](VERSIONS.md) | Previously recorded upstream SHAs; rebasing—reconcile with your distro’s **50.1** packages. |

## Installing to replace stock Mutter 50.1 and GNOME Shell 50.1

Replacing the distro packages means **installing your build into the same prefix** (typically `/usr`) so `gnome-shell` loads your **libmutter** and your **gschemas**. This is disruptive: keep **pacman cache** copies of stock `mutter` and `gnome-shell` packages and read [`docs/PACKAGING-ROLLBACK.md`](docs/PACKAGING-ROLLBACK.md).

### Option A — Automated (Arch Linux, second root or USB system)

Best when you maintain a **duplicate Arch install** on another partition or disk image.

1. Copy [`compile_target.local.example`](compile_target.local.example) to `compile_target.local.sh` (gitignored) and set **`MOUNT_POINT`**, **one of** `PARTITION_DEVICE` / `PARTITION_PARTUUID` / `PARTITION_FS_LABEL`**, and **`CHROOT_REPO_DIR`** (e.g. `/mnt/build/annotations`). Set **`BUILD_TARGETS=mutter,shell`** to replace both Mutter and GNOME Shell 50.1.
2. From the host repo: `./install_second_partition.sh`  
   This mounts the partition, runs [`install.sh`](install.sh) inside the chroot to sync the git tree, installs build dependencies, runs `meson setup` / `ninja` / **`ninja install`** for **mutter** and (if selected) **gnome-shell** into the chroot’s `/usr`, runs [`scripts/verify-mutter-install.sh`](scripts/verify-mutter-install.sh), refreshes **`ldconfig`** and schemas, then [`scripts/install-annotation-extension-chroot.sh`](scripts/install-annotation-extension-chroot.sh) and optional Kate/AT-SPI setup.

Boot that installation and log into GNOME on Wayland. If the session fails, roll back from a TTY using cached packages (see rollback doc).

### Option B — Manual build on the machine that will run GNOME

Run as root only for the install step.

```bash
# Dependencies: use Arch extra/mutter and extra/gnome-shell PKGBUILD makedepends as a checklist.

cd mutter
rm -rf build
meson setup build --prefix=/usr -Dtests=disabled   # adjust -D options to match your needs
ninja -C build
sudo ninja -C build install

cd ../gnome-shell
rm -rf build
meson setup build --prefix=/usr -Dtests=false
ninja -C build
sudo ninja -C build install

sudo ldconfig
sudo glib-compile-schemas /usr/share/glib-2.0/schemas/
```

Then install **one** of the extensions:

- **Chroot-style system extension:** copy [`annotations-shell-extension/`](annotations-shell-extension/) to `/usr/share/gnome-shell/extensions/annotation@annotations.local/` and merge `enabled-extensions` / dconf as in [`scripts/install-annotation-extension-chroot.sh`](scripts/install-annotation-extension-chroot.sh), **or**
- **Packed dev extension:** from the repo root, `make pack` and `gnome-extensions install --force annotations@eochis23.github.io.shell-extension.zip`, then enable it in Extensions or `gnome-extensions enable …`.

Ensure root [`metadata.json`](metadata.json) **`shell-version`** includes **50** if you use the packed UUID `annotations@eochis23.github.io`. Remove stale **`~/.local/share/gnome-shell/extensions/…`** copies if Shell reports a user install shadowing `/usr`.

Reboot (or restart GDM) after replacing Mutter/Shell.

### Option C — Patches on a clean upstream 50.1 tree

If you do not use the vendored directories, clone upstream at **50.1**, then apply [`patches/*.patch`](patches/) in order (see [`scripts/clone-sources.sh`](scripts/clone-sources.sh) / [`scripts/apply-patches.sh`](scripts/apply-patches.sh)) and build with your distro’s packaging workflow.

## Features (high level)

**Compositor (Mutter fork)**

- Full-screen **annotation surface** (Cairo → Cogl) with **non-reactive** stacking so the **physical mouse** still picks windows under the ink.
- **Device split:** pen / tablet / touchscreen drawing and hover suppression on the overlay; **mouse and touchpad** follow the normal Wayland path. Scroll and pad devices stay on the normal path unless explicitly handled.
- **D-Bus** `org.gnome.Mutter.Annotation` for **SetActive**, **Clear**, color, stroke/region helpers—used by `annotations-shell-extension`.
- Optional **pointer passthrough** coordination via **`meta_fork_annotation_set_pointer_passthrough`** and Shell **`annotation-pointer-passthrough`** so **`wl_pointer`** focus matches “through the overlay” behavior under Shell chrome when the extension requests it.

**GNOME Shell fork**

- Loads the patched libmutter and exposes the **`org.gnome.shell`** boolean used by extensions to toggle passthrough safely on Wayland.

**Extensions**

- **Toggle** drawing layer (default shortcut **`Super+Alt+A`** in root extension schema; recompile schemas after changes).
- **Dock:** multiple pen colors, **clear**, **undo**, draggable; compositor can treat dock geometry so ink does not stick under chrome.
- **Stroke-oriented** interaction (not single-pixel “rubber” erasing in the high-level design; see [`SPEC.md`](SPEC.md)).
- **Per-window / motion** direction: root `lib/` implements overlay sessioning and optional **movement sync** (ROI-based, consent-gated in gsettings); see [`docs/SCROLL_SYNC.md`](docs/SCROLL_SYNC.md). **Kate** / Qt paths are supported in the chroot install scripts for accessibility-based tracking when enabled.

## Quick reference (legacy clone + patch)

```bash
./scripts/clone-sources.sh
./scripts/apply-patches.sh
# Then build with your distro PKGBUILD / mock workflow at the same version as this tree (50.1).
```

## API added (fork)

- **`meta_fork_annotation_set_pointer_passthrough (MetaWaylandCompositor *, gboolean)`** — public in `meta/meta-wayland-compositor.h` (see mutter sources).
- Internal seat-level helpers as documented in [`mutter/ANNOTATION_MUTTER_CHANGES.md`](mutter/ANNOTATION_MUTTER_CHANGES.md).

## License

Patch context and upstream sources are **GPL-2.0-or-later**; combined binaries you install remain under those licenses.
