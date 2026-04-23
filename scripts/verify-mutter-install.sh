#!/bin/bash
# Fail if any real (non-symlink) libmutter*.so* under MOUNT_POINT/usr/lib/mutter-* is tiny,
# or if a SONAME symlink (libmutter*.so.N) dereferences to a tiny file (same linker error).
# Catches truncated installs (dynamic linker: "file too short").
set -euo pipefail
MP="${1:?Usage: $0 MOUNT_POINT}"
if [[ ! -d "$MP/usr/lib" ]]; then
	echo "Error: not a root tree: $MP/usr/lib"
	exit 1
fi
bad=""
# Real ELF files for libmutter* under /usr/lib (top-level) and /usr/lib/mutter-*/ (subdir).
# Basename must end in .so or .so[.<digits>]* — skip meson text artifacts like *.symbols.
while IFS= read -r -d '' f; do
	[[ -L "$f" ]] && continue
	bn=$(basename "$f")
	[[ "$bn" =~ ^libmutter[^/]*\.so(\.[0-9]+)*$ ]] || continue
	sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
	if [[ "$sz" -lt 8192 ]]; then
		echo "Error: mutter library is too small (${sz} bytes): $f"
		bad=1
	fi
done < <({
	find "$MP/usr/lib" -maxdepth 1 -type f -name 'libmutter*.so*' -print0 2>/dev/null
	find "$MP/usr/lib" -type f -path "*/mutter-*/libmutter*.so*" -print0 2>/dev/null
} || true)
# SONAME symlinks: libmutter*.so.0 (one digit); follow to real ELF. Check both dirs.
shopt -s nullglob
for sym in "$MP"/usr/lib/libmutter*.so.[0-9] "$MP"/usr/lib/mutter-*/libmutter*.so.[0-9]; do
	[[ -L "$sym" ]] || continue
	sz=$(stat -L -c%s "$sym" 2>/dev/null || echo 0)
	if [[ "$sz" -lt 8192 ]]; then
		echo "Error: SONAME symlink resolves to tiny/missing target (${sz} bytes): $sym -> $(readlink "$sym" 2>/dev/null || true)"
		bad=1
	fi
done
shopt -u nullglob
if [[ -n "$bad" ]]; then
	echo "Mutter install verification failed (see above). Restore with: sudo arch-chroot \"$MP\" pacman -S --noconfirm mutter"
	exit 1
fi
echo "OK: mutter shared libraries under $MP/usr/lib/mutter-* look non-empty."
