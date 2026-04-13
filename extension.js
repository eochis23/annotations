/* SPDX-License-Identifier: GPL-2.0-or-later */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { MotionSyncService } from './lib/motionSync.js';
import { OverlaySession } from './lib/overlaySession.js';
import { StrokeModel } from './lib/strokes.js';

/** Must match the `as` accelerator key in our gschema (Meta reads it from `settings`). */
const KEYBINDING_SCHEMA_KEY = 'toggle-overlay';

function actionModesForOverlay() {
    const AM = Shell.ActionMode;
    let m = AM.NORMAL | AM.OVERVIEW;
    if (AM.POPUP !== undefined)
        m |= AM.POPUP;
    if (AM.MESSAGE_TRAY !== undefined)
        m |= AM.MESSAGE_TRAY;
    if (AM.ALL !== undefined)
        m = AM.ALL;
    return m;
}

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

        const toggleItem = new PopupMenu.PopupMenuItem(_('Toggle drawing layer'));
        toggleItem.connect('activate', () => {
            ext.toggleDrawingOverlay();
        });
        this.menu.addMenuItem(toggleItem);

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
        this._settings = this.getSettings();
        this._strokeModel = new StrokeModel();
        this._motion = new MotionSyncService(this, this._strokeModel);
        this._motion.enable();

        this._overlay = new OverlaySession(this, this._strokeModel);

        this._shellForkSettings = null;
        try {
            const src = Gio.SettingsSchemaSource.get_default();
            const sch = src?.lookup('org.gnome.shell', true);
            if (sch?.has_key('annotation-pointer-passthrough'))
                this._shellForkSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
        } catch (e) {
            log(`annotations: forked org.gnome.shell annotation-pointer-passthrough unavailable: ${e}`);
        }

        /* Empty accelerator if schema was not recompiled after upgrade — reset so WM binds. */
        try {
            const acc = this._settings.get_strv('toggle-overlay');
            if (!acc || acc.length === 0 || (acc.length === 1 && !acc[0]))
                this._settings.reset('toggle-overlay');
        } catch (e) {
            log(`annotations: toggle-overlay key missing, reset schema: ${e}`);
        }

        this._kbIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._kbIdle = 0;
            try {
                Main.wm.addKeybinding(
                    KEYBINDING_SCHEMA_KEY,
                    this._settings,
                    Meta.KeyBindingFlags.NONE,
                    actionModesForOverlay(),
                    () => {
                        this.toggleDrawingOverlay();
                    });
            } catch (e) {
                logError(e, 'annotations addKeybinding');
            }
            return GLib.SOURCE_REMOVE;
        });

        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._kbIdle) {
            GLib.source_remove(this._kbIdle);
            this._kbIdle = 0;
        }
        try {
            Main.wm.removeKeybinding(KEYBINDING_SCHEMA_KEY);
        } catch (e) {
            log(`annotations removeKeybinding: ${e}`);
        }

        this.syncShellPointerPassthrough(false);

        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }

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

    toggleDrawingOverlay() {
        if (this._overlay)
            this._overlay.toggle();
    }

    /**
     * When using the forked GNOME Shell + Mutter pair, toggles compositor pointer passthrough
     * so core pointer events reach clients under Shell chrome while the overlay is visible.
     */
    syncShellPointerPassthrough(visible) {
        if (!this._shellForkSettings)
            return;
        try {
            this._shellForkSettings.set_boolean('annotation-pointer-passthrough', !!visible);
        } catch (e) {
            log(`annotations: set annotation-pointer-passthrough: ${e}`);
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
