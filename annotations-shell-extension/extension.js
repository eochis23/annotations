/* SPDX-License-Identifier: GPL-2.0-or-later */

/* Do not import stylesheet.css here — GJS would parse it as JS and fail on
 * the leading '.'. GNOME Shell loads extension stylesheet.css automatically
 * (see extensionSystem.js _loadExtensionStylesheet) before enable() runs. */

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

const COLOR_LABELS = [
    'Red pen',
    'Blue pen',
    'Green pen',
    'Yellow pen',
    'White pen',
    'Black pen',
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

function removeSource(id) {
    if (id)
        GLib.source_remove(id);
    return 0;
}

export default class AnnotationExtension extends Extension {
    _trySetAnnotationActive() {
        dbusCall('SetActive', new GLib.Variant('(b)', [true]), err => {
            if (!err) {
                this._annotationSessionActiveOk = true;
                return;
            }
            if (!this._dock)
                return;
            console.warn(
                `Annotation SetActive(true): ${err.message} ` +
                '(waiting for org.gnome.Mutter.Annotation on the session bus)');
        });
    }

    _startAnnotationActivation() {
        /* Mutter owns the name asynchronously; immediate SetActive often races. */
        this._annotationSessionActiveOk = false;
        this._setActiveRetryCount = 0;

        this._trySetAnnotationActive();

        if (!this._annotationBusWatchId) {
            this._annotationBusWatchId = Gio.bus_watch_name(
                Gio.BusType.SESSION,
                BUS,
                Gio.BusNameWatcherFlags.NONE,
                (conn, name, owner) => {
                    if (owner && owner.length > 0)
                        this._trySetAnnotationActive();
                },
                null);
        }

        this._setActiveRetryId = removeSource(this._setActiveRetryId);
        this._setActiveRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            if (!this._dock) {
                this._setActiveRetryId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (this._annotationSessionActiveOk) {
                this._setActiveRetryId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (this._setActiveRetryCount++ >= 40) {
                console.error(
                    'Annotation SetActive(true) still failing after ~12s of retries. ' +
                    'Use a Mutter build from the annotations project (org.gnome.Mutter.Annotation D-Bus).');
                this._setActiveRetryId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._trySetAnnotationActive();
            return GLib.SOURCE_CONTINUE;
        });
    }

    enable() {
        this._dockPositionTimeout = 0;
        this._idlePos = 0;
        this._monitorsId = 0;
        this._allocId = 0;
        this._dockRetry = 0;
        this._annotationBusWatchId = 0;
        this._setActiveRetryId = 0;
        this._setActiveRetryCount = 0;
        this._annotationSessionActiveOk = false;
        this._allocDebounceId = 0;
        this._overviewShowingId = 0;
        this._overviewHiddenId = 0;

        this._dock = new St.BoxLayout({
            style_class: 'annotation-dock',
            vertical: false,
            reactive: true,
        });

        COLORS.forEach((c, i) => {
            const btn = new St.Button({
                style_class: 'annotation-color-button',
                can_focus: true,
                accessible_name: COLOR_LABELS[i] ?? `Annotation color ${i + 1}`,
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
        });

        const separator = new St.Widget({
            style_class: 'annotation-dock-separator',
        });

        const trash = new St.Button({
            style_class: 'annotation-trash-button',
            can_focus: true,
            accessible_name: 'Clear all annotations',
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
        this._dock.add_child(separator);
        this._dock.add_child(trash);

        Main.uiGroup.add_child(this._dock);
        /* raise_top() is not always exposed on St actors in GJS; Shell uses this pattern. */
        Main.uiGroup.set_child_above_sibling(this._dock, null);

        if (Main.overview.visible)
            this._dock.hide();

        this._positionDock = () => {
            if (!this._dock)
                return;
            const mon = Main.layoutManager.primaryMonitor;
            if (!mon || mon.width < 1 || mon.height < 1)
                return;
            const {x, y, width, height} = mon;
            const dw = this._dock.width > 0 ? this._dock.width : 1;
            const dh = this._dock.height > 0 ? this._dock.height : 1;
            this._dock.set_position(
                Math.round(x + (width - dw) / 2),
                Math.round(y + height - dh - 24));
        };

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            this._positionDock();
        });

        this._allocId = this._dock.connect('notify::allocation', () => {
            this._allocDebounceId = removeSource(this._allocDebounceId);
            this._allocDebounceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._allocDebounceId = 0;
                this._positionDock();
                return GLib.SOURCE_REMOVE;
            });
        });

        this._overviewShowingId = Main.overview.connect('showing', () => {
            if (this._dock)
                this._dock.hide();
        });
        this._overviewHiddenId = Main.overview.connect('hidden', () => {
            if (!this._dock)
                return;
            this._dock.show();
            Main.uiGroup.set_child_above_sibling(this._dock, null);
            this._positionDock();
        });

        const schedulePositionRetries = () => {
            if (!this._dock)
                return;
            this._positionDock();
            if ((!Main.layoutManager.primaryMonitor ||
                this._dock.width < 8) &&
                this._dockRetry < 40) {
                this._dockRetry++;
                this._dockPositionTimeout = removeSource(this._dockPositionTimeout);
                this._dockPositionTimeout = GLib.timeout_add(
                    GLib.PRIORITY_LOW, 100, () => {
                        this._dockPositionTimeout = 0;
                        schedulePositionRetries();
                        return GLib.SOURCE_REMOVE;
                    });
            }
        };
        this._idlePos = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            schedulePositionRetries();
            this._idlePos = 0;
            return GLib.SOURCE_REMOVE;
        });

        this._startAnnotationActivation();
    }

    disable() {
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = 0;
        }
        if (this._overviewHiddenId) {
            Main.overview.disconnect(this._overviewHiddenId);
            this._overviewHiddenId = 0;
        }

        if (this._annotationBusWatchId) {
            Gio.bus_unwatch_name(this._annotationBusWatchId);
            this._annotationBusWatchId = 0;
        }
        this._setActiveRetryId = removeSource(this._setActiveRetryId);

        dbusCall('SetActive', new GLib.Variant('(b)', [false]), null);

        this._idlePos = removeSource(this._idlePos);
        this._dockPositionTimeout = removeSource(this._dockPositionTimeout);
        this._allocDebounceId = removeSource(this._allocDebounceId);

        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }

        const dock = this._dock;
        this._dock = null;

        if (dock) {
            if (this._allocId) {
                dock.disconnect(this._allocId);
                this._allocId = 0;
            }
            if (dock.get_parent())
                dock.get_parent().remove_child(dock);
            dock.destroy();
        }
    }
}
