#!/bin/bash

#run with /home/eochis/Projects/annotations/compile_target.sh
# ==========================================
# 1. Configuration
# ==========================================
MUTTER_SRC="/home/eochis/Projects/annotations/mutter-main"
# You will need to clone GNOME Shell: git clone https://gitlab.gnome.org/GNOME/gnome-shell.git
SHELL_SRC="/home/eochis/Projects/annotations/gnome-shell" 
MOUNT_POINT="/run/media/eric/endeavouros"
PARTITION_DEVICE=$(readlink -f /dev/disk/by-label/endeavouros)

# Function to clean up on exit
cleanup() {
    echo "Unmounting $MOUNT_POINT..."
    sudo umount "$MOUNT_POINT"
}

# ==========================================
# 2. Mount Logic
# ==========================================
if [ -z "$PARTITION_DEVICE" ]; then
    echo "Error: Could not find partition with label 'endeavouros'"
    exit 1
fi

if ! mountpoint -q "$MOUNT_POINT"; then
    echo "Mounting $PARTITION_DEVICE to $MOUNT_POINT..."
    sudo mkdir -p "$MOUNT_POINT"
    sudo mount "$PARTITION_DEVICE" "$MOUNT_POINT"
fi

# Set the trap to unmount if the script stops, fails, or succeeds
trap cleanup EXIT

# ==========================================
# 3. Build & Install Mutter
# ==========================================
echo "--- Building Mutter ---"
cd "$MUTTER_SRC" || exit 1

if [ ! -d "build" ]; then
    meson setup build --prefix=/usr
else
    meson setup --reconfigure build --prefix=/usr
fi

if ninja -C build; then
    echo "Installing Mutter to $MOUNT_POINT..."
    sudo DESTDIR="$MOUNT_POINT" meson install -C build
else
    echo "Mutter compilation failed."
    exit 1
fi

# ==========================================
# 4. Build & Install GNOME Shell
# ==========================================
echo "--- Building GNOME Shell ---"
cd "$SHELL_SRC" || { echo "GNOME Shell source not found at $SHELL_SRC. Skipping shell build."; exit 0; }

# CRITICAL: Force pkg-config to use the Mutter files we JUST installed to the mounted drive
export PKG_CONFIG_PATH="$MOUNT_POINT/usr/lib/pkgconfig:$MOUNT_POINT/usr/share/pkgconfig:$PKG_CONFIG_PATH"
# Force the compiler to look at the mounted drive's headers
export CFLAGS="-I$MOUNT_POINT/usr/include"
export LDFLAGS="-L$MOUNT_POINT/usr/lib"

if [ ! -d "build" ]; then
    meson setup build --prefix=/usr
else
    meson setup --reconfigure build --prefix=/usr
fi

if ninja -C build; then
    echo "Installing GNOME Shell to $MOUNT_POINT..."
    sudo DESTDIR="$MOUNT_POINT" meson install -C build
else
    echo "GNOME Shell compilation failed."
    exit 1
fi

# ==========================================
# 5. Post-Install Triggers
# ==========================================
echo "--- Updating Target System Cache ---"
# Update library cache for the target drive
sudo ldconfig -r "$MOUNT_POINT"
# Compile GSettings schemas for both Mutter and Shell
sudo glib-compile-schemas "$MOUNT_POINT/usr/share/glib-2.0/schemas/"

echo "Success! Both Mutter and GNOME Shell are updated on the second partition."