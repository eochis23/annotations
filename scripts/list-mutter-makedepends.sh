#!/bin/bash
# Print Make Depends tokens from `pacman -Si mutter` (stdin = full -Si output ok too).
# Run inside the target root (arch-chroot). No hardcoded version lists.

set -euo pipefail

if [[ -t 0 ]]; then
	out=$(pacman -Si mutter 2>/dev/null) || {
		echo "list-mutter-makedepends: no 'mutter' in sync DB (try: pacman -Sy)" >&2
		exit 1
	}
else
	out=$(cat)
fi

echo "$out" | awk '
	/^(Make Depends|Make Depends On)/ {
		sub(/^(Make Depends|Make Depends On)[[:space:]]*:[[:space:]]*/, "")
		line = $0
		while (getline > 0) {
			if ($0 ~ /^[[:space:]]+/) {
				sub(/^[[:space:]]+/, "", $0)
				line = line " " $0
				continue
			}
			break
		}
		n = split(line, a, /[[:space:]]+/)
		for (i = 1; i <= n; i++) if (a[i] != "") print a[i]
		exit
	}
'
