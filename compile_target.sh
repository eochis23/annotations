#!/bin/bash
set -euo pipefail
# Run with an absolute path, e.g. /home/eochis/Projects/annotations/compile_target.sh
# (A path like ./home/... is wrong: it looks for ./home relative to the current directory.)
#
# Builds Mutter (and optionally GNOME Shell) with meson/ninja *inside* the mounted target
# root via arch-chroot, so libraries and toolchain match the OS that will run them.

# ==========================================
# 1. Configuration
# ==========================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_CONFIG="$SCRIPT_DIR/compile_target.local.sh"
LIST_MUTTER_MAKEDEPENDS="$SCRIPT_DIR/scripts/list-mutter-makedepends.sh"
CHROOT_BUILD_REQUIREMENTS="${CHROOT_BUILD_REQUIREMENTS:-$SCRIPT_DIR/scripts/chroot-build-requirements.txt}"
ANNOTATIONS_GIT_URL_HELPER="$SCRIPT_DIR/scripts/annotations-git-url.sh"

if [ ! -f "$LOCAL_CONFIG" ]; then
	echo "Error: Missing $LOCAL_CONFIG. Copy compile_target.local.example to compile_target.local.sh and set paths."
	exit 1
fi
# shellcheck source=compile_target.local.example
. "$LOCAL_CONFIG"

: "${MUTTER_SRC:?Set MUTTER_SRC in compile_target.local.sh}"
: "${MOUNT_POINT:?Set MOUNT_POINT in compile_target.local.sh}"

BUILD_TARGETS="${BUILD_TARGETS:-mutter}"
BUILD_TARGETS="${BUILD_TARGETS,,}"

if [[ "$BUILD_TARGETS" != *mutter* ]]; then
	echo "Error: BUILD_TARGETS must include mutter (got: $BUILD_TARGETS)"
	exit 1
fi
if [[ "$BUILD_TARGETS" == *shell* ]]; then
	: "${SHELL_SRC:?Set SHELL_SRC in compile_target.local.sh when BUILD_TARGETS includes shell}"
fi

# Chroot meson: disable test suites by default (avoids python-dbusmock, extra gtk3, etc.).
: "${CHROOT_MUTTER_MESON_SETUP_EXTRA:=-Dtests=disabled}"
: "${CHROOT_SHELL_MESON_SETUP_EXTRA:=-Dtests=false}"

# Block device: prefer PARTITION_DEVICE or PARTITION_PARTUUID when two copies share LABEL.
if [[ -z "${PARTITION_DEVICE:-}" && -z "${PARTITION_PARTUUID:-}" && -z "${PARTITION_FS_LABEL:-}" ]]; then
	echo "Error: Set one of PARTITION_DEVICE, PARTITION_PARTUUID, or PARTITION_FS_LABEL in compile_target.local.sh"
	exit 1
fi
if [[ -n "${PARTITION_DEVICE:-}" && -b "$PARTITION_DEVICE" ]]; then
	PARTITION_DEVICE=$(readlink -f "$PARTITION_DEVICE")
elif [[ -n "${PARTITION_PARTUUID:-}" ]]; then
	PARTITION_DEVICE=$(readlink -f "/dev/disk/by-partuuid/${PARTITION_PARTUUID}" 2>/dev/null || true)
elif [[ -n "${PARTITION_FS_LABEL:-}" ]]; then
	PARTITION_DEVICE=$(readlink -f "/dev/disk/by-label/${PARTITION_FS_LABEL}" 2>/dev/null || true)
else
	PARTITION_DEVICE=""
fi

WE_MOUNTED=0
CHROOT_BIND_MUTTER=0
CHROOT_BIND_SHELL=0

chroot_cleanup_binds() {
	if [[ "$CHROOT_BIND_SHELL" -eq 1 ]]; then
		sudo umount "$MOUNT_POINT/mnt/build/gnome-shell" 2>/dev/null || true
		CHROOT_BIND_SHELL=0
	fi
	if [[ "$CHROOT_BIND_MUTTER" -eq 1 ]]; then
		sudo umount "$MOUNT_POINT/mnt/build/mutter" 2>/dev/null || true
		CHROOT_BIND_MUTTER=0
	fi
}

cleanup() {
	chroot_cleanup_binds
	if [ "$WE_MOUNTED" -eq 1 ]; then
		echo "Unmounting $MOUNT_POINT..."
		sudo umount "$MOUNT_POINT"
	fi
}

# ==========================================
# 2. Pre-Build Cleanup (host-side build dirs)
# ==========================================
echo "--- Cleaning old build directories (host trees) ---"
rm -rf "$MUTTER_SRC/build"
[[ -n "${SHELL_SRC:-}" ]] && rm -rf "$SHELL_SRC/build"
echo "Cleanup complete."

# ==========================================
# 3. Mount target root
# ==========================================
if [ -z "$PARTITION_DEVICE" ] || [ ! -b "$PARTITION_DEVICE" ]; then
	echo "Error: Could not resolve block device (got: ${PARTITION_DEVICE:-empty})."
	echo "If two installs share LABEL=, set PARTITION_PARTUUID or PARTITION_DEVICE in compile_target.local.sh."
	exit 1
fi

if ! mountpoint -q "$MOUNT_POINT"; then
	echo "Mounting $PARTITION_DEVICE to $MOUNT_POINT..."
	sudo mkdir -p "$MOUNT_POINT"
	sudo mount "$PARTITION_DEVICE" "$MOUNT_POINT"
	WE_MOUNTED=1
fi

trap cleanup EXIT

