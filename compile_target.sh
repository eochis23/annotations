#!/bin/bash
set -euo pipefail
# Run with an absolute path, e.g. /home/eochis/Projects/annotations/compile_target.sh
# (A path like ./home/... is wrong: it looks for ./home relative to the current directory.)

# ==========================================
# 1. Configuration
# ==========================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_TOOLS_INI="$SCRIPT_DIR/host-tools.ini"
LOCAL_CONFIG="$SCRIPT_DIR/compile_target.local.sh"

if [ ! -f "$LOCAL_CONFIG" ]; then
    echo "Error: Missing $LOCAL_CONFIG. Copy compile_target.local.example to compile_target.local.sh and set paths."
    exit 1
fi
# shellcheck source=compile_target.local.example
. "$LOCAL_CONFIG"

: "${MUTTER_SRC:?Set MUTTER_SRC in compile_target.local.sh}"
: "${SHELL_SRC:?Set SHELL_SRC in compile_target.local.sh}"
: "${MOUNT_POINT:?Set MOUNT_POINT in compile_target.local.sh}"
: "${PARTITION_FS_LABEL:?Set PARTITION_FS_LABEL in compile_target.local.sh}"

PARTITION_DEVICE=$(readlink -f "/dev/disk/by-label/$PARTITION_FS_LABEL" 2>/dev/null || true)

# When 1, PKG_CONFIG_SYSROOT_DIR=$MOUNT_POINT so every pkg-config path is under the
# mount (glibc, glib, gtk, mutter, …). Mixing host GCC with that root's glibc headers
# often breaks GNOME Shell with -Werror=redundant-decls; CFLAGS adds
# -Wno-error=redundant-decls in that mode.
#
# Default 0: host glib/gtk/etc. from /usr; Mutter from the partition. After Mutter
# DESTDIR install, this script rewrites Mutter *.pc prefix from /usr to
# prefix=${pcfiledir}/../.. so -I/-L point at $MOUNT_POINT/usr/... without forcing a
# full sysroot (see fix_mutters_destdir_pc_prefixes).
#
# For a pure sysroot/chroot build, USE_DESTDIR_SYSROOT=1 is appropriate.
USE_DESTDIR_SYSROOT="${USE_DESTDIR_SYSROOT:-0}"

WE_MOUNTED=0

# Function to clean up on exit
cleanup() {
    if [ "$WE_MOUNTED" -eq 1 ]; then
        echo "Unmounting $MOUNT_POINT..."
        sudo umount "$MOUNT_POINT"
    fi
}

# ==========================================
# 2. Pre-Build Cleanup
# ==========================================
echo "--- Cleaning old build directories ---"
rm -rf "$MUTTER_SRC/build"
rm -rf "$SHELL_SRC/build"
echo "Cleanup complete."

# ==========================================
# 3. Mount Logic
# ==========================================
if [ -z "$PARTITION_DEVICE" ] || [ ! -b "$PARTITION_DEVICE" ]; then
    echo "Error: Could not resolve block device for label '$PARTITION_FS_LABEL' (readlink: ${PARTITION_DEVICE:-empty})"
    exit 1
fi

if ! mountpoint -q "$MOUNT_POINT"; then
    echo "Mounting $PARTITION_DEVICE to $MOUNT_POINT..."
    sudo mkdir -p "$MOUNT_POINT"
    sudo mount "$PARTITION_DEVICE" "$MOUNT_POINT"
    WE_MOUNTED=1
fi

# Set the trap to unmount if we mounted this run
trap cleanup EXIT

# ==========================================
# Host tools for Meson (codegen stays on host)
# ==========================================
write_host_tools_ini() {
    cat <<'EOF' > "$HOST_TOOLS_INI"
[binaries]
glib-mkenums = '/usr/bin/glib-mkenums'
glib-genmarshal = '/usr/bin/glib-genmarshal'
gdbus-codegen = '/usr/bin/gdbus-codegen'
glib-compile-resources = '/usr/bin/glib-compile-resources'
glib-compile-schemas = '/usr/bin/glib-compile-schemas'
wayland-scanner = '/usr/bin/wayland-scanner'
g-ir-scanner = '/usr/bin/g-ir-scanner'
g-ir-compiler = '/usr/bin/g-ir-compiler'
g-ir-generate = '/usr/bin/g-ir-generate'
EOF
}

write_host_tools_ini

# Mutter's installed *.pc use prefix=/usr; under PKG_CONFIG_PATH alone, pkg-config
# expands that to host /usr (no headers there when Mutter only exists under DESTDIR).
# Point prefix at the .pc's ../../ (…/usr) so includes/libs resolve on the mount.
fix_mutters_destdir_pc_prefixes() {
    local pc_dir="$MOUNT_POINT/usr/lib/pkgconfig"
    local f
    shopt -s nullglob
    for f in "$pc_dir"/libmutter*.pc "$pc_dir"/mutter-*.pc; do
        if grep -q '^prefix=/usr$' "$f"; then
            # sed -i creates a temp file next to the target; DESTDIR tree is root-owned.
            sudo sed -i '1s#^prefix=/usr$#prefix=${pcfiledir}/../..#' "$f"
        fi
    done
    shopt -u nullglob
}

