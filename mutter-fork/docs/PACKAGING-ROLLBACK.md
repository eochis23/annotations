# Packaging and rollback (Arch-centric; adapt for Fedora)

## Build products

From a successful Meson/Ninja build you typically install:

- `libmutter-*.so` and friends
- `mutter` binary (or compositor library only, depending on split)
- `gnome-shell` binary and `libgnome-shell.so`

On **Arch Linux**, refer to the official `extra/mutter` and `extra/gnome-shell` `PKGBUILD` files: copy them into a personal repo, add `mutter-fork/patches/*.patch` to `source` and apply in `prepare()`.

## Version suffix

Append a release tag (e.g. `49.5.annotations1`) so `pacman -Q` clearly shows a non-vanilla package.

## Rollback (Arch)

1. Keep the previous pair of packages in pacman cache: `/var/cache/pacman/pkg/mutter-*.pkg.tar.zst`, `gnome-shell-*.pkg.tar.zst`.
2. From a TTY (if the session fails):  
   `sudo pacman -U /var/cache/pacman/pkg/mutter-<stock>.pkg.tar.zst /var/cache/pacman/pkg/gnome-shell-<stock>.pkg.tar.zst`
3. Reboot or restart GDM.

## Rollback (Fedora)

Use `dnf history list` / `dnf history undo <id>` after a failed upgrade, or explicitly `dnf install --allowerasing mutter gnome-shell` from official repos.

## Script

`mutter-fork/scripts/rollback-hint.sh` prints this file path and cache locations (no system changes).
