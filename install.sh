#!/bin/bash
set -euo pipefail
# Turn a downloaded tree into a normal git checkout (or refresh an existing one).
#
# Typical tarball / zip: no .git — pass --remote (HTTPS recommended) and --branch.
# Existing clone: omit --remote to use current origin; optional --branch to switch.
#
# Optional: --init-local-config copies compile_target.local.example when local.sh is missing.
#
# Arch chroot: --install-chroot-build-deps installs base-devel, meson, ninja, git,
# mutter Make Depends from the sync DB, and scripts/chroot-build-requirements.txt
# (or /mnt/build/chroot-build-requirements.txt when this script lives under /mnt/build).
# Use --yes to skip the confirmation prompt when stdin is a TTY.
#
# When copied to a chroot (e.g. /mnt/build/annotations-install.sh), place
# annotations-git-url.sh beside it if you want SSH→HTTPS rewriting for git mode.
#
# After a chroot build, install_second_partition.sh runs scripts/install-annotation-extension-chroot.sh
# to install the annotation dock extension and enable it via dconf.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HERE/annotations-git-url.sh" ]]; then
	# shellcheck source=scripts/annotations-git-url.sh
	. "$HERE/annotations-git-url.sh"
elif [[ -f "$HERE/scripts/annotations-git-url.sh" ]]; then
	# shellcheck source=scripts/annotations-git-url.sh
	. "$HERE/scripts/annotations-git-url.sh"
else
	annotations_https_fetch_url() { printf '%s' "$1"; }
fi

DEST=""
REMOTE=""
BRANCH=""
INIT_LOCAL=0
NO_HTTPS_REWRITE=0
INSTALL_CHROOT_DEPS=0
ASSUME_YES=0

usage() {
	echo "Usage:"
	echo "  $0 [--destination DIR] [--remote URL] [--branch NAME] [--init-local-config] [--no-https-rewrite]"
	echo "  $0 --install-chroot-build-deps [--yes]"
	echo "    (run as root inside an Arch chroot with pacman; installs compiler + mutter deps + requirements file)"
	exit 1
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--destination)
		DEST="${2:?}"
		shift 2
		;;
	--remote)
		REMOTE="${2:?}"
		shift 2
		;;
	--branch)
		BRANCH="${2:?}"
		shift 2
		;;
	--init-local-config)
		INIT_LOCAL=1
		shift
		;;
	--no-https-rewrite)
		NO_HTTPS_REWRITE=1
		shift
		;;
	--install-chroot-build-deps)
		INSTALL_CHROOT_DEPS=1
		shift
		;;
	-y | --yes)
		ASSUME_YES=1
		shift
		;;
	-h | --help)
		usage
		;;
	*)
		echo "Unknown option: $1"
		usage
		;;
	esac
done

