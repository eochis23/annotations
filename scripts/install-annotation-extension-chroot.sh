#!/bin/bash
set -euo pipefail
# Install annotations-shell-extension and a system dconf default to enable it.
# Usage: install-annotation-extension-chroot.sh CHROOT_MOUNT_POINT
# Run from the host with sudo as needed for the same paths arch-chroot uses.

MP="${1:?Usage: $0 CHROOT_MOUNT_POINT (e.g. /run/media/user/root)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="annotation@annotations.local"
DEST="$MP/usr/share/gnome-shell/extensions/$UUID"
SRC="$HERE/annotations-shell-extension"

if [[ ! -f "$SRC/metadata.json" ]]; then
	echo "Error: missing $SRC/metadata.json"
	exit 1
fi

sudo mkdir -p "$DEST"
sudo cp -a "$SRC/extension.js" "$SRC/metadata.json" "$SRC/stylesheet.css" "$DEST/"

sudo mkdir -p "$MP/etc/dconf/db/local.d"
sudo tee "$MP/etc/dconf/db/local.d/99-annotation-extension" >/dev/null <<'EOF'
# Annotations project: enable the annotation dock extension by default.
# If you already use enabled-extensions in another fragment, merge this UUID there.
[org/gnome/shell]
enabled-extensions=['annotation@annotations.local']
EOF

sudo mkdir -p "$MP/etc/dconf/db/gdm.d"
sudo tee "$MP/etc/dconf/db/gdm.d/99-annotation-extension" >/dev/null <<'EOF'
# Same extension list for GDM greeter shell (pen crash fix needs compositor + extension in sync).
[org/gnome/shell]
enabled-extensions=['annotation@annotations.local']
EOF

sudo arch-chroot "$MP" /bin/bash -lc 'command -v dconf >/dev/null 2>&1 && dconf update || true'

echo "Installed $UUID under $DEST and refreshed dconf in chroot (if dconf is available)."
