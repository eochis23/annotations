/* SPDX-License-Identifier: GPL-2.0-or-later */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS = 'org.gnome.Mutter.Annotation';
const PATH = '/org/gnome/Mutter/Annotation';
const IFACE = 'org.gnome.Mutter.Annotation';

const COLORS = [
    {r: 0.95, g: 0.25, b: 0.25, a: 1.0},
    {r: 0.2, g: 0.55, b: 0.95, a: 1.0},
    {r: 0.25, g: 0.75, b: 0.35, a: 1.0},
    {r: 0.95, g: 0.85, b: 0.2, a: 1.0},
    {r: 0.9, g: 0.9, b: 0.9, a: 1.0},
    {r: 0.15, g: 0.15, b: 0.15, a: 1.0},
];

function dbusCall(methodName, parameters, replyHandler) {
    Gio.DBus.session.call(
        BUS,
        PATH,
        IFACE,
        methodName,
        parameters ?? null,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (c, res) => {
            try {
                c.call_finish(res);
                replyHandler?.(null);
            } catch (e) {
                replyHandler?.(e);
            }
        });
}

export default class AnnotationExtension extends Extension {
    enable() {
        this._dock = new St.BoxLayout({
            style_class: 'annotation-dock',
            vertical: false,
            reactive: true,
        });

        for (const c of COLORS) {
            const btn = new St.Button({
                style_class: 'annotation-color-button',
                can_focus: true,
            });
            btn.set_style(`background-color: rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a});`);
            btn.connect('clicked', () => {
                const params = new GLib.Variant('(dddd)', [c.r, c.g, c.b, c.a]);
                dbusCall('SetColor', params, err => {
                    if (err)
                        console.warn(`Annotation SetColor: ${err.message}`);
                });
            });
            this._dock.add_child(btn);
        }

        const trash = new St.Button({
            style_class: 'annotation-trash-button',
            can_focus: true,
            child: new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'system-status-icon',
            }),
        });
        trash.connect('clicked', () => {
            dbusCall('Clear', null, err => {
                if (err)
                    console.warn(`Annotation Clear: ${err.message}`);
            });
        });
        this._dock.add_child(trash);

        Main.uiGroup.add_child(this._dock);
        this._dock.raise_top();

        this._positionDock = () => {
            const {x, y, width, height} = Main.layoutManager.primaryMonitor;
            this._dock.set_position(
                Math.round(x + (width - this._dock.width) / 2),
                Math.round(y + height - this._dock.height - 24));
        };

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._positionDock());
        this._idlePos = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._positionDock();
            this._idlePos = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._idlePos)
            GLib.source_remove(this._idlePos);
        this._idlePos = 0;
        this._dock.destroy();
        this._dock = null;
    }
}
