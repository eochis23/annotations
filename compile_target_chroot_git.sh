#!/bin/bash
set -euo pipefail
# Run with an absolute path, e.g. /home/you/Projects/annotations/compile_target_chroot_git.sh
#
# Workflow: on the host, optionally commit and always push the current branch of this git
# repository; mount the second partition; inside arch-chroot, update a clone of the same
# repo at CHROOT_REPO_DIR and build Mutter (and optionally GNOME Shell) with meson/ninja so
# the result matches the target OS.
#
# Prerequisites / caveats:
# - Run from a checkout of the repo (mutter/ and gnome-shell/ live under the repo root).
# - Target root must be writable and large enough for clone + build artifacts.
# - Network works in chroot like the host; for SSH remotes, set SSH_BIND=1 and bind-mount
#   host keys (see compile_target.local.example) so git fetch inside chroot can authenticate.
# - Detached HEAD is refused unless you set OVERRIDE_BRANCH in compile_target.local.sh.
# - Push runs on the host before any mount/chroot; if push fails, the script exits and does
#   not touch the target partition.
# - If the working tree is dirty, you must pass --commit -m "message" (no silent git add).
# - GIT_REMOTE_NAME (default origin) must exist on the host; its URL is what the chroot uses
#   for fetch (remote inside the clone is always named origin).

# ==========================================
# 1. Arguments & configuration
# ==========================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_CONFIG="$SCRIPT_DIR/compile_target.local.sh"
LIST_MUTTER_MAKEDEPENDS="$SCRIPT_DIR/scripts/list-mutter-makedepends.sh"

DO_COMMIT=0
COMMIT_MSG=""
while [[ $# -gt 0 ]]; do
	case "$1" in
	--commit)
		DO_COMMIT=1
		shift
		;;
	-m | --message)
		COMMIT_MSG="${2:?Missing value for $1}"
		shift 2
		;;
	*)
		echo "Unknown option: $1"
		echo "Usage: $0 [--commit] [-m|--message \"commit message\"]"
		echo "  If the repo is dirty, --commit and -m are required."
		exit 1
		;;
	esac
done

if [ ! -f "$LOCAL_CONFIG" ]; then
	echo "Error: Missing $LOCAL_CONFIG. Copy compile_target.local.example to compile_target.local.sh and set paths."
	exit 1
fi
# shellcheck source=compile_target.local.example
. "$LOCAL_CONFIG"

: "${MOUNT_POINT:?Set MOUNT_POINT in compile_target.local.sh}"
: "${CHROOT_REPO_DIR:?Set CHROOT_REPO_DIR in compile_target.local.sh (path inside chroot, e.g. /mnt/build/annotations)}"

BUILD_TARGETS="${BUILD_TARGETS:-mutter}"
BUILD_TARGETS="${BUILD_TARGETS,,}"

if [[ "$BUILD_TARGETS" != *mutter* ]]; then
	echo "Error: BUILD_TARGETS must include mutter (got: $BUILD_TARGETS)"
	exit 1
fi

GIT_REMOTE_NAME="${GIT_REMOTE_NAME:-origin}"

# Block device resolution (same logic as compile_target.sh)
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
CHROOT_BIND_SSH=0

chroot_cleanup_binds() {
	if [[ "$CHROOT_BIND_SSH" -eq 1 ]]; then
		sudo umount "$MOUNT_POINT/root/.ssh" 2>/dev/null || true
		CHROOT_BIND_SSH=0
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
# 2. Host: git repository, branch, commit, push
# ==========================================
if ! command -v git >/dev/null 2>&1; then
	echo "Error: git not found on host."
	exit 1
fi

REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" || {
	echo "Error: $SCRIPT_DIR is not inside a git repository."
	exit 1
}

cd "$REPO_ROOT"

if [[ -n "${OVERRIDE_BRANCH:-}" ]]; then
	BRANCH="$OVERRIDE_BRANCH"
else
	BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || true
	if [[ "$BRANCH" == "HEAD" || -z "$BRANCH" ]]; then
		echo "Error: detached HEAD. Check out a branch or set OVERRIDE_BRANCH in compile_target.local.sh."
		exit 1
	fi
fi

if ! git remote get-url "$GIT_REMOTE_NAME" >/dev/null 2>&1; then
	echo "Error: git remote \"$GIT_REMOTE_NAME\" is not defined."
	exit 1
fi
GIT_REMOTE_URL="$(git remote get-url "$GIT_REMOTE_NAME")"

if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
	if [[ "$DO_COMMIT" -ne 1 || -z "$COMMIT_MSG" ]]; then
		echo "Error: working tree has uncommitted changes. Commit manually, or re-run with:"
		echo "  $0 --commit -m \"your message\""
		exit 1
	fi
	echo "--- git add / commit (host) ---"
	git add -A
	if git diff --cached --quiet; then
		echo "Nothing staged to commit after git add -A; continuing."
	else
		git commit -m "$COMMIT_MSG"
	fi
else
	if [[ "$DO_COMMIT" -eq 1 ]]; then
		echo "Note: working tree clean; skipping commit."
	fi
