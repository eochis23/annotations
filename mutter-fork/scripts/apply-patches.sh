#!/usr/bin/env bash
# Apply mutter-fork patch series to local clones (see clone-sources.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUTTER="$ROOT/mutter-src"
SHELL="$ROOT/gnome-shell-src"

apply_one() {
  local dir="$1"
  local patch="$2"
  if [[ ! -d "$dir/.git" ]]; then
    echo "error: missing $dir — run scripts/clone-sources.sh first" >&2
    exit 1
  fi
  echo "patching $(basename "$dir") < $(basename "$patch")"
  patch -d "$dir" -p1 --forward --reject-file=- <"$patch" || {
    echo "error: patch failed (maybe already applied?)" >&2
    exit 1
  }
}

apply_one "$MUTTER" "$ROOT/patches/0001-mutter-annotation-fork-pointer-hook.patch"
apply_one "$SHELL" "$ROOT/patches/0002-gnome-shell-plugin-annotation-fork-init.patch"
echo "done."
