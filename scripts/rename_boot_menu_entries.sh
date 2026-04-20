#!/bin/bash
# Prefix systemd-boot menu titles for every entry except:
#   - the entry used for this boot (bootctl "Current Entry"), and
#   - any entry whose kernel cmdline boots the filesystem from compile_target.local.sh
#     (MOUNT_POINT, PARTITION_PARTUUID / PARTITION_DEVICE, or PARTITION_FS_LABEL → root UUID).
#
# Usage:
#   sudo ./scripts/rename_boot_menu_entries.sh
#   sudo DRY_RUN=1 ./scripts/rename_boot_menu_entries.sh
#   sudo BOOT_MENU_RENAME_PREFIX='(other) ' ./scripts/rename_boot_menu_entries.sh
#   Default prefix: "- inactive " then the previous title (e.g. "- inactive Some OS (6.6.1)").
#
# Requires: bootctl, blkid, findmnt (util-linux).

set -euo pipefail

MYSELF=$(readlink -f "${BASH_SOURCE[0]}")
REPO_ROOT=$(cd "$(dirname "$MYSELF")/.." && pwd)
LOCAL_CONFIG="$REPO_ROOT/compile_target.local.sh"

BOOT_MENU_RENAME_PREFIX="${BOOT_MENU_RENAME_PREFIX:-- inactive }"
DRY_RUN="${DRY_RUN:-0}"

if [[ $EUID -ne 0 ]]; then
    exec sudo -E env "PATH=$PATH" "$MYSELF" "$@"
fi

extract_root_from_cmdline_string() {
    local v=
    local tok
    for tok in $1; do
        case "$tok" in
            root=*) v="${tok#root=}" ;;
        esac
    done
    printf '%s' "$v"
}

options_line_from_conf() {
    # Concatenate continued options lines (systemd-boot allows continuation with leading spaces).
    awk '
        /^options[[:space:]]/ { p=1; sub(/^options[[:space:]]+/, ""); printf "%s", $0; next }
        p && /^[[:space:]]+/ { sub(/^[[:space:]]+/, " "); printf "%s", $0; next }
        p && /^[^[:space:]]/ { exit }
    ' "$1"
}

opts_has_root_pair() {
    local opts=$1
    local key=$2
    local val=$3
    [[ -z "$val" ]] && return 1
    [[ "$opts" == *"root=$key$val"* ]] || [[ "$opts" == *"rd.root=$key$val"* ]]
}

