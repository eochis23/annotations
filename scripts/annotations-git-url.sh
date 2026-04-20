# shellcheck shell=bash
# Optional: set CHROOT_FETCH_URL before sourcing to force the fetch URL (host local config).

annotations_https_fetch_url() {
	local url="${1:?}"
	if [[ -n "${CHROOT_FETCH_URL:-}" ]]; then
		echo "$CHROOT_FETCH_URL"
		return
	fi
	case "$url" in
	git@*:*)
		if [[ "$url" =~ ^git@([^:]+):(.+)$ ]]; then
			echo "https://${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
			return
		fi
		;;
	ssh://git@*)
		if [[ "$url" =~ ^ssh://git@([^/]+)(/.+)$ ]]; then
			echo "https://${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
			return
		fi
		;;
	esac
	printf '%s' "$url"
}
