/* SPDX-License-Identifier: GPL-2.0-or-later */
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { eventIsDrawInput, getPressure01, stylusModeOnPress } from './devices.js';

const PEN_COLORS = [
    [0.1, 0.1, 0.1],
    [1, 1, 1],
    [0.78, 0.16, 0.19],
    [0.15, 0.64, 0.41],
    [0.21, 0.52, 0.89],
    [0.48, 0.26, 0.65],
];

/**
 * `Main.uiGroup` uses `no_layout=true`; children must implement `vfunc_allocate` or they
 * keep a 0×0 box — `St.DrawingArea` then has no surface and never receives pointer events.
 */
const AnnoOverlayRoot = GObject.registerClass(
class AnnoOverlayRoot extends St.Widget {
    /**
     * @param {St.DrawingArea} drawArea
     * @param {St.Widget} dock
     */
    _init(drawArea, dock) {
        super._init({
            style_class: 'anno-overlay-root',
            reactive: true,
            visible: false,
            can_focus: false,
            track_hover: true,
        });
        this._annoDraw = drawArea;
        this._annoDock = dock;
        this.add_child(drawArea);
        this.add_child(dock);
        this.set_child_above_sibling(dock, drawArea);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const w = Math.max(1, Math.round(box.get_width?.() ?? box.x2 - box.x1));
        const h = Math.max(1, Math.round(box.get_height?.() ?? box.y2 - box.y1));

        const drawBox = new Clutter.ActorBox();
        drawBox.x1 = 0;
        drawBox.y1 = 0;
        drawBox.x2 = w;
        drawBox.y2 = h;
        /* Shell uses one-arg allocate(); a second flags arg can throw with some GI stacks. */
        this._annoDraw.allocate(drawBox);

        let natDockW = 160;
        let natDockH = 120;
        try {
            const sz = this._annoDock.get_preferred_size();
            if (Array.isArray(sz) && sz.length >= 4) {
                natDockW = Math.max(1, Math.round(sz[2]));
                natDockH = Math.max(1, Math.round(sz[3]));
            }
        } catch {
            /* ignore */
        }
        const dockBox = new Clutter.ActorBox();
        dockBox.x1 = 14;
        dockBox.y1 = 14;
        dockBox.x2 = 14 + natDockW;
        dockBox.y2 = 14 + natDockH;
        this._annoDock.allocate(dockBox);
    }
});

export class OverlaySession {
    /**
     * @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension
     * @param {import('./strokes.js').StrokeModel} strokeModel
     */
    constructor(extension, strokeModel) {
        this._ext = extension;
        this._model = strokeModel;
        this._penDown = false;
        this._monitorsSig = 0;

        this._drawArea = new St.DrawingArea({
            reactive: true,
            can_focus: false,
            style_class: 'anno-overlay-canvas',
        });

        this._dock = this._createDock();

        this._root = new AnnoOverlayRoot(this._drawArea, this._dock);
        if (Main.layoutManager.addTopChrome)
            Main.layoutManager.addTopChrome(this._root, { trackFullscreen: false });
        else
            Main.uiGroup.add_child(this._root);
        this._ensureStackedOnTop();

        this._drawArea.connect('repaint', () => {
            const cr = this._drawArea.get_context();
            if (!cr)
                return;
            try {
                const box = this._drawArea.get_allocation_box();
                const w = Math.max(1, box.x2 - box.x1);
                const h = Math.max(1, box.y2 - box.y1);
                this._model.paint(cr, w, h);
            } finally {
                cr.$dispose();
            }
        });

        this._drawArea.connect('button-press-event', (actor, event) => this._onPress(actor, event));
        this._drawArea.connect('motion-event', (actor, event) => this._onMotion(actor, event));
        this._drawArea.connect('button-release-event', (actor, event) => this._onRelease(actor, event));

        this._monitorsSig = Main.layoutManager.connect('monitors-changed', () => {
            this._syncGeometry();
            this._ensureStackedOnTop();
        });
        this._syncGeometry();
        this._ensureStackedOnTop();

        this._model.setPenColor(...PEN_COLORS[0], 1.0);
    }

    /** Above panel/OSD chrome: do not anchor only to `window_group` or the panel paints over us. */
    _ensureStackedOnTop() {
        const parent = this._root.get_parent();
        if (!parent)
            return;
        if (this._root.raise_top) {
            this._root.raise_top();
            return;
        }
        const last = parent.get_last_child();
        if (last && last !== this._root)
            parent.set_child_above_sibling(this._root, last);
    }

