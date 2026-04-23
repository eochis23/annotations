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
sudo cp -a "$SRC/extension.js" "$SRC/kateTracker.js" "$SRC/metadata.json" "$SRC/stylesheet.css" "$DEST/"

sudo mkdir -p "$MP/etc/dconf/db/local.d"
sudo tee "$MP/etc/dconf/db/local.d/99-annotation-extension" >/dev/null <<'EOF'
# Annotations project: enable the annotation dock extension by default.
# If you already use enabled-extensions in another fragment, merge this UUID there.
[org/gnome/shell]
enabled-extensions=['annotation@annotations.local']

# Qt applications (Kate in particular) only expose their AT-SPI accessibility
# tree when the GNOME toolkit-accessibility flag is on. Without this the
# KateTrackerManager tree walk finds 0 TEXT nodes inside Kate and
# scroll-following annotations silently do nothing. Enabling it here is
# necessary for the annotation extension's AT-SPI features to work; GNOME
# apps remain unaffected because they populate the tree regardless.
[org/gnome/desktop/interface]
toolkit-accessibility=true
EOF

sudo mkdir -p "$MP/etc/dconf/db/gdm.d"
sudo tee "$MP/etc/dconf/db/gdm.d/99-annotation-extension" >/dev/null <<'EOF'
# Same extension list for GDM greeter shell (pen crash fix needs compositor + extension in sync).
[org/gnome/shell]
enabled-extensions=['annotation@annotations.local']
EOF

# Fresh Endeavour/Arch targets ship without /etc/dconf/profile/user, so the
# compiled system-db 'local' above is orphaned (no profile references it)
# and our toolkit-accessibility / enabled-extensions fragment silently has
# zero effect at the user session. Create a minimal profile that chains
# the local system db under the user's personal db. We only write the file
# when it's absent so a distro- or admin-provided profile isn't overwritten.
if [[ ! -f "$MP/etc/dconf/profile/user" ]]; then
	sudo mkdir -p "$MP/etc/dconf/profile"
	sudo tee "$MP/etc/dconf/profile/user" >/dev/null <<'EOF'
# Chain system-wide dconf defaults (annotation extension enablement,
# toolkit-accessibility) underneath the user's personal database.
user-db:user
system-db:local
EOF
fi

# Qt's AT-SPI bridge activation is gated on the toolkit-accessibility
# gsetting, but also honors the QT_ACCESSIBILITY env var as an explicit
# override. Dropping it in /etc/environment.d/ guarantees the bridge is
# on for every Qt/KDE app (incl. Kate) regardless of gsetting state.
# Necessary for KateTrackerManager to find the editor TEXT accessible.
sudo mkdir -p "$MP/etc/environment.d"
sudo tee "$MP/etc/environment.d/98-annotation-qt-a11y.conf" >/dev/null <<'EOF'
QT_ACCESSIBILITY=1
EOF

sudo arch-chroot "$MP" /bin/bash -lc 'command -v dconf >/dev/null 2>&1 && dconf update || true'

echo "Installed $UUID under $DEST and refreshed dconf in chroot (if dconf is available)."

# GNOME Shell loads ~/.local/share/gnome-shell/extensions/<uuid> BEFORE /usr/share/.../extensions/<uuid>.
# A stale user copy causes: "already installed in … (user). … /usr/share/… will not be loaded"
# and you run old extension code (no SetActive retries, broken stylesheet import, etc.).
if [[ -d "$MP" ]] && compgen -G "$MP/home/*/.local/share/gnome-shell/extensions/${UUID}" >/dev/null 2>&1; then
	echo ""
	echo "WARNING: Per-user copy of ${UUID} found under ${MP}/home/*/.local/share/gnome-shell/extensions/"
	echo "         Shell will IGNORE the system copy at ${DEST} until the user copy is removed."
	echo "         On the installed OS, run (as that user):"
	echo "           rm -rf ~/.local/share/gnome-shell/extensions/${UUID}"
	echo "         Then log out and back in (or reboot)."
	echo ""
fi
if [[ "${ANNOTATION_CHROOT_REMOVE_USER_SHADOW_EXT:-0}" == "1" ]] && compgen -G "$MP/home/*/.local/share/gnome-shell/extensions/${UUID}" >/dev/null 2>&1; then
	echo "ANNOTATION_CHROOT_REMOVE_USER_SHADOW_EXT=1: removing user shadow copies..."
	find "$MP/home" -path "*/.local/share/gnome-shell/extensions/${UUID}" -type d -prune -exec sudo rm -rf {} +
fi
