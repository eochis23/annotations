/* SPDX-License-Identifier: GPL-2.0-or-later */
import GObject from 'gi://GObject';
import St from 'gi://St';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { MotionSyncService } from './lib/motionSync.js';
import { StrokeModel } from './lib/strokes.js';

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    /**
     * @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} ext
     */
    _init(ext) {
        super._init(0.0, _('Annotations'), false);
        this._ext = ext;

        this.add_child(new St.Icon({
            icon_name: 'input-tablet-symbolic',
            style_class: 'system-status-icon',
        }));

        const prefsItem = new PopupMenu.PopupMenuItem(_('Preferences'));
        prefsItem.connect('activate', () => {
            try {
                ext.openPreferences();
            } catch (e) {
                log(`openPreferences: ${e}`);
            }
        });
        this.menu.addMenuItem(prefsItem);

        const testItem = new PopupMenu.PopupMenuItem(_('Run synthetic motion test'));
        testItem.connect('activate', () => {
            ext.runSyntheticMotionSelfTest();
        });
        this.menu.addMenuItem(testItem);
    }
});

export default class AnnotationsExtension extends Extension {
    enable() {
        this._strokeModel = new StrokeModel();
        this._motion = new MotionSyncService(this, this._strokeModel);
        this._motion.enable();

        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._motion) {
            this._motion.disable();
            this._motion = null;
        }
        this._strokeModel = null;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    /** Menu action: exercise C matcher + translateAll on the in-memory stroke model. */
    runSyntheticMotionSelfTest() {
        this._strokeModel.clearAll();
        this._strokeModel.beginStroke(100, 100, 0.5);
        this._strokeModel.appendPoint(120, 110, 0.6);
        this._strokeModel.commitCurrent();

        const slog = msg => {
            log(`annotations@eochis23.github.io: ${msg}`);
            Main.notify(_('Annotations motion test'), msg);
        };

        this._motion.runSyntheticSelfTest(slog);
    }
}