    _createDock() {
        const dock = new St.BoxLayout({
            style_class: 'anno-dock',
            vertical: true,
            reactive: true,
        });
        const swRow = new St.BoxLayout({ vertical: false, style_class: 'anno-dock-swatches' });
        this._swatchButtons = [];
        for (let i = 0; i < PEN_COLORS.length; i++) {
            const [r, g, b] = PEN_COLORS[i];
            const btn = new St.Button({
                style_class: 'anno-swatch',
                reactive: true,
                can_focus: false,
            });
            const rgba = `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},1)`;
            btn.set_style(`background-color: ${rgba}; min-width: 26px; min-height: 26px; border-radius: 99px;`);
            const idx = i;
            btn.connect('clicked', () => {
                for (const b0 of this._swatchButtons)
                    b0.remove_style_class_name('anno-swatch-selected');
                btn.add_style_class_name('anno-swatch-selected');
                const [r0, g0, b0] = PEN_COLORS[idx];
                this._model.setPenColor(r0, g0, b0, 1.0);
            });
            this._swatchButtons.push(btn);
            swRow.add_child(btn);
        }
        if (this._swatchButtons[0])
            this._swatchButtons[0].add_style_class_name('anno-swatch-selected');

        const clearBtn = new St.Button({
            style_class: 'anno-dock-clear',
            label: _('Clear all'),
            reactive: true,
            can_focus: false,
        });
        clearBtn.connect('clicked', () => {
            this._model.clearAll();
            this._drawArea.queue_repaint();
        });

        dock.add_child(swRow);
        dock.add_child(clearBtn);
        return dock;
    }

    _syncGeometry() {
        const d = global.display;
        let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
        for (let i = 0; i < d.get_n_monitors(); i++) {
            const g = d.get_monitor_geometry(i);
            x1 = Math.min(x1, g.x);
            y1 = Math.min(y1, g.y);
            x2 = Math.max(x2, g.x + g.width);
            y2 = Math.max(y2, g.y + g.height);
        }
        this._root.set_position(x1, y1);
        this._root.set_size(x2 - x1, y2 - y1);
        this._root.queue_relayout();
    }

    /** Stage coords → local coords inside fullscreen canvas (same box as root). */
    _localFromEvent(event) {
        let sx;
        let sy;
        try {
            const coords = event.get_coords();
            if (!coords || coords.length < 2)
                return [0, 0];
            /* Some stacks: [ok, stageX, stageY]; newer paths can return [stageX, stageY] only (logs showed y=null). */
            if (coords.length >= 3 && typeof coords[0] === 'boolean') {
                if (!coords[0])
                    return [0, 0];
                sx = coords[1];
                sy = coords[2];
            } else {
                sx = coords[0];
                sy = coords[1];
            }
        } catch {
            return [0, 0];
        }
        if (typeof sx !== 'number' || typeof sy !== 'number' || Number.isNaN(sx) || Number.isNaN(sy))
            return [0, 0];
        const [cx, cy] = this._drawArea.get_transformed_position();
        return [sx - cx, sy - cy];
    }

    _onPress(actor, event) {
        try {
            if (!this._root.visible)
                return Clutter.EVENT_PROPAGATE;
            if (!eventIsDrawInput(event))
                return Clutter.EVENT_PROPAGATE;

            const mode = stylusModeOnPress(event);
            if (mode === 'none')
                return Clutter.EVENT_PROPAGATE;

            const [x, y] = this._localFromEvent(event);
            const p = getPressure01(event);

            if (mode === 'erase') {
                this._model.commitCurrent();
                this._model.beginErase(x, y);
            } else {
                this._model.finishErase();
                this._model.beginStroke(x, y, p);
            }
            this._penDown = true;
            this._drawArea.queue_repaint();
            return Clutter.EVENT_STOP;
        } catch (e) {
            logError(e, 'annotations overlay press');
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _onMotion(actor, event) {
        try {
            if (!this._root.visible || !this._penDown)
                return Clutter.EVENT_PROPAGATE;
            if (!eventIsDrawInput(event))
                return Clutter.EVENT_PROPAGATE;

            const [x, y] = this._localFromEvent(event);
            const p = getPressure01(event);

            if (this._model.eraserPath)
                this._model.appendErase(x, y);
            else
                this._model.appendPoint(x, y, p);
            this._drawArea.queue_repaint();
            return Clutter.EVENT_STOP;
        } catch (e) {
            logError(e, 'annotations overlay motion');
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _onRelease(actor, event) {
        try {
            if (!this._root.visible)
                return Clutter.EVENT_PROPAGATE;
            if (!eventIsDrawInput(event))
                return Clutter.EVENT_PROPAGATE;

            this._penDown = false;
            if (this._model.eraserPath)
                this._model.finishErase();
            else
                this._model.commitCurrent();
            this._drawArea.queue_repaint();
            return Clutter.EVENT_STOP;
        } catch (e) {
            logError(e, 'annotations overlay release');
            return Clutter.EVENT_PROPAGATE;
        }
    }

    toggle() {
        this._root.visible = !this._root.visible;
        if (!this._root.visible) {
            this._penDown = false;
            this._model.commitCurrent();
            this._model.finishErase();
        } else {
            this._syncGeometry();
            this._ensureStackedOnTop();
        }
        this._drawArea.queue_repaint();
    }

    get visible() {
        return this._root.visible;
    }

    destroy() {
        if (this._monitorsSig) {
            Main.layoutManager.disconnect(this._monitorsSig);
            this._monitorsSig = 0;
        }
        if (this._root.get_parent()) {
            if (Main.layoutManager.removeChrome)
                Main.layoutManager.removeChrome(this._root);
            else
                Main.uiGroup.remove_child(this._root);
        }
        this._root.destroy();
    }
}
