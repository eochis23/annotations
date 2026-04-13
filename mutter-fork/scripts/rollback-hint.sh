#!/usr/bin/env bash
# Print rollback guidance (does not modify the system).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "Rollback documentation:"
echo "  file://$ROOT/docs/PACKAGING-ROLLBACK.md"
echo
echo "Arch: previous packages often in /var/cache/pacman/pkg/"
ls /var/cache/pacman/pkg/mutter-*.pkg.tar.zst 2>/dev/null | tail -3 || echo "  (no mutter cache entries listed)"
ls /var/cache/pacman/pkg/gnome-shell-*.pkg.tar.zst 2>/dev/null | tail -3 || echo "  (no gnome-shell cache entries listed)"