# ==========================================
# 4. Build & Install Mutter
# ==========================================
echo "--- Building Mutter ---"
cd "$MUTTER_SRC" || { echo "Error: Mutter source not found at $MUTTER_SRC"; exit 1; }

if [ ! -f "meson.build" ]; then
    echo "Error: meson.build is missing. The source code in $MUTTER_SRC appears to be empty."
    exit 1
fi

echo "--- Configuring Mutter (meson setup) ---"
if ! meson setup build --prefix=/usr --native-file "$HOST_TOOLS_INI"; then
    echo "Meson setup failed for Mutter."
    exit 1
fi

echo "--- Compiling Mutter (ninja) ---"
if ! ninja -C build; then
    echo "Ninja compilation failed for Mutter."
    exit 1
fi

echo "--- Installing Mutter to $MOUNT_POINT (DESTDIR) ---"
# With DESTDIR, Meson skips post-install scripts and some versions still return
# non-zero; treat success if the tree was installed (libmutter pkg-config present).
if ! sudo env DESTDIR="$MOUNT_POINT" meson install -C build; then
    if [ -f "$MOUNT_POINT/usr/lib/pkgconfig/libmutter-18.pc" ]; then
        echo "Note: meson install exited non-zero (common when DESTDIR skips install scripts); artifacts look OK, continuing."
    else
        echo "meson install failed for Mutter and libmutter-18.pc is missing under $MOUNT_POINT/usr/lib/pkgconfig."
        exit 1
    fi
fi

if [ "$USE_DESTDIR_SYSROOT" != "1" ]; then
    echo "--- Rewriting Mutter pkg-config prefix for DESTDIR (pcfiledir) ---"
    fix_mutters_destdir_pc_prefixes
fi

# ==========================================
# 5. Build & Install GNOME Shell
# ==========================================
echo "--- Building GNOME Shell ---"
cd "$SHELL_SRC" || { echo "Error: GNOME Shell source not found at $SHELL_SRC"; exit 1; }

if [ ! -f "meson.build" ]; then
    echo "Error: meson.build is missing in $SHELL_SRC."
    exit 1
fi

MUTTER_PC_DIR="$MOUNT_POINT/usr/lib/pkgconfig"
if [ ! -f "$MUTTER_PC_DIR/libmutter-18.pc" ]; then
    echo "Error: libmutter-18.pc not found under $MUTTER_PC_DIR after Mutter install."
    exit 1
fi

# Prefer Mutter from the target partition; keep host fallbacks for other deps.
export PKG_CONFIG_PATH="$MUTTER_PC_DIR:$MOUNT_POINT/usr/share/pkgconfig:${PKG_CONFIG_PATH:-}"

if [ "$USE_DESTDIR_SYSROOT" = "1" ]; then
    export PKG_CONFIG_SYSROOT_DIR="$MOUNT_POINT"
    # Mitigate host-GCC + foreign-root glibc header quirks if you insist on sysroot.
    export CFLAGS="${CFLAGS:+$CFLAGS }-Wno-error=redundant-decls"
else
    unset PKG_CONFIG_SYSROOT_DIR
fi

# We pass the --native-file flag so codegen tools stay on the host
echo "--- Configuring GNOME Shell (meson setup) ---"
if ! meson setup build --prefix=/usr --native-file "$HOST_TOOLS_INI"; then
    echo "Meson setup failed for GNOME Shell."
    exit 1
fi

echo "--- Compiling GNOME Shell (ninja) ---"
if ! ninja -C build; then
    echo "Ninja compilation failed for GNOME Shell."
    exit 1
fi

echo "--- Installing GNOME Shell to $MOUNT_POINT (DESTDIR) ---"
if ! sudo env DESTDIR="$MOUNT_POINT" meson install -C build; then
    if [ -f "$MOUNT_POINT/usr/bin/gnome-shell" ] || [ -d "$MOUNT_POINT/usr/share/gnome-shell" ]; then
        echo "Note: meson install exited non-zero (DESTDIR); GNOME Shell paths found under DESTDIR, continuing."
    else
        echo "meson install failed for GNOME Shell; expected binaries not found under $MOUNT_POINT."
        exit 1
    fi
fi

# ==========================================
# 6. Post-Install Triggers
# ==========================================
echo "--- Updating Target System Cache ---"
sudo ldconfig -r "$MOUNT_POINT"
sudo glib-compile-schemas "$MOUNT_POINT/usr/share/glib-2.0/schemas/"

echo "Success! Mutter and GNOME Shell were built and installed under $MOUNT_POINT (prefix /usr)."