# bootctl prints e.g. "ESP: /efi (/dev/disk/by-partuuid/...)" — only the mount path
# matters; using the full second field makes "/efi (/dev/.../loader/entries" invalid.
bootctl_colon_value_trimmed() {
    local key=$1
    local line val
    while IFS= read -r line; do
        [[ "$line" =~ ^[[:space:]]*${key}:[[:space:]]+(.*) ]] || continue
        val="${BASH_REMATCH[1]}"
        val="${val%"${val##*[![:space:]]}"}"
        if [[ "$val" == '('* ]] || [[ "$val" == "(not set)" ]]; then
            printf ''
            return 0
        fi
        val="${val%% (*}"
        val="${val%"${val##*[![:space:]]}"}"
        printf '%s' "$val"
        return 0
    done < <(bootctl status 2>/dev/null)
    printf ''
}

# Type #1 entries live on XBOOTLDR when it is set, otherwise on the ESP.
loader_partition_mount() {
    local esp xb
    esp=$(bootctl_colon_value_trimmed "ESP")
    xb=$(bootctl_colon_value_trimmed "XBOOTLDR")
    if [[ -n "$xb" && -d "$xb/loader/entries" ]]; then
        printf '%s' "$xb"
        return 0
    fi
    if [[ -n "$esp" && -d "$esp/loader/entries" ]]; then
        printf '%s' "$esp"
        return 0
    fi
    printf ''
}

current_entry_basename() {
    local line val
    while IFS= read -r line; do
        [[ "$line" =~ ^[[:space:]]*Current[[:space:]]+Entry:[[:space:]]+(.*) ]] || continue
        val="${BASH_REMATCH[1]}"
        val="${val%"${val##*[![:space:]]}"}"
        printf '%s' "$val"
        return 0
    done < <(bootctl status 2>/dev/null)
    printf ''
}

if [[ -f "$LOCAL_CONFIG" ]]; then
    # shellcheck source=/dev/null
    . "$LOCAL_CONFIG"
fi

BOOT_ROOT=$(loader_partition_mount)
if [[ -z "$BOOT_ROOT" || ! -d "$BOOT_ROOT/loader/entries" ]]; then
    echo "Error: Could not find loader/entries under ESP or XBOOTLDR (see 'bootctl status'). Is this systemd-boot?" >&2
    exit 1
fi

ENTRIES_DIR="$BOOT_ROOT/loader/entries"
CURRENT_CONF=$(current_entry_basename)
PROC_ROOT=$(extract_root_from_cmdline_string "$(</proc/cmdline)")

# Resolve target install (Endeavour / DESTDIR root) for protecting its menu lines.
TARGET_DEV=
if [[ -n "${MOUNT_POINT:-}" ]] && mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
    TARGET_DEV=$(findmnt -n -o SOURCE --target "$MOUNT_POINT" 2>/dev/null || true)
fi
if [[ -z "$TARGET_DEV" && -n "${PARTITION_PARTUUID:-}" ]]; then
    TARGET_DEV=$(blkid -t "PARTUUID=$PARTITION_PARTUUID" -o device -c /dev/null 2>/dev/null | head -1 || true)
fi
if [[ -z "$TARGET_DEV" && -n "${PARTITION_DEVICE:-}" && -b "${PARTITION_DEVICE}" ]]; then
    TARGET_DEV=$(readlink -f "$PARTITION_DEVICE")
fi
if [[ -z "$TARGET_DEV" && -n "${PARTITION_FS_LABEL:-}" ]]; then
    TARGET_DEV=$(blkid -t "LABEL=$PARTITION_FS_LABEL" -o device -c /dev/null 2>/dev/null | head -1 || true)
fi

TARGET_UUID= TARGET_PARTUUID= TARGET_LABEL=
if [[ -n "$TARGET_DEV" ]]; then
    TARGET_UUID=$(blkid -o value -s UUID "$TARGET_DEV" 2>/dev/null || true)
    TARGET_PARTUUID=$(blkid -o value -s PARTUUID "$TARGET_DEV" 2>/dev/null || true)
    TARGET_LABEL=$(blkid -o value -s LABEL "$TARGET_DEV" 2>/dev/null || true)
fi

should_skip() {
    local f=$1
    local base opts
    base=$(basename "$f")
    opts=$(options_line_from_conf "$f")

    if [[ -n "$CURRENT_CONF" && "$base" == "$CURRENT_CONF" ]]; then
        echo "skip (current boot entry): $base"
        return 0
    fi
    if [[ -n "$PROC_ROOT" ]]; then
        if [[ "$opts" == *"root=$PROC_ROOT"* ]] || [[ "$opts" == *"rd.root=$PROC_ROOT"* ]]; then
            echo "skip (same root= as running system): $base"
            return 0
        fi
    fi
    if [[ -n "${TARGET_UUID:-}" ]] && opts_has_root_pair "$opts" "UUID=" "$TARGET_UUID"; then
        echo "skip (target root UUID): $base"
        return 0
    fi
    if [[ -n "${TARGET_PARTUUID:-}" ]] && opts_has_root_pair "$opts" "PARTUUID=" "$TARGET_PARTUUID"; then
        echo "skip (target PARTUUID): $base"
        return 0
    fi
    if [[ -n "${PARTITION_FS_LABEL:-}" ]] && opts_has_root_pair "$opts" "LABEL=" "$PARTITION_FS_LABEL"; then
        echo "skip (target LABEL=$PARTITION_FS_LABEL): $base"
        return 0
    fi
    if [[ -n "${TARGET_LABEL:-}" && "$TARGET_LABEL" != "${PARTITION_FS_LABEL:-}" ]] && opts_has_root_pair "$opts" "LABEL=" "$TARGET_LABEL"; then
        echo "skip (target blkid LABEL): $base"
        return 0
    fi
    return 1
}

echo "--- Loader partition (ESP or XBOOTLDR): $BOOT_ROOT"
echo "--- Entries: $ENTRIES_DIR"
echo "--- Current boot conf: ${CURRENT_CONF:-unknown}"
echo "--- Running root= value: ${PROC_ROOT:-unknown}"
echo "--- Target dev (local config): ${TARGET_DEV:-none} (label=${PARTITION_FS_LABEL:-unset})"
echo "--- Prefix for renamed titles: $(printf '%q' "$BOOT_MENU_RENAME_PREFIX")"
echo

shopt -s nullglob
for f in "$ENTRIES_DIR"/*.conf; do
    if should_skip "$f"; then
        continue
    fi
    if ! grep -q '^title[[:space:]]' "$f"; then
        echo "warn: no title line, skipping: $(basename "$f")" >&2
        continue
    fi
    old_title=$(grep '^title[[:space:]]' "$f" | head -1 | sed 's/^title[[:space:]]*//')
    if [[ "$old_title" == "${BOOT_MENU_RENAME_PREFIX}"* ]]; then
        echo "skip (already prefixed): $(basename "$f")"
        continue
    fi
    new_title="${BOOT_MENU_RENAME_PREFIX}${old_title}"
    echo "rename: $(basename "$f")"
    echo "        title: $old_title"
    echo "    ->      : $new_title"
    if [[ "$DRY_RUN" == "1" ]]; then
        continue
    fi
    tmp=$(mktemp)
    title_done=0
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$title_done" -eq 0 && "$line" =~ ^title[[:space:]] ]]; then
            printf 'title %s\n' "$new_title"
            title_done=1
        else
            printf '%s\n' "$line"
        fi
    done <"$f" >"$tmp"
    mv "$tmp" "$f"
done
shopt -u nullglob

echo
echo "Done. Run 'bootctl list' (as root) to verify titles."
echo "Note: UEFI firmware entries (Windows, other ESP loaders) use efibootmgr -b HEX -L 'New name'; this script only edits systemd-boot .conf files."
