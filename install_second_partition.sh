#!/bin/bash
set -euo pipefail
# Mount the second partition (same settings as compile_target*.sh), run install.sh in
# arch-chroot to sync the repo at CHROOT_REPO_DIR, then install build deps and compile
# Mutter (and optionally GNOME Shell) with meson/ninja—same outcome as compile_target_chroot_git.sh
# without host git commit/push.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_CONFIG="$SCRIPT_DIR/compile_target.local.sh"
GIT_URL_HELPER="$SCRIPT_DIR/scripts/annotations-git-url.sh"
LIST_MUTTER_MAKEDEPENDS="$SCRIPT_DIR/scripts/list-mutter-makedepends.sh"
CHROOT_BUILD_REQUIREMENTS="${CHROOT_BUILD_REQUIREMENTS:-$SCRIPT_DIR/scripts/chroot-build-requirements.txt}"

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

BUILD_TARGETS="${BUILD_TARGETS:-mutter}"
BUILD_TARGETS="${BUILD_TARGETS,,}"
if [[ "$BUILD_TARGETS" != *mutter* ]]; then
	echo "Error: BUILD_TARGETS must include mutter (got: $BUILD_TARGETS)"
	exit 1
fi

: "${CHROOT_MUTTER_MESON_SETUP_EXTRA:=-Dtests=disabled}"
: "${CHROOT_SHELL_MESON_SETUP_EXTRA:=-Dtests=false}"

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
		# sudo umount "$MOUNT_POINT"
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

sudo mkdir -p "$MOUNT_POINT/mnt/build"
sudo cp "$LIST_MUTTER_MAKEDEPENDS" "$MOUNT_POINT/mnt/build/list-mutter-makedepends.sh"
sudo chmod +x "$MOUNT_POINT/mnt/build/list-mutter-makedepends.sh"
if [[ -f "$CHROOT_BUILD_REQUIREMENTS" ]]; then
	sudo cp "$CHROOT_BUILD_REQUIREMENTS" "$MOUNT_POINT/mnt/build/chroot-build-requirements.txt"
fi
sudo cp "$SCRIPT_DIR/install.sh" "$MOUNT_POINT/mnt/build/annotations-install.sh"
sudo cp "$GIT_URL_HELPER" "$MOUNT_POINT/mnt/build/annotations-git-url.sh"
sudo chmod +x "$MOUNT_POINT/mnt/build/annotations-install.sh"

echo "--- Installing build dependencies in chroot (install.sh --install-chroot-build-deps) ---"
sudo arch-chroot "$MOUNT_POINT" /usr/bin/env CHROOT_PACMAN_SYNC="${CHROOT_PACMAN_SYNC:-0}" \
	/bin/bash /mnt/build/annotations-install.sh --install-chroot-build-deps --yes

echo "--- Running install.sh (git) in chroot ($CHROOT_REPO_DIR, branch $BRANCH) ---"
sudo arch-chroot "$MOUNT_POINT" /usr/bin/env GIT_TERMINAL_PROMPT=0 /bin/bash /mnt/build/annotations-install.sh \
	--destination "$CHROOT_REPO_DIR" \
	--remote "$REMOTE" \
	--branch "$BRANCH"

if [[ ! -f "$MOUNT_POINT/${CHROOT_REPO_DIR#/}/mutter/meson.build" ]]; then
	echo "Error: mutter/meson.build missing under $CHROOT_REPO_DIR after install.sh."
	exit 1
fi
if [[ "$BUILD_TARGETS" == *shell* ]] && [[ ! -f "$MOUNT_POINT/${CHROOT_REPO_DIR#/}/gnome-shell/meson.build" ]]; then
	echo "Error: gnome-shell/meson.build missing under $CHROOT_REPO_DIR after install.sh."
	exit 1
fi

echo "--- Configuring & building in chroot (targets: $BUILD_TARGETS) ---"
sudo arch-chroot "$MOUNT_POINT" \
	env BUILD_TARGETS="$BUILD_TARGETS" CHROOT_REPO_DIR="$CHROOT_REPO_DIR" \
	CHROOT_MUTTER_MESON_SETUP_EXTRA="${CHROOT_MUTTER_MESON_SETUP_EXTRA}" \
	CHROOT_SHELL_MESON_SETUP_EXTRA="${CHROOT_SHELL_MESON_SETUP_EXTRA}" \
	/bin/bash <<'CHROOT_BUILD'
set -euo pipefail
repo_dir="${CHROOT_REPO_DIR:?}"

# Abort the install if any freshly-built libmutter*.so in build/ is tiny/empty
# (e.g. linker killed by OOM). Without this, `ninja install` will happily copy
# 0-byte stubs over the system libraries and leave the target unbootable.
check_built_libs() {
	local build_dir="$1"
	local bad=""
	# Only consider real ELF shared objects: basename must end in .so or .so[.<digits>]*
	# (meson also generates text artifacts like libmutter-mtk-18.so.0.0.0.symbols that
	# we must skip — they're tiny by design.)
	while IFS= read -r -d '' f; do
		[[ -L "$f" ]] && continue
		local bn
		bn=$(basename "$f")
		[[ "$bn" =~ ^lib(mutter|cogl|clutter)[^/]*\.so(\.[0-9]+)*$ ]] || continue
		local sz
		sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
		if [[ "$sz" -lt 8192 ]]; then
			echo "Error: built lib is tiny/empty (${sz} bytes): $f" >&2
			bad=1
		fi
	done < <(find "$build_dir" -type f \( -name 'libmutter*.so*' -o -name 'libcogl*.so*' -o -name 'libclutter*.so*' \) -print0 2>/dev/null || true)
	[[ -z "$bad" ]]
}

cd "$repo_dir/mutter"
rm -rf build
meson setup build --prefix=/usr ${CHROOT_MUTTER_MESON_SETUP_EXTRA}
ninja -C build
check_built_libs "$repo_dir/mutter/build" || { echo "Aborting before ninja install: mutter build produced empty shared libraries." >&2; exit 1; }
ninja -C build install
if [[ "${BUILD_TARGETS:-mutter}" == *shell* ]]; then
	cd "$repo_dir/gnome-shell"
	rm -rf build
	meson setup build --prefix=/usr ${CHROOT_SHELL_MESON_SETUP_EXTRA}
	ninja -C build
	ninja -C build install
fi
CHROOT_BUILD

bash "$SCRIPT_DIR/scripts/verify-mutter-install.sh" "$MOUNT_POINT"

echo "--- Updating target caches (chroot) ---"
sudo arch-chroot "$MOUNT_POINT" /bin/bash -lc 'ldconfig; glib-compile-schemas /usr/share/glib-2.0/schemas/ 2>/dev/null || true'

echo "--- Installing annotation shell extension (chroot) ---"
bash "$SCRIPT_DIR/scripts/install-annotation-extension-chroot.sh" "$MOUNT_POINT"

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

echo "Success! Repo at $CHROOT_REPO_DIR (branch $BRANCH); built and installed under $MOUNT_POINT/usr (targets: $BUILD_TARGETS)."
