#!/bin/bash
set -euo pipefail
# Install Kate + the AT-SPI stack the annotation project's scroll-following
# code expects inside the target chroot. This is optional: set
# INSTALL_KATE=0 to skip. Intended to be invoked from install_second_partition.sh
# after the extension has been installed, so the second partition boots with
# a ready-to-test editor.
#
# What this installs (Arch pacman names):
#   kate             -- the editor; pulls qt6-base, ktexteditor, ...
#   at-spi2-core     -- session-bus AT-SPI registry the Qt bridge talks to
#                       (usually already present as a GNOME dep, harmless if so)
#
# The Qt 6 AT-SPI bridge itself is compiled into qt6-base on Arch; no separate
# package. Qt only activates it when at-spi2-core is present on the session,
# which is why we install it explicitly instead of relying on gnome-shell pulling
# it in transitively.
#
# Usage: install-kate-runtime-chroot.sh CHROOT_MOUNT_POINT

MP="${1:?Usage: $0 CHROOT_MOUNT_POINT (e.g. /run/media/user/root)}"

if [[ "${INSTALL_KATE:-1}" != "1" ]]; then
	echo "INSTALL_KATE=${INSTALL_KATE:-unset}: skipping kate install."
	exit 0
fi

# Pacman inside the chroot. --needed keeps reruns cheap.
sudo arch-chroot "$MP" /bin/bash -lc '
	set -euo pipefail
	pacman -Sy --needed --noconfirm kate at-spi2-core
'

echo "Installed kate + at-spi2-core in $MP."

# Best-effort check that Qt will actually surface an AT-SPI bridge on next boot.
# We cannot exercise the bridge from inside the chroot (no running session),
# but we can confirm the binary is present and linked against the right libs.
if [[ -x "$MP/usr/bin/kate" ]]; then
	if sudo arch-chroot "$MP" /usr/bin/ldd /usr/bin/kate 2>/dev/null | grep -qi 'libatspi\|libqt6core'; then
		echo "kate links against Qt6 (and, transitively, the AT-SPI-capable Qt accessibility bridge)."
	else
		echo "Note: kate is installed but its ldd output did not mention libatspi or libqt6core."
		echo "      That is usually fine (the bridge is loaded as a Qt plugin at runtime),"
		echo "      but if scroll-following fails, verify qt6-base was compiled with accessibility."
	fi
else
	echo "WARNING: /usr/bin/kate not found after install; annotations scroll-following won't be testable on this target."
fi
