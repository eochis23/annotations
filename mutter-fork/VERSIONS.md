# Pinned upstream revisions (fork baseline)

Recorded from the development machine when patches were generated. **Re-clone and re-diff** when rebasing onto a newer GNOME.

| Component | Reported version | `git rev-parse HEAD` | Notes |
|-------------|------------------|----------------------|--------|
| **mutter** (distro) | 49.5 | `658f672cc49eb9c8069d6f0c89d218d311d6de3c` | Shallow clone `49.5` followed GitHub mirror default branch tip (see clone log). |
| **gnome-shell** (distro) | 49.5 | `7c3185a8d5be2cd5904d52c30f499151194b4009` | Same shallow-tag behavior. |
| **Arch packages** | `mutter 49.5-1`, `gnome-shell 1:49.5-1` | — | Use `pacman -Q mutter gnome-shell` after updates. |

Upstream URLs:

- https://gitlab.gnome.org/GNOME/mutter (mirror may redirect to GitHub)
- https://gitlab.gnome.org/GNOME/gnome-shell

For a reproducible baseline, prefer an **exact tag tarball** or full clone at the tag commit after verifying `git rev-parse 49.5^{commit}` on gitlab.gnome.org.
