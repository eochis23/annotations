#!/bin/bash
set -euo pipefail
# Turn a downloaded tree into a normal git checkout (or refresh an existing one).
#
# Typical tarball / zip: no .git — pass --remote (HTTPS recommended) and --branch.
# Existing clone: omit --remote to use current origin; optional --branch to switch.
#
# Optional: --init-local-config copies compile_target.local.example when local.sh is missing.
#
# When copied to a chroot (e.g. /mnt/build/annotations-install.sh), place
# annotations-git-url.sh beside it if you want SSH→HTTPS rewriting.

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

usage() {
	echo "Usage: $0 [--destination DIR] [--remote URL] [--branch NAME] [--init-local-config] [--no-https-rewrite]"
	echo "  Default DIR is this script's directory (the annotations project root)."
	echo "  Without .git under DIR, --remote and --branch are required (HTTPS URL recommended)."
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
	-h | --help)
		usage
		;;
	*)
		echo "Unknown option: $1"
		usage
		;;
	esac
done

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
