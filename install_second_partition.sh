#!/bin/bash
set -euo pipefail
# Mount the second partition (same settings as compile_target*.sh) and run install.sh
# inside arch-chroot so CHROOT_REPO_DIR becomes a full git checkout—no SSH keys needed
# when INSTALL_GIT_REMOTE / origin resolves to HTTPS.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_CONFIG="$SCRIPT_DIR/compile_target.local.sh"
GIT_URL_HELPER="$SCRIPT_DIR/scripts/annotations-git-url.sh"

if [ ! -f "$LOCAL_CONFIG" ]; then
	echo "Error: Missing $LOCAL_CONFIG. Copy compile_target.local.example to compile_target.local.sh."
	exit 1
fi
# shellcheck source=compile_target.local.example
. "$LOCAL_CONFIG"
# shellcheck source=scripts/annotations-git-url.sh
. "$GIT_URL_HELPER"

: "${MOUNT_POINT:?Set MOUNT_POINT in compile_target.local.sh}"
: "${CHROOT_REPO_DIR:?Set CHROOT_REPO_DIR in compile_target.local.sh}"

GIT_REMOTE_NAME="${GIT_REMOTE_NAME:-origin}"

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
cleanup() {
	if [ "$WE_MOUNTED" -eq 1 ]; then
		echo "Unmounting $MOUNT_POINT..."
		sudo umount "$MOUNT_POINT"
	fi
}

if [ -z "$PARTITION_DEVICE" ] || [ ! -b "$PARTITION_DEVICE" ]; then
	echo "Error: Could not resolve block device (got: ${PARTITION_DEVICE:-empty})."
	exit 1
fi

if ! mountpoint -q "$MOUNT_POINT"; then
	echo "Mounting $PARTITION_DEVICE to $MOUNT_POINT..."
	sudo mkdir -p "$MOUNT_POINT"
	sudo mount "$PARTITION_DEVICE" "$MOUNT_POINT"
	WE_MOUNTED=1
fi

trap cleanup EXIT

if ! command -v arch-chroot >/dev/null 2>&1; then
	echo "Error: arch-chroot not found. Install: sudo pacman -S arch-install-scripts"
	exit 1
fi

REPO_HOST="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
BRANCH="${OVERRIDE_BRANCH:-}"
if [[ -z "$BRANCH" && -n "$REPO_HOST" ]]; then
	BRANCH="$(git -C "$REPO_HOST" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi
if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
	: "${INSTALL_BRANCH:?Set INSTALL_BRANCH (or OVERRIDE_BRANCH) when the host tree is not on a named branch.}"
	BRANCH="$INSTALL_BRANCH"
fi

if [[ -n "$REPO_HOST" ]] && git -C "$REPO_HOST" remote get-url "$GIT_REMOTE_NAME" >/dev/null 2>&1; then
	REMOTE="$(annotations_https_fetch_url "$(git -C "$REPO_HOST" remote get-url "$GIT_REMOTE_NAME")")"
else
	: "${INSTALL_GIT_REMOTE:?Set INSTALL_GIT_REMOTE (HTTPS URL) when the host tree is not a git clone with $GIT_REMOTE_NAME.}"
	REMOTE="$(annotations_https_fetch_url "$INSTALL_GIT_REMOTE")"
fi

if [[ -f /etc/resolv.conf ]]; then
	sudo cp /etc/resolv.conf "$MOUNT_POINT/etc/resolv.conf" 2>/dev/null || true
fi

echo "--- Ensuring git in chroot ---"
sudo arch-chroot "$MOUNT_POINT" /bin/bash -lc 'command -v git >/dev/null 2>&1 || pacman -S --needed --noconfirm git'

sudo mkdir -p "$MOUNT_POINT/mnt/build"
sudo cp "$SCRIPT_DIR/install.sh" "$MOUNT_POINT/mnt/build/annotations-install.sh"
sudo cp "$GIT_URL_HELPER" "$MOUNT_POINT/mnt/build/annotations-git-url.sh"
sudo chmod +x "$MOUNT_POINT/mnt/build/annotations-install.sh"

echo "--- Running install.sh in chroot ($CHROOT_REPO_DIR, branch $BRANCH) ---"
sudo arch-chroot "$MOUNT_POINT" /usr/bin/env GIT_TERMINAL_PROMPT=0 /bin/bash /mnt/build/annotations-install.sh \
	--destination "$CHROOT_REPO_DIR" \
	--remote "$REMOTE" \
	--branch "$BRANCH"

echo "Done. Git checkout on target: $CHROOT_REPO_DIR (branch $BRANCH)."