# ==========================================
# 4. Chroot build (arch-chroot + bind-mounted sources)
# ==========================================
if ! command -v arch-chroot >/dev/null 2>&1; then
	echo "Error: arch-chroot not found. Install: sudo pacman -S arch-install-scripts"
	exit 1
fi

echo "--- Building inside $MOUNT_POINT (target toolchain via arch-chroot) ---"
sudo mkdir -p "$MOUNT_POINT/mnt/build/mutter" "$MOUNT_POINT/mnt/build"
sudo cp "$LIST_MUTTER_MAKEDEPENDS" "$MOUNT_POINT/mnt/build/list-mutter-makedepends.sh"
sudo chmod +x "$MOUNT_POINT/mnt/build/list-mutter-makedepends.sh"
if [[ -f "$CHROOT_BUILD_REQUIREMENTS" ]]; then
	sudo cp "$CHROOT_BUILD_REQUIREMENTS" "$MOUNT_POINT/mnt/build/chroot-build-requirements.txt"
fi
sudo cp "$SCRIPT_DIR/install.sh" "$MOUNT_POINT/mnt/build/annotations-install.sh"
sudo cp "$ANNOTATIONS_GIT_URL_HELPER" "$MOUNT_POINT/mnt/build/annotations-git-url.sh"
sudo chmod +x "$MOUNT_POINT/mnt/build/annotations-install.sh"

sudo mount --bind "$MUTTER_SRC" "$MOUNT_POINT/mnt/build/mutter"
CHROOT_BIND_MUTTER=1

if [[ "$BUILD_TARGETS" == *shell* ]]; then
	sudo mkdir -p "$MOUNT_POINT/mnt/build/gnome-shell"
	sudo mount --bind "$SHELL_SRC" "$MOUNT_POINT/mnt/build/gnome-shell"
	CHROOT_BIND_SHELL=1
fi

if [[ ! -f "$MOUNT_POINT/mnt/build/mutter/meson.build" ]]; then
	echo "Error: meson.build missing under bind-mounted Mutter source."
	exit 1
fi

if [[ "$BUILD_TARGETS" == *shell* ]] && [[ ! -f "$MOUNT_POINT/mnt/build/gnome-shell/meson.build" ]]; then
	echo "Error: meson.build missing under bind-mounted GNOME Shell source."
	exit 1
fi

# DNS for pacman inside chroot (best-effort)
if [[ -f /etc/resolv.conf ]]; then
	sudo cp /etc/resolv.conf "$MOUNT_POINT/etc/resolv.conf" 2>/dev/null || true
fi

echo "--- Installing build dependencies in chroot (install.sh --install-chroot-build-deps) ---"
sudo arch-chroot "$MOUNT_POINT" /usr/bin/env CHROOT_PACMAN_SYNC="${CHROOT_PACMAN_SYNC:-0}" \
	/bin/bash /mnt/build/annotations-install.sh --install-chroot-build-deps --yes

echo "--- Configuring & building Mutter in chroot ---"
sudo arch-chroot "$MOUNT_POINT" /bin/bash -lc "
set -euo pipefail
cd /mnt/build/mutter
rm -rf build
meson setup build --prefix=/usr ${CHROOT_MUTTER_MESON_SETUP_EXTRA}
ninja -C build
ninja -C build install
"

bash "$SCRIPT_DIR/scripts/verify-mutter-install.sh" "$MOUNT_POINT"

if [[ "$BUILD_TARGETS" == *shell* ]]; then
	echo "--- Configuring & building GNOME Shell in chroot ---"
	sudo arch-chroot "$MOUNT_POINT" /bin/bash -lc "
set -euo pipefail
cd /mnt/build/gnome-shell
rm -rf build
meson setup build --prefix=/usr ${CHROOT_SHELL_MESON_SETUP_EXTRA}
ninja -C build
ninja -C build install
"
fi

echo "--- Updating target caches (chroot) ---"
sudo arch-chroot "$MOUNT_POINT" /bin/bash -lc 'ldconfig; glib-compile-schemas /usr/share/glib-2.0/schemas/ 2>/dev/null || true'

echo "--- Verifying key libraries in chroot (ldd) ---"
set +e
if [[ "$BUILD_TARGETS" == *shell* ]] && [[ -f "$MOUNT_POINT/usr/bin/gnome-shell" ]]; then
	ldd_out=$(sudo arch-chroot "$MOUNT_POINT" /usr/bin/ldd /usr/bin/gnome-shell 2>&1)
	ldd_ec=$?
	if [[ $ldd_ec -ne 0 ]]; then
		echo "WARNING: ldd /usr/bin/gnome-shell failed (exit $ldd_ec)"
		echo "$ldd_out" | tail -20
	else
		echo "ldd /usr/bin/gnome-shell: OK"
	fi
else
	m_so=$(find "$MOUNT_POINT/usr/lib" -maxdepth 3 -name 'libmutter-*.so.0' 2>/dev/null | head -1)
	if [[ -n "$m_so" ]]; then
		rel=${m_so#"$MOUNT_POINT"}
		ldd_out=$(sudo arch-chroot "$MOUNT_POINT" /usr/bin/ldd "$rel" 2>&1)
		ldd_ec=$?
		if [[ $ldd_ec -ne 0 ]]; then
			echo "WARNING: ldd mutter lib failed (exit $ldd_ec)"
			echo "$ldd_out" | tail -15
		else
			echo "ldd $rel: OK"
		fi
	else
		echo "Note: could not find libmutter-*.so.0 for ldd check."
	fi
fi
set -e

echo "Success! Installed under $MOUNT_POINT/usr (targets: $BUILD_TARGETS)."
