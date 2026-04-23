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

/* Stable ids handed to Mutter; pen/touch press inside the matching rect
 * comes back as a RegionActivated signal that we route through
 * _activateRegion the same way mouse "clicked" does. */
function colorRegionId(i) {
    return `color-${i}`;
}
const CLEAR_REGION_ID = 'clear';

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
                /* Republish chrome regions: early publishes raced the bus
                 * name acquisition and likely got E_NAME_HAS_NO_OWNER. */
                this._regionsPublished = false;
                this._publishChromeRegions?.();
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

    _activateRegion(id) {
        if (id === CLEAR_REGION_ID) {
            dbusCall('Clear', null, err => {
                if (err)
                    console.warn(`Annotation Clear: ${err.message}`);
            });
            return;
        }
        if (id.startsWith('color-')) {
            const i = parseInt(id.slice('color-'.length), 10);
            const c = COLORS[i];
            if (!c)
                return;
            const params = new GLib.Variant('(dddd)', [c.r, c.g, c.b, c.a]);
            dbusCall('SetColor', params, err => {
                if (err)
                    console.warn(`Annotation SetColor: ${err.message}`);
            });
        }
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
        this._regionActivatedId = 0;
        this._regionsPublished = false;
        this._regionButtons = [];

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
            const id = colorRegionId(i);
            btn.connect('clicked', () => this._activateRegion(id));
            this._dock.add_child(btn);
            this._regionButtons.push({id, actor: btn});
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
        trash.connect('clicked', () => this._activateRegion(CLEAR_REGION_ID));
        this._dock.add_child(separator);
        this._dock.add_child(trash);
        this._regionButtons.push({id: CLEAR_REGION_ID, actor: trash});

        Main.uiGroup.add_child(this._dock);
        /* raise_top() is not always exposed on St actors in GJS; Shell uses this pattern. */
        Main.uiGroup.set_child_above_sibling(this._dock, null);

        if (Main.overview.visible)
            this._dock.hide();

        this._publishChromeRegions = () => {
            if (!this._dock || !this._regionButtons.length)
                return;
            if (!this._dock.visible) {
                this._clearChromeRegions();
                return;
            }
            const list = [];
            for (const {id, actor} of this._regionButtons) {
                if (!actor || actor.get_stage() === null)
                    continue;
                const [x, y] = actor.get_transformed_position();
                const [w, h] = actor.get_transformed_size();
                if (!(w > 0 && h > 0))
                    continue;
                list.push([id, Math.round(x), Math.round(y), Math.round(w), Math.round(h)]);
            }
            // #region agent log
            fetch('http://127.0.0.1:7559/ingest/80a2f4a9-78cb-409a-8218-b1ab6873e06c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'da8410'},body:JSON.stringify({sessionId:'da8410',hypothesisId:'H1+H2',location:'extension.js:_publishChromeRegions',message:'about to call SetChromeRegions',data:{count:list.length,list,dockVisible:this._dock?.visible,dockPos:this._dock ? [this._dock.x,this._dock.y] : null,dockSize:this._dock ? [this._dock.width,this._dock.height] : null},timestamp:Date.now()})}).catch(()=>{});
            // #endregion
            if (!list.length) {
                this._clearChromeRegions();
                return;
            }
            dbusCall(
                'SetChromeRegions',
                new GLib.Variant('(a(siiii))', [list]),
                err => {
                    // #region agent log
                    fetch('http://127.0.0.1:7559/ingest/80a2f4a9-78cb-409a-8218-b1ab6873e06c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'da8410'},body:JSON.stringify({sessionId:'da8410',hypothesisId:'H1',location:'extension.js:_publishChromeRegions:reply',message:'SetChromeRegions reply',data:{error:err ? err.message : null},timestamp:Date.now()})}).catch(()=>{});
                    // #endregion
                    if (err) {
                        this._regionsPublished = false;
                        return;
                    }
                    this._regionsPublished = true;
                });
        };

        this._clearChromeRegions = () => {
            if (!this._regionsPublished)
                return;
            this._regionsPublished = false;
            dbusCall('ClearChromeRegions', null, null);
        };

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
            this._publishChromeRegions();
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
            if (!this._dock)
                return;
            this._dock.hide();
            this._clearChromeRegions();
        });
        this._overviewHiddenId = Main.overview.connect('hidden', () => {
            if (!this._dock)
                return;
            this._dock.show();
            Main.uiGroup.set_child_above_sibling(this._dock, null);
            this._positionDock();
        });

        this._regionActivatedId = Gio.DBus.session.signal_subscribe(
            BUS,
            IFACE,
            'RegionActivated',
            PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (conn_, sender_, path_, iface_, signal_, params) => {
                // #region agent log
                try {
                    const [dbgId, dbgKind] = params.deep_unpack();
                    fetch('http://127.0.0.1:7559/ingest/80a2f4a9-78cb-409a-8218-b1ab6873e06c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'da8410'},body:JSON.stringify({sessionId:'da8410',hypothesisId:'H1+H3',location:'extension.js:RegionActivated',message:'RegionActivated received',data:{id:dbgId,kind:dbgKind,dockAlive:!!this._dock},timestamp:Date.now()})}).catch(()=>{});
                } catch (e) {}
                // #endregion
                if (!this._dock)
                    return;
                const [id, kind] = params.deep_unpack();
                /* Mirror St.Button: act on release, not press. */
                if (kind !== 'release' && kind !== 'touch-end')
                    return;
                this._activateRegion(id);
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

        if (this._regionActivatedId) {
            Gio.DBus.session.signal_unsubscribe(this._regionActivatedId);
            this._regionActivatedId = 0;
        }

        if (this._annotationBusWatchId) {
            Gio.bus_unwatch_name(this._annotationBusWatchId);
            this._annotationBusWatchId = 0;
        }
        this._setActiveRetryId = removeSource(this._setActiveRetryId);

        /* Stale chrome regions can swallow pen input even after our actor is
         * gone, so always send a fire-and-forget clear before SetActive(false). */
        dbusCall('ClearChromeRegions', null, null);
        this._regionsPublished = false;

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
        this._regionButtons = [];
        this._publishChromeRegions = null;
        this._clearChromeRegions = null;

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