install_chroot_build_dependencies() {
	if [[ "$(id -u)" -ne 0 ]]; then
		echo "Error: --install-chroot-build-deps must run as root (e.g. inside arch-chroot)."
		exit 1
	fi
	if ! command -v pacman >/dev/null 2>&1; then
		echo "Error: pacman not found; this mode is for Arch Linux chroots only."
		exit 1
	fi

	local list_script req_file
	list_script="$HERE/scripts/list-mutter-makedepends.sh"
	[[ -f /mnt/build/list-mutter-makedepends.sh ]] && list_script="/mnt/build/list-mutter-makedepends.sh"
	req_file="$HERE/scripts/chroot-build-requirements.txt"
	[[ -f /mnt/build/chroot-build-requirements.txt ]] && req_file="/mnt/build/chroot-build-requirements.txt"

	if [[ ! -f "$list_script" ]]; then
		echo "Error: list-mutter-makedepends.sh not found (expected under $HERE/scripts/ or /mnt/build/)."
		exit 1
	fi
	if [[ ! -f "$req_file" ]]; then
		echo "Warning: chroot-build-requirements.txt not found at $req_file (continuing without extra list)."
	fi

	if [[ "${CHROOT_PACMAN_SYNC:-0}" == "1" ]]; then
		echo "--- pacman -Sy (CHROOT_PACMAN_SYNC=1) ---"
		pacman -Sy --noconfirm
	fi

	local -a extra_pkgs=()
	local -a req_pkgs=()
	set +e
	local si_out
	si_out=$(pacman -Si mutter 2>/dev/null)
	local si_ec=$?
	set -e
	if [[ $si_ec -eq 0 ]]; then
		mapfile -t extra_pkgs < <(printf '%s\n' "$si_out" | bash "$list_script" | grep -v '^[[:space:]]*$')
	else
		echo "Warning: pacman -Si mutter failed (sync DB?). Install mutter makedepends manually or set CHROOT_PACMAN_SYNC=1 on the host before chroot."
	fi

	if [[ -f "$req_file" ]]; then
		mapfile -t req_pkgs < <(grep -v '^[[:space:]]*#' "$req_file" | grep -v '^[[:space:]]*$')
	fi

	local -a cmd=(pacman -S --needed --noconfirm base-devel meson ninja git)
	[[ ${#extra_pkgs[@]} -gt 0 ]] && cmd+=("${extra_pkgs[@]}")
	[[ ${#req_pkgs[@]} -gt 0 ]] && cmd+=("${req_pkgs[@]}")

	echo "--- Installing chroot build dependencies (${#cmd[@]} arguments to pacman) ---"
	if [[ -t 0 && "$ASSUME_YES" -ne 1 ]]; then
		echo "Will run: ${cmd[*]}"
		read -r -p "Proceed with pacman? [Y/n] " reply
		if [[ -n "$reply" && "$reply" != [yY]* ]]; then
			echo "Aborted."
			exit 1
		fi
	fi

	"${cmd[@]}"
	echo "Chroot build dependencies installed."
}

if [[ "$INSTALL_CHROOT_DEPS" -eq 1 ]]; then
	install_chroot_build_dependencies
	exit 0
fi

[[ -z "$DEST" ]] && DEST="$HERE"

if [[ "$NO_HTTPS_REWRITE" -eq 0 && -n "$REMOTE" ]]; then
	REMOTE="$(annotations_https_fetch_url "$REMOTE")"
fi

if [[ "$INIT_LOCAL" -eq 1 ]]; then
	ex="$DEST/compile_target.local.example"
	lc="$DEST/compile_target.local.sh"
	if [[ ! -f "$lc" && -f "$ex" ]]; then
		cp "$ex" "$lc"
		echo "Created $lc from example; edit paths before running compile scripts."
	fi
fi

if ! command -v git >/dev/null 2>&1; then
	echo "Error: git is required."
	exit 1
fi

mkdir -p "$DEST"
cd "$DEST"

if [[ -d .git ]]; then
	if [[ -n "$REMOTE" ]]; then
		if git remote get-url origin >/dev/null 2>&1; then
			git remote set-url origin "$REMOTE"
		else
			git remote add origin "$REMOTE"
		fi
	elif ! git remote get-url origin >/dev/null 2>&1; then
		echo "Error: no origin remote; pass --remote URL."
		exit 1
	fi
	GIT_TERMINAL_PROMPT=0 git fetch origin
	if [[ -z "$BRANCH" ]]; then
		BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
		if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
			BRANCH="$(git remote show origin 2>/dev/null | awk '/HEAD branch/ {print $NF}' | head -1)" || true
		fi
		if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
			echo "Error: could not determine branch; pass --branch."
			exit 1
		fi
	fi
	if ! git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
		git fetch origin "refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" || true
	fi
	if ! git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
		echo "Error: branch origin/$BRANCH not found after fetch; check --branch."
		exit 1
	fi
	git checkout -B "$BRANCH" "origin/$BRANCH"
	git reset --hard "origin/$BRANCH"
	echo "Repository updated at $DEST (branch $BRANCH)."
	exit 0
fi

# No .git: init or clone
if [[ -z "$REMOTE" || -z "$BRANCH" ]]; then
	echo "Error: this tree has no .git. Pass both --remote and --branch (use HTTPS for public clones)."
	exit 1
fi

if [[ -z "$(find . -mindepth 1 -maxdepth 1 2>/dev/null | head -1)" ]]; then
	echo "--- git clone into $DEST ---"
	git clone --branch "$BRANCH" "$REMOTE" .
	echo "Cloned to $DEST (branch $BRANCH)."
	exit 0
fi

echo "--- git init + fetch into existing tree ---"
git init
git remote add origin "$REMOTE" 2>/dev/null || git remote set-url origin "$REMOTE"
GIT_TERMINAL_PROMPT=0 git fetch origin
if ! git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
	echo "Error: origin/$BRANCH not found on remote."
	exit 1
fi
git checkout -B "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"
echo "Initialized git repository at $DEST (branch $BRANCH)."
