/* SPDX-License-Identifier: GPL-2.0-or-later */
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { eventIsStylusLike, getPressure01, stylusModeOnPress } from './devices.js';

const PEN_COLORS = [
    [0.1, 0.1, 0.1],
    [1, 1, 1],
    [0.78, 0.16, 0.19],
    [0.15, 0.64, 0.41],
    [0.21, 0.52, 0.89],
    [0.48, 0.26, 0.65],
];

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

        this._root = new St.Widget({
            style_class: 'anno-overlay-root',
            reactive: true,
            visible: false,
            can_focus: false,
            track_hover: true,
        });
        Main.uiGroup.add_child(this._root);
        if (global.window_group)
            Main.uiGroup.set_child_above_sibling(this._root, global.window_group);

        this._canvas = new Clutter.Canvas();
        this._canvasActor = new Clutter.Actor({
            content: this._canvas,
            reactive: true,
            x_expand: true,
            y_expand: true,
        });
        this._root.add_child(this._canvasActor);

        this._canvas.connect('draw', (canvas, cr, width, height) => {
            this._model.paint(cr, width, height);
        });

        this._root.connect('notify::allocation', () => {
            const box = this._root.get_allocation_box();
            const w = Math.max(1, box.x2 - box.x1);
            const h = Math.max(1, box.y2 - box.y1);
            this._canvasActor.set_position(0, 0);
            this._canvasActor.set_size(w, h);
            this._canvas.set_size(w, h);
            this._canvas.invalidate();
        });

        this._canvasActor.connect('button-press-event', (actor, event) => this._onPress(actor, event));
        this._canvasActor.connect('motion-event', (actor, event) => this._onMotion(actor, event));
        this._canvasActor.connect('button-release-event', (actor, event) => this._onRelease(actor, event));

        this._buildDock();

        this._monitorsSig = global.display.connect('monitors-changed', () => this._syncGeometry());
        this._syncGeometry();

        this._model.setPenColor(...PEN_COLORS[0], 1.0);
    }

    _buildDock() {
        this._dock = new St.BoxLayout({
            style_class: 'anno-dock',
            vertical: true,
            reactive: true,
        });
        this._dock.set_position(14, 14);

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
            this._canvas.invalidate();
        });

        this._dock.add_child(swRow);
        this._dock.add_child(clearBtn);
        this._root.add_child(this._dock);
        this._root.set_child_above_sibling(this._dock, this._canvasActor);
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
    }

    /** Stage coords → local coords inside fullscreen canvas (same box as root). */
    _localFromEvent(event) {
        const coords = event.get_coords();
        if (!coords[0])
            return [0, 0];
        const sx = coords[1];
        const sy = coords[2];
        const [cx, cy] = this._canvasActor.get_transformed_position();
        return [sx - cx, sy - cy];
    }

    _onPress(actor, event) {
        if (!this._root.visible)
            return Clutter.EVENT_PROPAGATE;
        if (!eventIsStylusLike(event))
            return Clutter.EVENT_PROPAGATE;

        const mode = stylusModeOnPress(event);
        if (mode === 'none')
            return Clutter.EVENT_STOP;

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
        this._canvas.invalidate();
        return Clutter.EVENT_STOP;
    }

    _onMotion(actor, event) {
        if (!this._root.visible || !this._penDown)
            return Clutter.EVENT_PROPAGATE;
        if (!eventIsStylusLike(event))
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = this._localFromEvent(event);
        const p = getPressure01(event);

        if (this._model.eraserPath)
            this._model.appendErase(x, y);
        else
            this._model.appendPoint(x, y, p);
        this._canvas.invalidate();
        return Clutter.EVENT_STOP;
    }

    _onRelease(actor, event) {
        if (!this._root.visible)
            return Clutter.EVENT_PROPAGATE;
        if (!eventIsStylusLike(event))
            return Clutter.EVENT_PROPAGATE;

        this._penDown = false;
        if (this._model.eraserPath)
            this._model.finishErase();
        else
            this._model.commitCurrent();
        this._canvas.invalidate();
        return Clutter.EVENT_STOP;
    }

    toggle() {
        this._root.visible = !this._root.visible;
        if (!this._root.visible) {
            this._penDown = false;
            this._model.commitCurrent();
            this._model.finishErase();
        } else {
            this._syncGeometry();
        }
        this._canvas.invalidate();
    }

    get visible() {
        return this._root.visible;
    }

    destroy() {
        if (this._monitorsSig) {
            global.display.disconnect(this._monitorsSig);
            this._monitorsSig = 0;
        }
        if (this._root.get_parent())
            Main.uiGroup.remove_child(this._root);
        this._root.destroy();
    }
}
