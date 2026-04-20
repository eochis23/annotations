#!/bin/bash
# Fail if any real (non-symlink) libmutter*.so* under MOUNT_POINT/usr/lib/mutter-* is tiny.
# Catches truncated installs (dynamic linker: "file too short").
set -euo pipefail
MP="${1:?Usage: $0 MOUNT_POINT}"
if [[ ! -d "$MP/usr/lib" ]]; then
	echo "Error: not a root tree: $MP/usr/lib"
	exit 1
fi
bad=""
while IFS= read -r -d '' f; do
	[[ -L "$f" ]] && continue
	sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
	if [[ "$sz" -lt 8192 ]]; then
		echo "Error: mutter library is too small (${sz} bytes): $f"
		bad=1
	fi
done < <(find "$MP/usr/lib" -type f -path '*/mutter-*/libmutter*.so*' -print0 2>/dev/null || true)
if [[ -n "$bad" ]]; then
	echo "Mutter install verification failed (see above). Restore with: sudo arch-chroot \"$MP\" pacman -S --noconfirm mutter"
	exit 1
fi
echo "OK: mutter shared libraries under $MP/usr/lib/mutter-* look non-empty."
