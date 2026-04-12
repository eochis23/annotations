/* SPDX-License-Identifier: GPL-2.0-or-later */
/** DEBUG: NDJSON + journal + ingest (session 297fad). Remove after verification. */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const LOG_PATH = '/home/eochis/Projects/annotations/.cursor/debug-297fad.log';
const INGEST = 'http://127.0.0.1:7559/ingest/80a2f4a9-78cb-409a-8218-b1ab6873e06c';
const SESSION = '297fad';

/**
 * @param {{ location: string, message: string, hypothesisId: string, data?: object, runId?: string }} payload
 */
export function annoDebug(payload) {
    const body = {
        sessionId: SESSION,
        timestamp: Date.now(),
        ...payload,
    };
    const str = JSON.stringify(body);
    // #region agent log
    log(`[annotations-debug] ${str}`);
    if (typeof globalThis.fetch === 'function') {
        try {
            void fetch(INGEST, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Debug-Session-Id': SESSION,
                },
                body: str,
            }).catch(() => {});
        } catch {
            /* ignore */
        }
    }
    try {
        const f = Gio.File.new_for_path(LOG_PATH);
        let ostream;
        try {
            ostream = f.append_to(Gio.FileCreateFlags.NONE, null);
        } catch {
            ostream = f.create_file(Gio.FileCreateFlags.PRIVATE, null);
        }
        const bytes = new GLib.Bytes(str + '\n');
        ostream.write_bytes(bytes, null);
        ostream.close(null);
    } catch {
        /* ignore */
    }
    // #endregion
}