fi

echo "--- git push $GIT_REMOTE_NAME $BRANCH (host) ---"
git push -u "$GIT_REMOTE_NAME" "$BRANCH"

# ==========================================
# 3. Mount target root
# ==========================================
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

# Optional: SSH keys for git over SSH inside chroot
if [[ "${SSH_BIND:-0}" == "1" ]]; then
	HOST_SSH_DIR="${HOST_SSH_DIR:-$HOME/.ssh}"
	if [[ ! -d "$HOST_SSH_DIR" ]]; then
		echo "Error: SSH_BIND=1 but HOST_SSH_DIR is not a directory: $HOST_SSH_DIR"
		exit 1
	fi
	sudo mkdir -p "$MOUNT_POINT/root"
	if mountpoint -q "$MOUNT_POINT/root/.ssh"; then
		echo "Note: $MOUNT_POINT/root/.ssh already a mountpoint; leaving as-is."
	else
		sudo mount --bind "$HOST_SSH_DIR" "$MOUNT_POINT/root/.ssh"
		CHROOT_BIND_SSH=1
	fi
fi

echo "--- Preparing chroot build dir ---"
sudo mkdir -p "$MOUNT_POINT/mnt/build"
sudo cp "$LIST_MUTTER_MAKEDEPENDS" "$MOUNT_POINT/mnt/build/list-mutter-makedepends.sh"
sudo chmod +x "$MOUNT_POINT/mnt/build/list-mutter-makedepends.sh"

if [[ -f /etc/resolv.conf ]]; then
	sudo cp /etc/resolv.conf "$MOUNT_POINT/etc/resolv.conf" 2>/dev/null || true
fi

if [[ "${CHROOT_PACMAN_SYNC:-0}" == "1" ]]; then
	echo "--- pacman -Sy (CHROOT_PACMAN_SYNC=1) ---"
	sudo arch-chroot "$MOUNT_POINT" /bin/bash -lc 'pacman -Sy --noconfirm'
fi

echo "--- Installing build dependencies in chroot ---"
sudo arch-chroot "$MOUNT_POINT" /bin/bash <<'CHROOT_PKGS'
set -euo pipefail
extra=$(pacman -Si mutter | bash /mnt/build/list-mutter-makedepends.sh | xargs)
pacman -S --needed --noconfirm base-devel meson ninja git ${extra:-}
CHROOT_PKGS

# ==========================================
# 4. Chroot: clone or update repo, build
# ==========================================
echo "--- Syncing repository inside chroot ($CHROOT_REPO_DIR, branch $BRANCH) ---"
sudo arch-chroot "$MOUNT_POINT" \
	env \
	CHROOT_REPO_DIR="$CHROOT_REPO_DIR" \
	BRANCH="$BRANCH" \
	GIT_REMOTE_URL="$GIT_REMOTE_URL" \
	GIT_CLONE_DEPTH="${GIT_CLONE_DEPTH:-}" \
	BUILD_TARGETS="$BUILD_TARGETS" \
	/bin/bash <<'CHROOT_GIT'
set -euo pipefail
repo_dir="${CHROOT_REPO_DIR:?}"
branch="${BRANCH:?}"
url="${GIT_REMOTE_URL:?}"
depth="${GIT_CLONE_DEPTH:-}"

if [[ ! -d "$repo_dir/.git" ]]; then
	mkdir -p "$(dirname "$repo_dir")"
	if [[ -n "$depth" ]]; then
		git clone --depth "$depth" --branch "$branch" "$url" "$repo_dir"
	else
		git clone "$url" "$repo_dir"
		cd "$repo_dir"
		git checkout "$branch"
	fi
else
	cd "$repo_dir"
	if git remote get-url origin >/dev/null 2>&1; then
		git remote set-url origin "$url"
	else
		git remote add origin "$url"
	fi
	git fetch origin
	git checkout "$branch"
	git reset --hard "origin/$branch"
fi

cd "$repo_dir"
if [[ ! -f mutter/meson.build ]]; then
	echo "Error: mutter/meson.build missing after sync."
	exit 1
fi
if [[ "${BUILD_TARGETS:-mutter}" == *shell* ]] && [[ ! -f gnome-shell/meson.build ]]; then
	echo "Error: gnome-shell/meson.build missing after sync."
	exit 1
fi
CHROOT_GIT

sudo arch-chroot "$MOUNT_POINT" \
	env BUILD_TARGETS="$BUILD_TARGETS" CHROOT_REPO_DIR="$CHROOT_REPO_DIR" \
	/bin/bash <<'CHROOT_BUILD'
set -euo pipefail
repo_dir="${CHROOT_REPO_DIR:?}"
cd "$repo_dir/mutter"
rm -rf build
meson setup build --prefix=/usr
ninja -C build
ninja -C build install
if [[ "${BUILD_TARGETS:-mutter}" == *shell* ]]; then
	cd "$repo_dir/gnome-shell"
	rm -rf build
	meson setup build --prefix=/usr
	ninja -C build
	ninja -C build install
fi
CHROOT_BUILD

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
