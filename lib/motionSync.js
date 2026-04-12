/* SPDX-License-Identifier: GPL-2.0-or-later */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { findAnnoMotionBinary, runMotionMatchAsync } from './motionClient.js';

/** Deterministic synthetic buffers: cur approximates prev shifted by (tdx, tdy). */
export function buildSyntheticGreyPair(w, h, tdx, tdy) {
    const prev = new Uint8Array(w * h);
    for (let i = 0; i < prev.length; i++)
        prev[i] = (i * 17 + 41) % 256;

    const cur = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const xs = x - tdx;
            const ys = y - tdy;
            let v;
            if (xs >= 0 && xs < w && ys >= 0 && ys < h)
                v = prev[ys * w + xs];
            else
                v = prev[y * w + x];
            cur[y * w + x] = v;
        }
    }
    return { prev, cur };
}

export class MotionSyncService {
    /**
     * @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension
     * @param {import('./strokes.js').StrokeModel} strokeModel
     */
    constructor(extension, strokeModel) {
        this._extension = extension;
        this._model = strokeModel;
        this._settings = extension.getSettings();
        this._timer = 0;
        this._cancellable = null;
    }

    enable() {
        this._settingIds = [
            this._settings.connect('changed::movement-sync', () => this._restartTimer()),
            this._settings.connect('changed::movement-consent-roi', () => this._restartTimer()),
            this._settings.connect('changed::movement-max-hz', () => this._restartTimer()),
        ];
        this._restartTimer();
    }

    disable() {
        if (this._settingIds) {
            for (const id of this._settingIds)
                this._settings.disconnect(id);
            this._settingIds = null;
        }
        this._stopTimer();
        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = null;
    }

    _stopTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
    }

    _restartTimer() {
        this._stopTimer();
        if (!this._settings.get_boolean('movement-sync'))
            return;
        if (!this._settings.get_boolean('movement-consent-roi'))
            return;

        const hz = this._settings.get_int('movement-max-hz');
        const ms = Math.max(250, Math.floor(1000 / Math.max(1, hz)));
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._onTimerTick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** Placeholder: real implementation will submit ROI snapshots from the overlay. */
    _onTimerTick() {
        /* No ROI pipeline wired yet — timer keeps slot for future hook. */
    }

    /**
     * Self-test: run matcher on synthetic data; optionally apply translation to model.
     * @param {(msg: string) => void} log
     */
    runSyntheticSelfTest(log) {
        const dir = this._extension.dir.get_path();
        const helper = findAnnoMotionBinary(dir);
        if (!helper) {
            log('anno-motion binary not found (build native/ and optionally install to bin/).');
            return;
        }

        const w = 64;
        const h = 48;
        const tdx = 5;
        const tdy = -2;
        const { prev, cur } = buildSyntheticGreyPair(w, h, tdx, tdy);

        const tmp = GLib.build_filenamev([GLib.get_tmp_dir(), `anno-selftest-${GLib.random_int_range(0, 1073741823)}`]);
        GLib.mkdir_with_parents(tmp, 0o700);
        const prevPath = GLib.build_filenamev([tmp, 'prev.raw']);
        const curPath = GLib.build_filenamev([tmp, 'cur.raw']);

        try {
            GLib.file_set_contents(prevPath, prev);
            GLib.file_set_contents(curPath, cur);
        } catch (e) {
            log(`write tmp failed: ${e}`);
            this._rmTmp(tmp);
            return;
        }

        this._cancellable = new Gio.Cancellable();
        runMotionMatchAsync(helper, w, h, prevPath, curPath, this._cancellable, (res, err) => {
            this._rmTmp(tmp);
            if (err) {
                log(`motion match error: ${err}`);
                return;
            }
            const thr = this._settings.get_double('movement-confidence-threshold');
            const geomOk = Math.abs(res.dx - tdx) <= 1 && Math.abs(res.dy - tdy) <= 1;
            log(`synthetic result dx=${res.dx} dy=${res.dy} c=${res.c.toFixed(3)} (threshold ${thr}, geomOk=${geomOk})`);
            if (geomOk || res.c >= thr) {
                this._model.translateAll(res.dx, res.dy);
                log('applied translateAll to stroke model');
            }
        });
    }

    _rmTmp(tmp) {
        for (const leaf of ['prev.raw', 'cur.raw']) {
            try {
                Gio.File.new_for_path(GLib.build_filenamev([tmp, leaf])).delete(null);
            } catch {
                /* ignore */
            }
        }
        try {
            Gio.File.new_for_path(tmp).delete(null);
        } catch {
            /* ignore */
        }
    }
}
