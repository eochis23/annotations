#!/usr/bin/env bash
# Clone shallow Mutter + GNOME Shell for applying this repo’s patch series.
# Requires: git, network. See VERSIONS.md for the tag this tree was tested with.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${MUTTER_FORK_TAG:-49.5}"
MUTTER_URL="${MUTTER_GIT_URL:-https://gitlab.gnome.org/GNOME/mutter.git}"
SHELL_URL="${SHELL_GIT_URL:-https://gitlab.gnome.org/GNOME/gnome-shell.git}"

echo "Using tag or branch: $TAG"
echo "Mutter -> $ROOT/mutter-src"
if [[ -d "$ROOT/mutter-src/.git" ]]; then
  echo "mutter-src already exists; skip clone (rm -rf mutter-src to re-clone)."
else
  git clone --depth 1 --branch "$TAG" "$MUTTER_URL" "$ROOT/mutter-src"
fi

echo "gnome-shell -> $ROOT/gnome-shell-src"
if [[ -d "$ROOT/gnome-shell-src/.git" ]]; then
  echo "gnome-shell-src already exists; skip clone."
else
  git clone --depth 1 --branch "$TAG" "$SHELL_URL" "$ROOT/gnome-shell-src"
fi

echo "Record HEAD for VERSIONS.md:"
git -C "$ROOT/mutter-src" rev-parse HEAD 2>/dev/null || true
git -C "$ROOT/gnome-shell-src" rev-parse HEAD 2>/dev/null || true
