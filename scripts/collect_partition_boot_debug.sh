#!/bin/bash
# Collect runtime evidence for blank-screen / gnome-shell issues on the DESTDIR
# target root. Writes a human-readable report and NDJSON lines for debug analysis.
#
# Run (mount target first if needed):
#   bash /home/eochis/Projects/annotations/scripts/collect_partition_boot_debug.sh
# With chroot checks:
#   sudo bash /home/eochis/Projects/annotations/scripts/collect_partition_boot_debug.sh

set -euo pipefail

# #region agent log
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEBUG_LOG="${REPO_ROOT}/.cursor/debug-78a20e.log"
REPORT_FILE="${REPO_ROOT}/.cursor/partition-boot-debug-report.txt"
SESSION_ID="78a20e"

log_ndjson() {
	local hypothesis_id=$1
	local message=$2
	local data_json
	if [[ $# -ge 3 ]]; then
		data_json="$3"
	else
		data_json="{}"
	fi
	python3 -c "
import json, sys, time
hid, msg, dj = sys.argv[1:4]
try:
    data = json.loads(dj)
except json.JSONDecodeError:
    data = {'parse_error': True, 'raw': dj[:500]}
rec = {
    'sessionId': '${SESSION_ID}',
    'timestamp': int(time.time() * 1000),
    'hypothesisId': hid,
    'location': 'collect_partition_boot_debug.sh',
    'message': msg,
    'data': data,
}
path = '''${DEBUG_LOG}'''
with open(path, 'a', encoding='utf-8') as f:
    f.write(json.dumps(rec, ensure_ascii=False) + '\n')
" "$hypothesis_id" "$message" "$data_json" 2>/dev/null || true
}
# #endregion

LOCAL_CONFIG="${REPO_ROOT}/compile_target.local.sh"
MOUNT_POINT=""
PARTITION_FS_LABEL=""
PARTITION_PARTUUID=""
PARTITION_DEVICE=""

if [[ -f "$LOCAL_CONFIG" ]]; then
	# shellcheck source=/dev/null
	. "$LOCAL_CONFIG"
fi

mkdir -p "${REPO_ROOT}/.cursor"

# Same device resolution as compile_target.sh (explicit device / PARTUUID beats ambiguous LABEL).
if [[ -n "${PARTITION_DEVICE:-}" && -b "${PARTITION_DEVICE}" ]]; then
	PARTITION_DEVICE=$(readlink -f "$PARTITION_DEVICE")
elif [[ -n "${PARTITION_PARTUUID:-}" ]]; then
	PARTITION_DEVICE=$(readlink -f "/dev/disk/by-partuuid/${PARTITION_PARTUUID}" 2>/dev/null || true)
elif [[ -n "${PARTITION_FS_LABEL:-}" ]]; then
	PARTITION_DEVICE=$(readlink -f "/dev/disk/by-label/${PARTITION_FS_LABEL}" 2>/dev/null || true)
else
	PARTITION_DEVICE=""
fi
if [[ -n "${MOUNT_POINT:-}" ]] && ! mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
	if [[ -n "$PARTITION_DEVICE" && -b "$PARTITION_DEVICE" && $EUID -eq 0 ]]; then
		echo "--- Auto-mounting $PARTITION_DEVICE on $MOUNT_POINT (collector) ---"
		mkdir -p "$MOUNT_POINT"
		if mount "$PARTITION_DEVICE" "$MOUNT_POINT" 2>/dev/null; then
			log_ndjson "H1" "collector auto-mounted LABEL partition" "$(PARTITION_DEVICE="$PARTITION_DEVICE" MOUNT_POINT="$MOUNT_POINT" python3 -c 'import json,os;print(json.dumps({"device":os.environ["PARTITION_DEVICE"],"mount":os.environ["MOUNT_POINT"]}))')"
		else
			echo "Auto-mount failed (try: sudo mount LABEL=$PARTITION_FS_LABEL \"$MOUNT_POINT\")"
			log_ndjson "H1" "collector auto-mount mount(8) failed" "{}"
		fi
	elif [[ $EUID -ne 0 ]]; then
		echo "Note: target not mounted; run with sudo and set PARTITION_DEVICE or PARTITION_PARTUUID in compile_target.local.sh if LABEL is ambiguous."
	fi
fi

{
	echo "========== partition-boot-debug =========="
	echo "date: $(date -Is)"
	echo "host: $(uname -a)"
	echo "running as: $(id -un) (euid=$EUID)"
	echo "repo: $REPO_ROOT"
	echo "LOCAL_CONFIG present: $([[ -f $LOCAL_CONFIG ]] && echo yes || echo no)"
	echo "MOUNT_POINT: ${MOUNT_POINT:-<unset>}"
	echo "PARTITION_FS_LABEL: ${PARTITION_FS_LABEL:-<unset>}  PARTITION_PARTUUID: ${PARTITION_PARTUUID:-<unset>}"
	echo "resolved PARTITION_DEVICE: ${PARTITION_DEVICE:-<empty>}"
	echo

	echo "---------- H1: target mount ----------"
	if [[ -n "${MOUNT_POINT:-}" ]] && mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
		echo "mountpoint -q: YES"
		findmnt -o TARGET,SOURCE,FSTYPE,OPTIONS -T "$MOUNT_POINT" 2>/dev/null || true
		log_ndjson "H1" "MOUNT_POINT is mounted" "{}"
	else
		echo "mountpoint -q: NO (mount target before meaningful chroot/ldd checks)"
		log_ndjson "H1" "MOUNT_POINT not mounted or unset" "{}"
		echo
		echo ">>> ACTION REQUIRED: Mount $MOUNT_POINT (e.g. open the volume in Files,"
		echo ">>> or: sudo mount LABEL=$PARTITION_FS_LABEL \"$MOUNT_POINT\") then re-run this script."
		echo
	fi
	echo

	echo "---------- H2: gnome-shell / mutter on target tree ----------"
	GS=""
	[[ -n "${MOUNT_POINT:-}" ]] && GS="${MOUNT_POINT}/usr/bin/gnome-shell"
	if [[ -n "$GS" && -f "$GS" ]]; then
		ls -la "$GS" 2>/dev/null || true
		file "$GS" 2>/dev/null || true
		readelf -l "$GS" 2>/dev/null | grep -E 'interpreter|Requesting' || true
		log_ndjson "H2" "gnome-shell binary exists" "{\"path\":\"usr/bin/gnome-shell\"}"
	else
		echo "no $GS"
		log_ndjson "H2" "gnome-shell binary missing" "{}"
	fi
	if [[ -n "${MOUNT_POINT:-}" ]]; then
		shopt -s nullglob
		for pc in "$MOUNT_POINT"/usr/lib/pkgconfig/libmutter*.pc; do
			[[ -f "$pc" ]] || continue
			echo "--- $(basename "$pc") (prefix line) ---"
			grep -m1 '^prefix=' "$pc" 2>/dev/null || true
		done
		shopt -u nullglob
	fi
	echo

	echo "---------- H3: ldd inside target root (needs sudo + mount) ----------"
	ldd_target=""
	if [[ -n "$GS" && -f "$GS" ]]; then
		ldd_target="/usr/bin/gnome-shell"
	elif [[ -n "${MOUNT_POINT:-}" && -d "${MOUNT_POINT}/usr/lib" ]]; then
		m_so=$(find "${MOUNT_POINT}/usr/lib" -maxdepth 3 -name 'libmutter-*.so.0' 2>/dev/null | head -1)
		if [[ -n "$m_so" ]]; then
			ldd_target=${m_so#"$MOUNT_POINT"}
			echo "H3: using mutter lib for ldd: $ldd_target"
		fi
	fi
	if [[ $EUID -eq 0 && -n "${MOUNT_POINT:-}" && -n "$ldd_target" ]]; then
		if [[ -d "${MOUNT_POINT}/usr/lib" ]]; then
			set +e
			out=$(chroot "$MOUNT_POINT" /usr/bin/ldd "$ldd_target" 2>&1)
			ldd_ec=$?
			set -e
			echo "$out" | head -60
			if [[ $ldd_ec -ne 0 ]]; then
				echo "(chroot ldd exit $ldd_ec)"
				log_ndjson "H3" "chroot ldd non-zero exit unresolved deps" "{\"exit\":$ldd_ec}"
			else
				log_ndjson "H3" "chroot ldd exit 0" "{}"
			fi
		fi
	else
		echo "skipped (need mounted tree and /usr/bin/gnome-shell or libmutter-*.so.0; sudo $0)"
		log_ndjson "H3" "ldd skipped missing mount or target" "$(python3 -c "import json,os;print(json.dumps({'euid':os.geteuid()}))")"
	fi
	echo

	echo "---------- H4: journal on target (offline; use host journalctl -D) ----------"
	JDIR="${MOUNT_POINT}/var/log/journal"
	if [[ -n "${MOUNT_POINT:-}" && -d "$JDIR" ]]; then
		ls -la "$JDIR" 2>/dev/null | head -20 || true
		if command -v journalctl >/dev/null 2>&1; then
			echo "--- boots recorded on this disk (newest last) ---"
			journalctl -D "$JDIR" --list-boots --no-pager 2>/dev/null | tail -15 || true
			echo "--- newest boot (-b 0): err priority, tail ---"
			journalctl -D "$JDIR" -b 0 -p err --no-pager 2>/dev/null | tail -120 || true
			echo "--- newest boot (-b 0): gdm.service ---"
			journalctl -D "$JDIR" -b 0 -u gdm.service --no-pager 2>/dev/null | tail -100 || true
			echo "--- newest boot (-b 0): gnome-shell|mutter|gjs|segfault|fatal|error ---"
			journalctl -D "$JDIR" -b 0 --no-pager 2>/dev/null | grep -iE 'gnome-shell|mutter|gjs|segfault|fatal|error' | tail -80 || true
			echo "--- previous boot (-b -1): err priority, tail ---"
			journalctl -D "$JDIR" -b -1 -p err --no-pager 2>/dev/null | tail -120 || true
			echo "--- previous boot (-b -1): gdm.service ---"
			journalctl -D "$JDIR" -b -1 -u gdm.service --no-pager 2>/dev/null | tail -100 || true
			echo "--- previous boot (-b -1): gnome-shell|mutter|... ---"
			journalctl -D "$JDIR" -b -1 --no-pager 2>/dev/null | grep -iE 'gnome-shell|mutter|gjs|segfault|fatal|error' | tail -80 || true
			log_ndjson "H4" "journalctl -D excerpts (boot 0 and -1)" "{\"journal_dir\":\"var/log/journal\"}"
		else
			log_ndjson "H4" "no journalctl" "{}"
		fi
		echo
		echo ">>> Manual: idx 0 = newest boot on this disk; -1 = one before. Use -b 0 for the last bad session."
		echo ">>>   sudo journalctl -D \"$JDIR\" --list-boots --no-pager"
		echo ">>>   sudo journalctl -D \"$JDIR\" -b 0 -u gdm.service --no-pager | tail -100"
		echo ">>>   sudo journalctl -D \"$JDIR\" -b 0 --no-pager | grep -iE 'gnome-shell|mutter|gjs|segfault|fatal|error' | tail -80"
	else
		echo "no $JDIR (enable persistent journal on that install: /etc/systemd/journald.conf Storage=persistent)"
		log_ndjson "H4" "target journal dir missing" "{}"
	fi
	echo

	echo "---------- H5a: zero-byte mutter libs (causes gnome-shell: file too short) ----------"
	if [[ -n "${MOUNT_POINT:-}" ]]; then
		zb=$(find "${MOUNT_POINT}/usr/lib" -type f -path '*/mutter-*/libmutter*.so*' -size 0 2>/dev/null | head -20 || true)
		if [[ -n "$zb" ]]; then
			echo "FOUND empty mutter libraries:"
			echo "$zb"
			log_ndjson "H5a" "zero-byte mutter so found" "{}"
		else
			echo "No zero-byte libmutter*.so under mutter-* (good)."
			log_ndjson "H5a" "no zero-byte mutter libs" "{}"
		fi
	else
		echo "skipped (no MOUNT_POINT)"
	fi
	echo

	echo "---------- H5: host vs target glib (link vs runtime skew hint) ----------"
	if command -v pacman >/dev/null 2>&1; then
		pacman -Q glib2 mutter gnome-shell 2>/dev/null || true
	fi
	if [[ -n "${MOUNT_POINT:-}" && -f "${MOUNT_POINT}/usr/lib/libglib-2.0.so.0" ]]; then
		ls -la "${MOUNT_POINT}/usr/lib"/libglib-2.0.so* 2>/dev/null | head -5 || true
	fi
	log_ndjson "H5" "glib package versions listed" "{}"
	echo

	echo "---------- done ----------"
	echo "Report: $REPORT_FILE"
	echo "NDJSON: $DEBUG_LOG"
} 2>&1 | tee "$REPORT_FILE"

log_ndjson "H0" "collect_partition_boot_debug finished" "{\"report\":\"partition-boot-debug-report.txt\"}"
