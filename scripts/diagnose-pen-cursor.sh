#!/bin/bash
# Diagnostic for DEBUG session da8410: "pen moves the mouse cursor".
# Writes NDJSON to /tmp AND (when accessible) to the workspace log path so
# the agent can read runtime evidence across a dual-boot setup.
# Run this ON THE MACHINE that exhibits the bug (second partition).

set +e
SESSION_ID="da8410"
WORKSPACE_LOG="/home/eochis/Projects/annotations/.cursor/debug-${SESSION_ID}.log"
FALLBACK_LOG="/tmp/annotation-diag-${SESSION_ID}.ndjson"

emit() {
    local hyp="$1" msg="$2" data="$3"
    local ts; ts="$(date +%s%3N)"
    local line="{\"sessionId\":\"${SESSION_ID}\",\"timestamp\":${ts},\"hypothesisId\":\"${hyp}\",\"location\":\"diagnose-pen-cursor.sh\",\"message\":\"${msg}\",\"data\":${data}}"
    printf '%s\n' "$line" >> "$FALLBACK_LOG" 2>/dev/null
    if [ -d "$(dirname "$WORKSPACE_LOG")" ]; then
        printf '%s\n' "$line" >> "$WORKSPACE_LOG" 2>/dev/null
    fi
    printf '%s\n' "$line"
}

echo "=== annotation pen/cursor diagnostic (session ${SESSION_ID}) ==="
: > "$FALLBACK_LOG"

# H_A: Does libmutter carry the annotation-fork symbols?
sym_file=""
for f in /usr/lib/libmutter-*.so.0 /usr/lib64/libmutter-*.so.0; do
    [ -f "$f" ] && sym_file="$f" && break
done
if [ -n "$sym_file" ]; then
    fork_isolated=$(nm -D "$sym_file" 2>/dev/null | grep -c "meta_annotation_input_set_non_mouse_pointer_isolated")
    fork_active=$(nm -D "$sym_file" 2>/dev/null | grep -c "meta_annotation_layer_set_active")
    emit "A_fork_installed" "libmutter symbol scan" "{\"libmutter\":\"${sym_file}\",\"sym_isolated\":${fork_isolated},\"sym_layer_set_active\":${fork_active}}"
else
    emit "A_fork_installed" "libmutter not found" "{\"libmutter\":null}"
fi

# H_A2: Packaged mutter version
pkg_info=$(pacman -Q mutter gnome-shell 2>&1 | tr '\n' ';' | sed 's/"/\\"/g')
emit "A_fork_installed" "package versions" "{\"pacman_Q\":\"${pkg_info}\"}"

# H_B: Does the fork D-Bus service answer?
gdbus_out=$(timeout 2 gdbus introspect --session \
    --dest org.gnome.Mutter.Annotation \
    --object-path /org/gnome/Mutter/Annotation 2>&1 | head -c 400)
gdbus_out_json=$(printf '%s' "$gdbus_out" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
emit "B_dbus" "gdbus introspect" "{\"output\":\"${gdbus_out_json}\"}"

# H_B2: Try SetActive(true) manually
setactive_out=$(timeout 2 gdbus call --session \
    --dest org.gnome.Mutter.Annotation \
    --object-path /org/gnome/Mutter/Annotation \
    --method org.gnome.Mutter.Annotation.SetActive true 2>&1 | head -c 400)
setactive_json=$(printf '%s' "$setactive_out" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
emit "B_dbus" "gdbus SetActive(true)" "{\"output\":\"${setactive_json}\"}"

# H_C: Stale user extension copy?
sys_ext="/usr/share/gnome-shell/extensions/annotation@annotations.local"
usr_ext="${HOME}/.local/share/gnome-shell/extensions/annotation@annotations.local"
emit "C_stale_user_ext" "extension install locations" "{\"system_present\":$([ -d "$sys_ext" ] && echo true || echo false),\"user_present\":$([ -d "$usr_ext" ] && echo true || echo false),\"user_path\":\"${usr_ext}\"}"

# H_C2: Which one is loaded? Hash compare extension.js
sys_hash=""
usr_hash=""
[ -f "$sys_ext/extension.js" ] && sys_hash=$(sha1sum "$sys_ext/extension.js" 2>/dev/null | awk '{print $1}')
[ -f "$usr_ext/extension.js" ] && usr_hash=$(sha1sum "$usr_ext/extension.js" 2>/dev/null | awk '{print $1}')
emit "C_stale_user_ext" "extension.js hashes" "{\"system_sha1\":\"${sys_hash}\",\"user_sha1\":\"${usr_hash}\"}"

# H_D: What pen/tablet devices exist?
lid=""
if command -v libinput >/dev/null 2>&1; then
    lid=$(sudo -n libinput list-devices 2>/dev/null | awk '/Device:/ {dev=$0} /Capabilities:/ && /tablet|pointer/ {print dev" | "$0}' | head -20 | tr '\n' ';' | sed 's/"/\\"/g')
fi
emit "D_device_class" "libinput list-devices (needs sudo)" "{\"lines\":\"${lid}\"}"

# H_D2: gnome-shell recent errors/warnings about annotation
journal_out=""
if command -v journalctl >/dev/null 2>&1; then
    journal_out=$(journalctl --user -b 0 --no-pager 2>/dev/null | \
        grep -iE "annotation|SetActive|Mutter\.Annotation" | tail -25 | \
        sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' '|')
fi
emit "B_dbus" "journal annotation entries (tail 25)" "{\"entries\":\"${journal_out}\"}"

# H_B3: Is GNOME Shell running with Wayland or X11?
session_type="${XDG_SESSION_TYPE:-unknown}"
emit "B_dbus" "session type" "{\"XDG_SESSION_TYPE\":\"${session_type}\"}"

# Overall summary
echo ""
echo "Wrote NDJSON to:"
echo "  $FALLBACK_LOG"
[ -d "$(dirname "$WORKSPACE_LOG")" ] && echo "  $WORKSPACE_LOG"
echo ""
echo "If the workspace log path was not writable, the fallback at /tmp is the only copy."
echo "Please paste the ENTIRE contents of ${FALLBACK_LOG} back to the agent, or confirm"
echo "that the workspace log path at ${WORKSPACE_LOG} was written."
