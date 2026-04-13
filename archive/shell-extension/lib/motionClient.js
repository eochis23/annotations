/* SPDX-License-Identifier: GPL-2.0-or-later */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * @param {string} extensionDir absolute path to extension root
 * @returns {string|null}
 */
export function findAnnoMotionBinary(extensionDir) {
    const candidates = [
        GLib.build_filenamev([extensionDir, 'bin', 'anno-motion']),
        GLib.build_filenamev([extensionDir, 'native', 'build', 'anno-motion']),
        GLib.build_filenamev([extensionDir, '..', 'native', 'build', 'anno-motion']),
    ];
    for (const p of candidates) {
        if (GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE))
            return p;
    }
    return null;
}

/**
 * Run native matcher asynchronously (does not block Shell main loop).
 * @param {string} helperPath
 * @param {number} w
 * @param {number} h
 * @param {string} prevPath
 * @param {string} curPath
 * @param {Gio.Cancellable|null} cancellable
 * @param {(result: {dx:number,dy:number,c:number,mse?:number}|null, err: Error|null) => void} callback
 */
export function runMotionMatchAsync(helperPath, w, h, prevPath, curPath, cancellable, callback) {
    let proc;
    try {
        proc = Gio.Subprocess.new(
            [helperPath, String(w), String(h), prevPath, curPath],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    } catch (e) {
        callback(null, e);
        return;
    }

    proc.communicate_utf8_async(null, cancellable, (p, res) => {
        try {
            if (!p.get_successful()) {
                callback(null, new Error('anno-motion failed'));
                return;
            }
            const [, stdout] = p.communicate_utf8_finish(res);
            const line = stdout.trim().split('\n').filter(Boolean).pop();
            if (!line) {
                callback(null, new Error('empty output'));
                return;
            }
            const j = JSON.parse(line);
            callback({
                dx: j.dx,
                dy: j.dy,
                c: j.c,
                mse: j.mse,
            }, null);
        } catch (e) {
            callback(null, e);
        }
    });
}
