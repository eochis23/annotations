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

# #region agent log
_agent_log_path='/home/eochis/Projects/annotations/.cursor/debug-da8410.log'
_agent_log() {
	local loc="$1"; shift
	local msg="$1"; shift
	local data_json="${1:-{\}}"
	mkdir -p "$(dirname "$_agent_log_path")" 2>/dev/null || true
	printf '{"sessionId":"da8410","runId":"install","hypothesisId":"H1","location":"%s","message":"%s","data":%s,"timestamp":%s}\n' \
		"$loc" "$msg" "$data_json" "$(date +%s%3N)" >> "$_agent_log_path" 2>/dev/null || true
}
_agent_json_list() { # Emit JSON array of filenames in a dir (basename-only), sorted.
	local dir="$1"
	if [[ ! -d "$dir" ]]; then
		printf '[]'
		return
	fi
	local first=1
	printf '['
	while IFS= read -r -d '' f; do
		local bn
		bn=$(basename "$f")
		if [[ $first -eq 1 ]]; then first=0; else printf ','; fi
		printf '"%s"' "${bn//\"/\\\"}"
	done < <(find "$dir" -maxdepth 1 -type f -print0 | sort -z)
	printf ']'
}
# #endregion

if [[ ! -f "$SRC/metadata.json" ]]; then
	echo "Error: missing $SRC/metadata.json"
	exit 1
fi

# #region agent log
_agent_log "install-annotation-extension-chroot.sh:pre-copy" \
	"source files at SRC before cp" \
	"{\"src\":\"$SRC\",\"files\":$(_agent_json_list "$SRC"),\"kateTracker_src_exists\":$([[ -f "$SRC/kateTracker.js" ]] && echo true || echo false)}"
# #endregion

sudo mkdir -p "$DEST"
sudo cp -a "$SRC/extension.js" "$SRC/kateTracker.js" "$SRC/metadata.json" "$SRC/stylesheet.css" "$DEST/"

# #region agent log
_agent_log "install-annotation-extension-chroot.sh:post-copy" \
	"destination files after cp" \
	"{\"dest\":\"$DEST\",\"files\":$(_agent_json_list "$DEST"),\"kateTracker_dest_exists\":$([[ -f "$DEST/kateTracker.js" ]] && echo true || echo false)}"
# #endregion

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
