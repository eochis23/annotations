/* SPDX-License-Identifier: GPL-2.0-or-later */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { annoDebug } from './annoDebug.js';
import {
    clutterEventType,
    eventHasPressure,
    eventHasStylusDeviceTool,
    eventIsPenDrawDevice,
    eventIsPointerButtonOrMotion,
    getPressure01,
    isLikelyKeyOrScrollEvent,
    overlayPenCanvasAcceptsPickEvent,
    stylusModeOnPress,
} from './devices.js';

/** Pressure above this starts a stroke when the driver never sends BUTTON_PRESS (tablet + Wayland). */
const IMPLICIT_PRESSURE_START = 0.015;
/** After pen leaves digitizer range, ignore first discrete press; require this much stage movement (px²) before ink. */
const PEN_INK_DRAG_UNLOCK2 = 8 * 8;
/** Tablet stage coords can sit on the dock rect while `global.get_pointer()` follows the tip on canvas (log I). */
const TABLET_DOCK_COORD_SLACK2 = 80 * 80;

const PEN_COLORS = [
    [0.1, 0.1, 0.1],
    [1, 1, 1],
    [0.78, 0.16, 0.19],
    [0.15, 0.64, 0.41],
    [0.21, 0.52, 0.89],
    [0.48, 0.26, 0.65],
];

/**
 * Fullscreen ink surface: omit from Clutter pick for mouse/touch so clicks reach windows below;
 * pen / tablet tool still hits this actor (see {@link overlayPenCanvasAcceptsPickEvent}).
 */
const PenOverlayDrawingArea = GObject.registerClass(
class PenOverlayDrawingArea extends St.DrawingArea {
    static _pickSampleN = 0;

    vfunc_pick(pickContext) {
        let ev = null;
        try {
            ev = Clutter.get_current_event();
        } catch {
            ev = null;
        }
        let accept = overlayPenCanvasAcceptsPickEvent(ev);
        /* Log: `get_current_event()` is null during most pick passes (`hasEv:false`). While a stroke
         * is active, accept pick so the canvas stays in the delivery chain — but never over the
         * dock rect (fullscreen canvas would otherwise steal dock pen hits). */
        if (
            !accept &&
            this._annoSession?._penDown &&
            (ev == null || !isLikelyKeyOrScrollEvent(ev))
        ) {
            if (!this._annoSession._penEventLikelyOverDockPalette(ev))
                accept = true;
        }
        /* Pen over dock: reject canvas so swatches stay usable (same AABB as capture commit). */
        if (accept && this._annoSession && this._annoSession._penEventLikelyOverDockPalette(ev))
            accept = false;
        const sample = PenOverlayDrawingArea._pickSampleN < 35;
        if (sample) {
            PenOverlayDrawingArea._pickSampleN++;
            let mode = -1;
            try {
                mode = pickContext?.get_mode?.() ?? -1;
            } catch {
                mode = -2;
            }
            // #region agent log
            annoDebug({
                hypothesisId: 'A',
                location: 'overlaySession.js:PenOverlayDrawingArea.vfunc_pick',
                message: 'canvas pick',
                data: {
                    hasEv: !!ev,
                    accept,
                    pickMode: mode,
                    willSuper: accept,
                    typeofPick: typeof this.pick,
                    penDownPick: !!(
                        this._annoSession?._penDown &&
                        !(ev && isLikelyKeyOrScrollEvent(ev)) &&
                        !this._annoSession._penEventLikelyOverDockPalette(ev)
                    ),
                },
            });
            // #endregion
        }
        if (!accept)
            return;
        super.vfunc_pick(pickContext);
    }
});

/**
 * `Main.uiGroup` uses `no_layout=true`; children must implement `vfunc_allocate` or they
 * keep a 0×0 box — `St.DrawingArea` then has no surface and never receives pointer events.
 */
const AnnoOverlayRoot = GObject.registerClass(
class AnnoOverlayRoot extends St.Widget {
    static _rootPickSampleN = 0;

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

    /**
     * Do not run St.Widget's default pick (full allocation), or the root would still
     * capture mouse on the canvas even when {@link PenOverlayDrawingArea} skips pick.
     */
    vfunc_pick(pickContext) {
        const dockPick = typeof this._annoDock.pick;
        const drawPick = typeof this._annoDraw.pick;
        let delegated = false;
        for (const ch of [this._annoDock, this._annoDraw]) {
            if (typeof ch.pick === 'function') {
                try {
                    ch.pick(pickContext);
                    delegated = true;
                } catch {
                    /* ignore */
                }
            }
        }
        if (AnnoOverlayRoot._rootPickSampleN < 35) {
            AnnoOverlayRoot._rootPickSampleN++;
            // #region agent log
            annoDebug({
                hypothesisId: 'B',
                location: 'overlaySession.js:AnnoOverlayRoot.vfunc_pick',
                message: 'root pick delegate',
                data: {
                    dockPick,
                    drawPick,
                    delegated,
                    callSuper: !delegated,
                },
            });
            // #endregion
        }
        if (!delegated)
            super.vfunc_pick(pickContext);
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
        /* Match dock palette hit-test caps — uncapped naturals can allocate a huge invisible dock
         * while hit-testing used a small rect (logs: inDock vs canvas). */
        natDockW = Math.min(Math.max(natDockW, 48), 360);
        natDockH = Math.min(Math.max(natDockH, 48), 300);
        const dockBox = new Clutter.ActorBox();
        const session = this._annoDraw._annoSession;
        const dx = session?._dockPos?.x ?? 14;
        const dy = session?._dockPos?.y ?? 14;
        dockBox.x1 = dx;
        dockBox.y1 = dy;
        dockBox.x2 = dx + natDockW;
        dockBox.y2 = dy + natDockH;
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
        /** True after PROXIMITY_IN until PROXIMITY_OUT; avoids hover MOTION starting a stroke cold. */
        this._penProximityArmed = false;
        /** `Date.now()` when proximity armed; pointer MOTION right after is often the pen tip (logs G). */
        this._penProximityArmedAt = 0;
        /** @type {number} DEBUG: first N presses logged */
        this._pressDbgN = 0;
        /** @type {number} DEBUG: first N pen capture samples */
        this._penCapDbgN = 0;
        /** @type {number} DEBUG: first N capture entry samples (hypothesis G) */
        this._penCapEntryDbgN = 0;
        /** @type {Array<{ actor: object, id: number }>} `captured-event` on stage + uiGroup when both exist */
        this._penCapConnections = [];
        /** Dedupe when the same Clutter event is delivered on multiple capture actors (WeakSet has no delete API). */
        this._penCapHandled = null;
        /** @type {number} DEBUG: capture rejected by _penCaptureAcceptsEvent (hypothesis J) */
        this._penCapRejDbgN = 0;
        /** When set, {@link _localFromEvent} uses this stage pair instead of {@link _stageCoordsFromEvent}. */
        this._penCapStageXYUse = false;
        /** @type {[number, number]|null} */
        this._penCapStageXYPair = null;
        /** @type {number} DEBUG: first N coord-repair samples (hypothesis H) */
        this._penCoordRepairDbgN = 0;
        /** @type {number} DEBUG: dock vs master pointer disagree (hypothesis I) */
        this._penDockPtrOverrideDbgN = 0;
        /** Last in-root stage coords used for a stroke (fallback when stream omits event type or xy). */
        this._lastGoodCapStageXY = null;
        /** @type {number} DEBUG: stroke-stream fallback (hypothesis K) */
        this._penStrokeStreamCapDbgN = 0;
        /** @type {number} DEBUG: tablet 0,0 → motion coerce (hypothesis M) */
        this._penTabletCoerceDbgN = 0;
        /** @type {number} DEBUG: unknown evKind → motion while penDown (hypothesis N) */
        this._penUnknownMotionDbgN = 0;
        /** @type {number} DEBUG: any capture callback while penDown (hypothesis P) */
        this._penCapWhileDownDbgN = 0;
        /** @type {number} DEBUG: repeat press-type stream → _onMotion (hypothesis Q) */
        this._penDupPressDbgN = 0;
        /** @type {number} DEBUG: pen forwarded to dock swatch/clear (hypothesis S) */
        this._penDockFwdDbgN = 0;
        /** @type {St.Button|null} */
        this._clearBtn = null;
        /** @type {number} DEBUG: evT 17 → lastGood (hypothesis T) */
        this._penGhost17DbgN = 0;
        /**
         * After PROXIMITY_OUT or overlay shown: first tablet/pen discrete press does not start ink
         * (avoids hover/stale coords → spokes); real ink after drag ≥ {@link PEN_INK_DRAG_UNLOCK2} or
         * a normal press once this flag is cleared. Implicit press is suppressed while this is true.
         */
        this._penAwaitInkAfterRange = true;
        /** Stage coords of the swallowed discrete press while {@link _penAwaitInkAfterRange}. */
        this._penDeferredAnchorStageXY = null;
        /** @type {number} DEBUG: deferred-ink path (hypothesis V) */
        this._penDeferredInkDbgN = 0;
        /** @type {number} DEBUG: propagate to dock when pointer on dock but tablet xy misses (hypothesis W) */
        this._penDockPenPtrDbgN = 0;
        this._monitorsSig = 0;

        /** Dock position inside overlay root (pixels). */
        this._dockPos = { x: 14, y: 14 };
        this._dockShrinkSrc = 0;
        this._dockShrunk = false;
        /** @type {number|undefined} */
        this._dockDragSeq = undefined;
        /** @type {number|undefined} */
        this._dockDragSafetySrc = undefined;
        /** @type {[number, number]|null} */
        this._dockDragLast = null;

        this._drawArea = new PenOverlayDrawingArea({
            reactive: true,
            can_focus: false,
            style_class: 'anno-overlay-canvas',
        });
        this._drawArea._annoSession = this;

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
                this._model.paint(cr, w, h, this._computeWindowClipRects());
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
        this._syncPenStageCapture();

        try {
            const st = this._ext.getSettings();
            const sch = st.get_schema();
            if (sch.has_key('dock-x') && sch.has_key('dock-y')) {
                this._dockPos.x = st.get_int('dock-x');
                this._dockPos.y = st.get_int('dock-y');
            }
        } catch {
            /* ignore */
        }
    }

    _saveDockPos() {
        try {
            const st = this._ext.getSettings();
            const sch = st.get_schema();
            if (sch.has_key('dock-x') && sch.has_key('dock-y')) {
                st.set_int('dock-x', Math.round(this._dockPos.x));
                st.set_int('dock-y', Math.round(this._dockPos.y));
            }
        } catch {
            /* ignore */
        }
    }

    _bumpDockActivity() {
        if (this._dockShrinkSrc)
            GLib.source_remove(this._dockShrinkSrc);
        this._dockShrinkSrc = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._dockShrinkSrc = 0;
            if (this._dock && this._root?.visible) {
                this._dockShrunk = true;
                this._dock.set_scale(0.72, 0.72);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _dockExpandIfShrunk() {
        if (!this._dockShrunk || !this._dock)
            return;
        this._dockShrunk = false;
        this._dock.set_scale(1, 1);
    }

    /**
     * @returns {{seq:number,x:number,y:number,w:number,h:number}[]}
     */
    _computeWindowClipRects() {
        const [ax, ay] = this._drawArea.get_transformed_position();
        const out = [];
        try {
            const actors = global.get_window_actors();
            for (let i = 0; i < actors.length; i++) {
                const mw = actors[i].meta_window;
                if (mw.minimized)
                    continue;
                const r = mw.get_frame_rect();
                out.push({
                    seq: mw.get_stable_sequence(),
                    x: r.x - ax,
                    y: r.y - ay,
                    w: r.width,
                    h: r.height,
                });
            }
        } catch {
            /* ignore */
        }
        return out;
    }

    /** @returns {number} stable_sequence or -1 (desktop / no window) */
    _windowSeqFromLocal(lx, ly) {
        const [ax, ay] = this._drawArea.get_transformed_position();
        const sx = lx + ax;
        const sy = ly + ay;
        try {
            const actors = global.get_window_actors();
            for (let i = actors.length - 1; i >= 0; i--) {
                const mw = actors[i].meta_window;
                if (mw.minimized)
                    continue;
                const r = mw.get_frame_rect();
                if (sx >= r.x && sx < r.x + r.width && sy >= r.y && sy < r.y + r.height)
                    return mw.get_stable_sequence();
            }
        } catch {
            /* ignore */
        }
        return -1;
    }

    _eventStageXY(event) {
        try {
            return global.get_pointer();
        } catch {
            return [0, 0];
        }
    }

    _onDockDragCaptured(_stage, event) {
        const ET = Clutter.EventType;
        const t = event.type();
        if (t === ET.BUTTON_RELEASE) {
            if (this._dockDragSafetySrc) {
                GLib.source_remove(this._dockDragSafetySrc);
                this._dockDragSafetySrc = undefined;
            }
            if (this._dockDragSeq) {
                global.stage.disconnect(this._dockDragSeq);
                this._dockDragSeq = undefined;
            }
            this._dockDragLast = null;
            this._saveDockPos();
            return Clutter.EVENT_PROPAGATE;
        }
        if (t === ET.MOTION && this._dockDragLast) {
            const [sx, sy] = this._eventStageXY(event);
            const dx = sx - this._dockDragLast[0];
            const dy = sy - this._dockDragLast[1];
            this._dockDragLast = [sx, sy];
            this._dockPos.x = Math.round(this._dockPos.x + dx);
            this._dockPos.y = Math.round(this._dockPos.y + dy);
            this._root.queue_relayout();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onDockDragHandlePress(actor, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._dockExpandIfShrunk();
        this._bumpDockActivity();
        this._dockDragLast = this._eventStageXY(event);
        if (this._dockDragSeq)
            global.stage.disconnect(this._dockDragSeq);
        if (this._dockDragSafetySrc)
            GLib.source_remove(this._dockDragSafetySrc);
        this._dockDragSeq = global.stage.connect('captured-event', (st, ev) => this._onDockDragCaptured(st, ev));
        this._dockDragSafetySrc = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 45, () => {
            this._dockDragSafetySrc = undefined;
            if (this._dockDragSeq) {
                global.stage.disconnect(this._dockDragSeq);
                this._dockDragSeq = undefined;
            }
            this._dockDragLast = null;
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_STOP;
    }

    /**
     * Pick often runs without {@link Clutter.get_current_event}, so the canvas is omitted from
     * hit-testing for the pen too. Capture pen events on the stage before they reach the actor
     * picked below the overlay; mouse stays pick-based pass-through.
     */
    _syncPenStageCapture() {
        for (const { actor, id } of this._penCapConnections) {
            try {
                actor.disconnect(id);
            } catch {
                /* ignore */
            }
        }
        this._penCapConnections = [];
        if (!this._root.visible)
            return;

        const st =
            global.stage ??
            (typeof Main?.uiGroup?.get_stage === 'function' ? Main.uiGroup.get_stage() : null);
        const ug = Main.uiGroup;
        /** @type {object[]} */
        const targets = [];
        if (st && typeof st.connect === 'function')
            targets.push(st);
        if (ug && typeof ug.connect === 'function' && ug !== st)
            targets.push(ug);

        const handler = (_actor, event) => this._onPenStageCaptured(event);
        for (const actor of targets) {
            const id = actor.connect('captured-event', handler);
            this._penCapConnections.push({ actor, id });
        }
        if (this._penCapConnections.length) {
            // #region agent log
            annoDebug({
                hypothesisId: 'F',
                location: 'overlaySession.js:_syncPenStageCapture',
                message: 'pen capture connected',
                data: {
                    n: this._penCapConnections.length,
                    dualStageAndUiGroup: this._penCapConnections.length >= 2,
                },
            });
            // #endregion
        }
    }

    /**
     * Stage-space coordinates. Tablet events in `captured-event` often report (0,0) from
     * `get_coords` (logs: hypothesis E); fall back to `global.get_pointer()` for pen-class devices.
     * @returns {[number, number]|null} stage x,y
     */
    _stageCoordsFromEvent(event) {
        let xy = null;
        try {
            const coords = event.get_coords();
            if (!coords || coords.length < 2)
                xy = null;
            else if (coords.length >= 3 && typeof coords[0] === 'boolean') {
                if (!coords[0])
                    xy = null;
                else
                    xy = [coords[1], coords[2]];
            } else
                xy = [coords[0], coords[1]];
        } catch {
            xy = null;
        }
        const penish = eventIsPenDrawDevice(event);
        const t = clutterEventType(event);
        const ET = Clutter.EventType;
        const strokePointer =
            this._penDown &&
            ET &&
            t != null &&
            (t === ET.MOTION || t === ET.TOUCH_UPDATE);
        const bad =
            !xy ||
            typeof xy[0] !== 'number' ||
            typeof xy[1] !== 'number' ||
            Number.isNaN(xy[0]) ||
            Number.isNaN(xy[1]) ||
            (penish && xy[0] === 0 && xy[1] === 0);
        if (bad && (penish || strokePointer)) {
            try {
                const p = global.get_pointer();
                if (Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number')
                    return [p[0], p[1]];
            } catch {
                /* ignore */
            }
        }
        if (
            strokePointer &&
            xy &&
            typeof xy[0] === 'number' &&
            typeof xy[1] === 'number' &&
            !Number.isNaN(xy[0]) &&
            !Number.isNaN(xy[1]) &&
            !this._stagePointInOverlayRoot(xy[0], xy[1])
        ) {
            try {
                const p = global.get_pointer();
                if (
                    Array.isArray(p) &&
                    p.length >= 2 &&
                    typeof p[0] === 'number' &&
                    typeof p[1] === 'number' &&
                    !Number.isNaN(p[0]) &&
                    !Number.isNaN(p[1]) &&
                    this._stagePointInOverlayRoot(p[0], p[1])
                )
                    return [p[0], p[1]];
            } catch {
                /* ignore */
            }
        }
        return xy;
    }

    /**
     * Stage (x,y) → coordinates relative to {@link this._root} (same space as {@link AnnoOverlayRoot.vfunc_allocate}).
     * Uses translate-only mapping: `transform_stage_point` often returns only `true`/`false` on GJS, which made
     * the old path always fall back to a bogus dock AABB (logs: inDock true with no hypothesis E).
     * @returns {[number, number]|null}
     */
    _rootLocalFromStageXY(sx, sy) {
        try {
            const root = this._root;
            const [rx, ry] = root.get_transformed_position();
            if (typeof rx !== 'number' || typeof ry !== 'number' || Number.isNaN(rx) || Number.isNaN(ry))
                return null;
            return [sx - rx, sy - ry];
        } catch {
            return null;
        }
    }

    /**
     * Root-local dock rect for hit-testing. Prefer a sane post-layout allocation; otherwise mirror
     * {@link AnnoOverlayRoot.vfunc_allocate} with clamped naturals (St vertical boxes can report a
     * very tall preferred height — logs showed inDock true over the canvas).
     */
    _dockPaletteRootBox() {
        const pad = 14;
        const maxW = 360;
        const maxH = 300;
        try {
            const b = this._dock.get_allocation_box();
            const w = Math.abs(Math.round(b.x2 - b.x1));
            const h = Math.abs(Math.round(b.y2 - b.y1));
            if (w >= 32 && h >= 32 && w <= maxW && h <= maxH)
                return { x1: Math.round(b.x1), y1: Math.round(b.y1), x2: Math.round(b.x2), y2: Math.round(b.y2) };
        } catch {
            /* ignore */
        }
        let natDockW = 160;
        let natDockH = 120;
        try {
            const sz = this._dock.get_preferred_size();
            if (Array.isArray(sz) && sz.length >= 4) {
                natDockW = Math.max(1, Math.round(sz[2]));
                natDockH = Math.max(1, Math.round(sz[3]));
            }
        } catch {
            /* ignore */
        }
        natDockW = Math.min(Math.max(natDockW, 48), maxW);
        natDockH = Math.min(Math.max(natDockH, 48), maxH);
        return { x1: pad, y1: pad, x2: pad + natDockW, y2: pad + natDockH };
    }

    /** Clamp stage coordinates to the overlay root AABB (stroke continuation when event coords drift). */
    _clampStageXYToRootBounds(sx, sy) {
        try {
            const [rx, ry] = this._root.get_transformed_position();
            const w = Math.max(1, this._root.get_width());
            const h = Math.max(1, this._root.get_height());
            const x2 = rx + w - 1e-4;
            const y2 = ry + h - 1e-4;
            return [Math.min(Math.max(sx, rx), x2), Math.min(Math.max(sy, ry), y2)];
        } catch {
            return [sx, sy];
        }
    }

    /**
     * Run handler with fixed stage-space coords for {@link _localFromEvent} (must match hit-tests above).
     * @param {number} sx1
     * @param {number} sy1
     * @param {() => number} fn
     */
    _dispatchPenCapture(sx1, sy1, fn) {
        this._penCapStageXYUse = true;
        this._penCapStageXYPair = [sx1, sy1];
        try {
            return fn();
        } finally {
            this._penCapStageXYUse = false;
            this._penCapStageXYPair = null;
        }
    }

    /**
     * Refresh stroke anchor coords only after real ink geometry updates. Updating from every
     * capture dispatch (e.g. interleaved evT 17 @ fixed stage xy) poisoned false-dock fallback
     * (log I: usedLastGood true but sx1/sy1 stuck at 856,351 while motion was ~500×470).
     */
    _refreshPenStrokeLastGoodStageXY() {
        try {
            const pair = this._penCapStageXYPair;
            if (
                !pair ||
                pair.length < 2 ||
                typeof pair[0] !== 'number' ||
                typeof pair[1] !== 'number' ||
                Number.isNaN(pair[0]) ||
                Number.isNaN(pair[1])
            )
                return;
            if (this._stagePointInOverlayRoot(pair[0], pair[1]))
                this._lastGoodCapStageXY = [pair[0], pair[1]];
        } catch {
            /* ignore */
        }
    }

    /** @param {number} sx @param {number} sy stage coordinates */
    _stagePointInOverlayRoot(sx, sy) {
        const L = this._rootLocalFromStageXY(sx, sy);
        if (L) {
            try {
                const w = this._root.get_width();
                const h = this._root.get_height();
                const [lx, ly] = L;
                // Evaluate strictly against local bounds (0, 0) to (w, h)
                return lx >= 0 && ly >= 0 && lx < w && ly < h;
            } catch {
                /* fall through */
            }
        }
        return this._stagePointInActorFallback(this._root, sx, sy);
    }

    /** Dock swatches: root-local rect from preferred size + padding (matches manual allocate). */
    _stagePointInDockPalette(sx, sy) {
        const L = this._rootLocalFromStageXY(sx, sy);
        if (!L)
            return false;
        try {
            const bd = this._dockPaletteRootBox();
            const [lx, ly] = L;
            return lx >= bd.x1 && ly >= bd.y1 && lx < bd.x2 && ly < bd.y2;
        } catch {
            return false;
        }
    }

    /**
     * Dock hit in stage space: root-local palette AABB **or** the dock actor’s transformed bounds
     * (with padding). Pick / press used the AABB only; logs showed `J` + `D` together — capture
     * propagated but canvas still received press because stage coords missed the palette rect.
     * @param {number} sx
     * @param {number} sy
     */
    /**
     * @param {number} sx
     * @param {number} sy
     * @param {number} [actorPad=4] stage-space padding on the dock actor box (larger for routing only).
     */
    _penStagePointDockHit(sx, sy, actorPad = 4) {
        if (this._stagePointInDockPalette(sx, sy))
            return true;
        try {
            const d = this._dock;
            if (!d?.visible)
                return false;
            const [x, y] = d.get_transformed_position();
            const w = Math.max(1, d.get_width());
            const h = Math.max(1, d.get_height());
            const pad = actorPad;
            return sx >= x - pad && sy >= y - pad && sx < x + w + pad && sy < y + h + pad;
        } catch {
            return false;
        }
    }

    /**
     * Tablet stream reports coordinates in the dock band while the core pointer is on canvas
     * (Wayland); used for false-dock remap and to avoid committing a canvas stroke to “dock”.
     */
    _tabletDockRawDisagreesWithPointer(sx, sy) {
        if (!this._penStagePointDockHit(sx, sy))
            return false;
        try {
            const p = global.get_pointer();
            if (
                !Array.isArray(p) ||
                p.length < 2 ||
                typeof p[0] !== 'number' ||
                typeof p[1] !== 'number' ||
                Number.isNaN(p[0]) ||
                Number.isNaN(p[1]) ||
                !this._stagePointInOverlayRoot(p[0], p[1]) ||
                this._penStagePointDockHit(p[0], p[1])
            )
                return false;
            const dx = sx - p[0];
            const dy = sy - p[1];
            return dx * dx + dy * dy > TABLET_DOCK_COORD_SLACK2;
        } catch {
            return false;
        }
    }

    /**
     * While `!penDown`: stylus events can carry canvas-like stage coords while the compositor
     * pointer is over the dock — same class of bug as missed swatches (capture never propagates).
     * @param {number} sxRaw
     * @param {number} syRaw
     */
    _penPointerOnDockWhileTabletStageMissesDock(sxRaw, syRaw) {
        try {
            const p = global.get_pointer();
            if (
                !Array.isArray(p) ||
                p.length < 2 ||
                typeof p[0] !== 'number' ||
                typeof p[1] !== 'number' ||
                Number.isNaN(p[0]) ||
                Number.isNaN(p[1]) ||
                !this._stagePointInOverlayRoot(p[0], p[1])
            )
                return false;
            if (!this._penStagePointDockHit(p[0], p[1], 28))
                return false;
            if (this._penStagePointDockHit(sxRaw, syRaw, 12))
                return false;
            const dx = sxRaw - p[0];
            const dy = syRaw - p[1];
            return dx * dx + dy * dy > TABLET_DOCK_COORD_SLACK2;
        } catch {
            return false;
        }
    }

    /** @param {Clutter.Actor} actor @param {number} sx @param {number} sy @param {number} pad */
    _stagePointHitsActor(actor, sx, sy, pad) {
        try {
            if (!actor?.visible)
                return false;
            const [x, y] = actor.get_transformed_position();
            const w = Math.max(1, actor.get_width());
            const h = Math.max(1, actor.get_height());
            return sx >= x - pad && sy >= y - pad && sx < x + w + pad && sy < y + h + pad;
        } catch {
            return false;
        }
    }

    /**
     * Pen tap on swatch/clear while routing still delivered drawArea: try event + core pointer
     * with generous padding (tablet coords often miss St pick).
     * @param {Clutter.Event} event
     * @returns {boolean} true if a dock action was triggered
     */
    _forwardPenDockIfSwatchHit(event) {
        if (this._penDown || !this._dock?.visible)
            return false;
        const t0 = clutterEventType(event);
        const ET0 = Clutter.EventType;
        if (
            ET0 &&
            t0 != null &&
            (t0 === ET0.MOTION || t0 === ET0.TOUCH_UPDATE)
        )
            return false;
        const pts = [];
        const penDev = eventIsPenDrawDevice(event);
        const pushPtr = () => {
            try {
                const p = global.get_pointer();
                if (
                    Array.isArray(p) &&
                    p.length >= 2 &&
                    typeof p[0] === 'number' &&
                    typeof p[1] === 'number' &&
                    !Number.isNaN(p[0]) &&
                    !Number.isNaN(p[1])
                )
                    pts.push([p[0], p[1]]);
            } catch {
                /* ignore */
            }
        };
        if (penDev)
            pushPtr();
        if (
            this._penCapStageXYUse &&
            this._penCapStageXYPair &&
            this._penCapStageXYPair.length >= 2 &&
            typeof this._penCapStageXYPair[0] === 'number' &&
            typeof this._penCapStageXYPair[1] === 'number' &&
            !Number.isNaN(this._penCapStageXYPair[0]) &&
            !Number.isNaN(this._penCapStageXYPair[1])
        )
            pts.push([this._penCapStageXYPair[0], this._penCapStageXYPair[1]]);
        try {
            const xy = this._stageCoordsFromEvent(event);
            if (
                xy &&
                typeof xy[0] === 'number' &&
                typeof xy[1] === 'number' &&
                !Number.isNaN(xy[0]) &&
                !Number.isNaN(xy[1])
            )
                pts.push([xy[0], xy[1]]);
        } catch {
            /* ignore */
        }
        if (!penDev)
            pushPtr();
        /* Tight pad: bogus tablet coords sit ~60×30 stage; pad 40 made every tap hit swatch 0 (log S). */
        const pad = 6;
        for (const [sx, sy] of pts) {
            if (!this._stagePointInOverlayRoot(sx, sy))
                continue;
            for (let i = 0; i < this._swatchButtons.length; i++) {
                const btn = this._swatchButtons[i];
                if (this._stagePointHitsActor(btn, sx, sy, pad)) {
                    if (this._penDockFwdDbgN < 16) {
                        this._penDockFwdDbgN++;
                        // #region agent log
                        annoDebug({
                            hypothesisId: 'S',
                            location: 'overlaySession.js:_forwardPenDockIfSwatchHit',
                            message: 'forwarded pen to swatch clicked',
                            data: { swatchIndex: i, sx, sy },
                        });
                        // #endregion
                    }
                    btn.emit('clicked');
                    return true;
                }
            }
            if (this._clearBtn && this._stagePointHitsActor(this._clearBtn, sx, sy, pad)) {
                if (this._penDockFwdDbgN < 16) {
                    this._penDockFwdDbgN++;
                    // #region agent log
                    annoDebug({
                        hypothesisId: 'S',
                        location: 'overlaySession.js:_forwardPenDockIfSwatchHit',
                        message: 'forwarded pen to clear clicked',
                        data: { sx, sy },
                    });
                    // #endregion
                }
                this._clearBtn.emit('clicked');
                return true;
            }
        }
        return false;
    }

    /**
     * True if either the event’s stage coords or `global.get_pointer()` lie on the dock palette.
     * Tablet events often report canvas-space coords while the pointer is over the dock (log J
     * after lift: pen MOTION propagates but BUTTON_PRESS was still captured — event-only gate).
     * @param {Clutter.Event|null} event
     */
    _penEventLikelyOverDockPalette(event) {
        const sources = [];
        if (event) {
            try {
                const xy = this._stageCoordsFromEvent(event);
                if (
                    xy &&
                    typeof xy[0] === 'number' &&
                    typeof xy[1] === 'number' &&
                    !Number.isNaN(xy[0]) &&
                    !Number.isNaN(xy[1])
                )
                    sources.push(xy);
            } catch {
                /* ignore */
            }
        }
        try {
            const p = global.get_pointer();
            if (
                Array.isArray(p) &&
                p.length >= 2 &&
                typeof p[0] === 'number' &&
                typeof p[1] === 'number' &&
                !Number.isNaN(p[0]) &&
                !Number.isNaN(p[1])
            )
                sources.push([p[0], p[1]]);
        } catch {
            /* ignore */
        }
        /* Wider actor pad so swatch taps still count as “dock” when coords sit between strict AABB and buttons. */
        for (const xy of sources) {
            if (this._penStagePointDockHit(xy[0], xy[1], 28))
                return true;
        }
        return false;
    }

    /** AABB in stage space (fallback when transform_stage_point fails). */
    _stagePointInActorFallback(actor, sx, sy) {
        try {
            const [x, y] = actor.get_transformed_position();
            const w = actor.get_width();
            const h = actor.get_height();
            return sx >= x && sy >= y && sx < x + w && sy < y + h;
        } catch {
            return false;
        }
    }

    /**
     * Tablet contact often uses `evtDevT` tablet class, then interleaved MOTION with
     * master `POINTER_DEVICE` (0) — logs hypothesis G. After `_penDown`, accept those
     * motion/release events so the stroke is not dropped mid-gesture.
     * @param {Clutter.Event} event
     * @returns {boolean}
     */
    _penMotionShouldImplicitPress(event) {
        const t = clutterEventType(event);
        const ET = Clutter.EventType;
        if (!ET || t == null)
            return false;
        /* Logs showed many PROXIMITY_IN/OUT cycles but no evT 3 MOTION — tablet tip often moves on
         * the core POINTER stream. Keep proximity armed across OUT flicker (see PROXIMITY_OUT). */
        if (ET.PROXIMITY_IN !== undefined && t === ET.PROXIMITY_IN && eventIsPenDrawDevice(event)) {
            const xy = this._stageCoordsFromEvent(event);
            if (xy && this._stagePointInDockPalette(xy[0], xy[1]))
                return false;
            if (eventHasPressure(event))
                return getPressure01(event) > IMPLICIT_PRESSURE_START;
            if (eventHasStylusDeviceTool(event))
                return true;
            return false;
        }
        if (t !== ET.MOTION && t !== ET.TOUCH_UPDATE)
            return false;
        if (eventHasPressure(event))
            return getPressure01(event) > IMPLICIT_PRESSURE_START;

        let dt = null;
        try {
            dt = typeof event.get_device_type === 'function' ? event.get_device_type() : null;
        } catch {
            dt = null;
        }
        const IDT = Clutter.InputDeviceType;
        const fresh =
            this._penProximityArmed &&
            this._penProximityArmedAt > 0 &&
            Date.now() - this._penProximityArmedAt < 900;
        const tabletLike =
            IDT &&
            dt != null &&
            ((IDT.TABLET_DEVICE !== undefined && dt === IDT.TABLET_DEVICE) ||
                (IDT.TABLET_TOOL !== undefined && dt === IDT.TABLET_TOOL) ||
                (IDT.PEN_DEVICE !== undefined && dt === IDT.PEN_DEVICE) ||
                (IDT.ERASER_DEVICE !== undefined && dt === IDT.ERASER_DEVICE));
        if (tabletLike && (fresh || eventHasStylusDeviceTool(event)))
            return true;
        const ptrT =
            IDT && IDT.POINTER_DEVICE !== undefined
                ? IDT.POINTER_DEVICE
                : IDT && IDT.POINTER !== undefined
                  ? IDT.POINTER
                  : null;
        if (fresh && dt != null && ptrT != null && dt === ptrT)
            return true;
        return false;
    }

    /**
     * After a deferred canvas discrete press, motion must reach capture for drag-unlock; logs
     * showed evT 3 + inDock true + J reject — pointer stayed “dock” while tablet moved on canvas.
     */
    _penDeferredInkAwaitingMotion() {
        return !!(this._penAwaitInkAfterRange && this._penDeferredAnchorStageXY);
    }

    _penCaptureAcceptsEvent(event) {
        /* Otherwise every pen event is captured and returned STOP — dock never sees clicks (R). */
        if (
            !this._penDown &&
            !this._penDeferredInkAwaitingMotion() &&
            this._penEventLikelyOverDockPalette(event)
        )
            return false;
        if (eventIsPenDrawDevice(event))
            return true;
        const t = clutterEventType(event);
        const ET = Clutter.EventType;
        const motionish =
            ET && t != null && (t === ET.MOTION || t === ET.TOUCH_UPDATE);
        if (
            motionish &&
            this._penProximityArmed &&
            this._penProximityArmedAt > 0 &&
            Date.now() - this._penProximityArmedAt < 900
        ) {
            if (
                !this._penDown &&
                !this._penDeferredInkAwaitingMotion() &&
                this._penEventLikelyOverDockPalette(event)
            )
                return false;
            return true;
        }
        if (!this._penDown)
            return false;
        if (!ET || t == null || t === undefined)
            return false;
        /* Wayland sends core POINTER ENTER/MOTION/SCROLL/… without pen flags while the tablet
         * stream holds _penDown (log J: evT 4, 15, 28, isPen false, penDown true) — those were
         * rejected and hit the client below. Swallow every non-key event for the stroke lifetime. */
        if (ET.KEY_PRESS !== undefined && (t === ET.KEY_PRESS || t === ET.KEY_RELEASE))
            return false;
        return true;
    }

    /**
     * @param {Clutter.Event} event
     * @returns {Clutter.EventReturn}
     */
    _onPenStageCaptured(event) {
        if (!this._root.visible)
            return Clutter.EVENT_PROPAGATE;
        if (this._penDown && this._penCapWhileDownDbgN < 40) {
            this._penCapWhileDownDbgN++;
            // #region agent log
            annoDebug({
                hypothesisId: 'P',
                location: 'overlaySession.js:_onPenStageCaptured',
                message: 'capture invoked while penDown',
                data: { evT: clutterEventType(event) },
            });
            // #endregion
        }
        if (this._penCapEntryDbgN < 25 && eventIsPointerButtonOrMotion(event)) {
            this._penCapEntryDbgN++;
            let evtDevT = null;
            let hasTool = false;
            let toolT = null;
            try {
                evtDevT = typeof event.get_device_type === 'function' ? event.get_device_type() : null;
            } catch {
                evtDevT = null;
            }
            try {
                const tool = typeof event.get_device_tool === 'function' ? event.get_device_tool() : null;
                hasTool = !!tool;
                toolT = tool && typeof tool.get_tool_type === 'function' ? tool.get_tool_type() : null;
            } catch {
                hasTool = false;
                toolT = null;
            }
            const xy0 = this._stageCoordsFromEvent(event);
            let inRoot = null;
            let inDock = null;
            if (xy0 && typeof xy0[0] === 'number' && typeof xy0[1] === 'number') {
                inRoot = this._stagePointInOverlayRoot(xy0[0], xy0[1]);
                inDock = this._stagePointInDockPalette(xy0[0], xy0[1]);
            }
            // #region agent log
            annoDebug({
                hypothesisId: 'G',
                location: 'overlaySession.js:_onPenStageCaptured',
                message: 'capture pointer sample',
                data: {
                    evT: clutterEventType(event),
                    isPen: eventIsPenDrawDevice(event),
                    evtDevT,
                    hasTool,
                    toolT,
                    inRoot,
                    inDock,
                    rootLoc: 'delta',
                },
            });
            // #endregion
        }
        if (!this._penCaptureAcceptsEvent(event)) {
            if (this._penCapRejDbgN < 40) {
                this._penCapRejDbgN++;
                // #region agent log
                annoDebug({
                    hypothesisId: 'J',
                    location: 'overlaySession.js:_onPenStageCaptured',
                    message: 'capture not accepted',
                    data: {
                        evT: clutterEventType(event),
                        isPen: eventIsPenDrawDevice(event),
                        penDown: this._penDown,
                        prox: this._penProximityArmed,
                    },
                });
                // #endregion
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (!this._penCapHandled)
            this._penCapHandled = new WeakSet();
        if (this._penCapHandled.has(event))
            return Clutter.EVENT_STOP;
        this._penCapHandled.add(event);

        const xy = this._stageCoordsFromEvent(event);
        if (!xy)
            return this._penDown ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        const [sx, sy] = xy;
        if (typeof sx !== 'number' || typeof sy !== 'number' || Number.isNaN(sx) || Number.isNaN(sy))
            return this._penDown ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        const tGate = clutterEventType(event);
        const ETGate = Clutter.EventType;
        const proxInGate =
            ETGate &&
            ETGate.PROXIMITY_IN !== undefined &&
            tGate === ETGate.PROXIMITY_IN &&
            eventIsPenDrawDevice(event);
        const enterPenGate =
            ETGate && ETGate.ENTER !== undefined && tGate === ETGate.ENTER && eventIsPenDrawDevice(event);

        let penTabletCoercedMotion = false;
        let sx1 = sx;
        let sy1 = sy;
        if (!this._stagePointInOverlayRoot(sx1, sy1)) {
            try {
                const p = global.get_pointer();
                if (
                    Array.isArray(p) &&
                    p.length >= 2 &&
                    typeof p[0] === 'number' &&
                    typeof p[1] === 'number' &&
                    !Number.isNaN(p[0]) &&
                    !Number.isNaN(p[1]) &&
                    this._stagePointInOverlayRoot(p[0], p[1])
                ) {
                    sx1 = p[0];
                    sy1 = p[1];
                }
            } catch {
                /* ignore */
            }
        }
        /* Log E: evKind 28, sx/sy 0, evtDevT 1 while penDown — no evKind 3 MOTION; treat as motion with
         * last good stage coords so appendPoint runs. */
        /* Log E: evKind 28 + sx/sy 0 + evtDevT 1 (master pointer) — not pen-classified; still reuse
         * last good coords whenever a stroke is active (M alone gated on pen and never fired). */
        if (
            this._penDown &&
            sx === 0 &&
            sy === 0 &&
            this._lastGoodCapStageXY &&
            !isLikelyKeyOrScrollEvent(event)
        ) {
            sx1 = this._lastGoodCapStageXY[0];
            sy1 = this._lastGoodCapStageXY[1];
            penTabletCoercedMotion = true;
            if (this._penTabletCoerceDbgN < 30) {
                this._penTabletCoerceDbgN++;
                // #region agent log
                annoDebug({
                    hypothesisId: 'M',
                    location: 'overlaySession.js:_onPenStageCaptured',
                    message: 'tablet 0,0 coords → last good + motion coerce',
                    data: { tGate, sx1, sy1 },
                });
                // #endregion
            }
        }
        let inR2 = this._stagePointInOverlayRoot(sx1, sy1);
        /* POINTER MOTION often omits get_event_type (tGate null) or lands outside root until clamped;
         * logs showed no evKind 3 after D while pick churned — we must not return STOP without motion. */
        const strokeStream =
            this._penDown &&
            ETGate &&
            (penTabletCoercedMotion ||
                tGate == null ||
                tGate === ETGate.MOTION ||
                tGate === ETGate.TOUCH_UPDATE);
        if (!inR2 && strokeStream) {
            const [cx, cy] = this._clampStageXYToRootBounds(sx1, sy1);
            sx1 = cx;
            sy1 = cy;
            inR2 = this._stagePointInOverlayRoot(sx1, sy1);
        }
        if (!inR2 && strokeStream && this._lastGoodCapStageXY) {
            const [lx, ly] = this._lastGoodCapStageXY;
            sx1 = lx;
            sy1 = ly;
            inR2 = this._stagePointInOverlayRoot(sx1, sy1);
            if (inR2 && this._penStrokeStreamCapDbgN < 24) {
                this._penStrokeStreamCapDbgN++;
                // #region agent log
                annoDebug({
                    hypothesisId: 'K',
                    location: 'overlaySession.js:_onPenStageCaptured',
                    message: 'stroke stream reused last in-root stage xy',
                    data: { tGate, sx, sy, sx1, sy1 },
                });
                // #endregion
            }
        }
        if (!inR2 && !proxInGate && !enterPenGate)
            return this._penDown ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        /* Tablet stage coords often sit in the dock root-local box while the tip is on canvas.
         * Use last good from real motion only. Do **not** fall back to get_pointer() — log I showed
         * usedLastGood:false still snapped to stale 1161×258 (hover) and recreated spokes. */
        if (this._penDown && eventIsPenDrawDevice(event) && this._tabletDockRawDisagreesWithPointer(sx, sy)) {
            const usedLastGood = !!this._lastGoodCapStageXY;
            if (this._lastGoodCapStageXY) {
                sx1 = this._lastGoodCapStageXY[0];
                sy1 = this._lastGoodCapStageXY[1];
                inR2 = this._stagePointInOverlayRoot(sx1, sy1);
                if (!inR2) {
                    const [qx, qy] = this._clampStageXYToRootBounds(sx1, sy1);
                    sx1 = qx;
                    sy1 = qy;
                    inR2 = this._stagePointInOverlayRoot(sx1, sy1);
                }
            }
            if (this._penDockPtrOverrideDbgN < 20) {
                this._penDockPtrOverrideDbgN++;
                // #region agent log
                annoDebug({
                    hypothesisId: 'I',
                    location: 'overlaySession.js:_onPenStageCaptured',
                    message: 'false-dock tablet coords → lastGood only',
                    data: {
                        sxEv: sx,
                        syEv: sy,
                        sx1,
                        sy1,
                        usedLastGood,
                    },
                });
                // #endregion
            }
        }
        /* Logs 1776032763172: evT 17 carries ~1105×705 (hover) while evT 3 stream is ~890×404 — spokes. */
        if (
            this._penDown &&
            eventIsPenDrawDevice(event) &&
            tGate === 17 &&
            this._lastGoodCapStageXY
        ) {
            const [lx, ly] = this._lastGoodCapStageXY;
            const jx = sx1 - lx;
            const jy = sy1 - ly;
            if (jx * jx + jy * jy > 85 * 85) {
                sx1 = lx;
                sy1 = ly;
                inR2 = this._stagePointInOverlayRoot(sx1, sy1);
                if (!inR2) {
                    const [qx, qy] = this._clampStageXYToRootBounds(sx1, sy1);
                    sx1 = qx;
                    sy1 = qy;
                    inR2 = this._stagePointInOverlayRoot(sx1, sy1);
                }
                if (this._penGhost17DbgN < 24) {
                    this._penGhost17DbgN++;
                    // #region agent log
                    annoDebug({
                        hypothesisId: 'T',
                        location: 'overlaySession.js:_onPenStageCaptured',
                        message: 'evT 17 hover coords → last ink stage xy',
                        data: { sxRaw: sx, syRaw: sy, sx1, sy1 },
                    });
                    // #endregion
                }
            }
        }
        if ((sx1 !== sx || sy1 !== sy) && this._penCoordRepairDbgN < 24) {
            this._penCoordRepairDbgN++;
            // #region agent log
            annoDebug({
                hypothesisId: 'H',
                location: 'overlaySession.js:_onPenStageCaptured',
                message: 'stage coord repair for capture',
                data: { sx0: sx, sy0: sy, sx1, sy1, tGate, penDown: this._penDown },
            });
            // #endregion
        }
        /* !penDown: pointer on dock but raw tablet stage misses dock — EVENT_PROPAGATE leaked to
         * clients under the overlay (user report). STOP always; forward swatches on press-like only. */
        const wPressLike =
            ETGate &&
            tGate != null &&
            (tGate === ETGate.BUTTON_PRESS ||
                tGate === ETGate.TOUCH_BEGIN ||
                tGate === 16);
        if (
            !this._penDown &&
            inR2 &&
            eventIsPenDrawDevice(event) &&
            this._penPointerOnDockWhileTabletStageMissesDock(sx, sy)
        ) {
            let wHandled = false;
            if (wPressLike) {
                try {
                    const p = global.get_pointer();
                    if (
                        Array.isArray(p) &&
                        p.length >= 2 &&
                        typeof p[0] === 'number' &&
                        typeof p[1] === 'number' &&
                        !Number.isNaN(p[0]) &&
                        !Number.isNaN(p[1])
                    )
                        wHandled = !!this._dispatchPenCapture(p[0], p[1], () =>
                            this._forwardPenDockIfSwatchHit(event)
                        );
                } catch {
                    /* ignore */
                }
            }
            if (this._penDockPenPtrDbgN < 24) {
                this._penDockPenPtrDbgN++;
                // #region agent log
                annoDebug({
                    hypothesisId: 'W',
                    location: 'overlaySession.js:_onPenStageCaptured',
                    message: 'dock/tablet mismatch: STOP (optional forward)',
                    data: { sx, sy, wPressLike, wHandled },
                });
                // #endregion
            }
            return Clutter.EVENT_STOP;
        }
        /* Let the dock take hover/clicks. If a stroke was started on the canvas and the pen then
         * moves onto the palette, commit first — logs showed MOTION at ~1029×235 then ~217×40. */
        if (
            inR2 &&
            this._penStagePointDockHit(sx1, sy1) &&
            !(this._penDown && this._tabletDockRawDisagreesWithPointer(sx, sy))
        ) {
            if (!this._penDown) {
                this._dispatchPenCapture(sx1, sy1, () => this._forwardPenDockIfSwatchHit(event));
                return Clutter.EVENT_STOP;
            }
            /* Core pointer / coerced streams are not pen-classified but still carry the stroke. */
            this._commitPenStrokeFromCapture();
            return Clutter.EVENT_STOP;
        }
        /* Pointer reached the dock but tablet coords still report the canvas — commit hand-off. */
        if (this._penDown && eventIsPenDrawDevice(event) && inR2) {
            try {
                const p = global.get_pointer();
                if (
                    Array.isArray(p) &&
                    p.length >= 2 &&
                    typeof p[0] === 'number' &&
                    typeof p[1] === 'number' &&
                    !Number.isNaN(p[0]) &&
                    !Number.isNaN(p[1]) &&
                    this._stagePointInOverlayRoot(p[0], p[1]) &&
                    this._penStagePointDockHit(p[0], p[1]) &&
                    !this._penStagePointDockHit(sx1, sy1)
                ) {
                    this._commitPenStrokeFromCapture();
                    return Clutter.EVENT_STOP;
                }
            } catch {
                /* ignore */
            }
        }

        if (this._penCapDbgN < 40) {
            this._penCapDbgN++;
            const evKind = clutterEventType(event);
            // #region agent log
            let evtDevT = null;
            try {
                evtDevT = typeof event.get_device_type === 'function' ? event.get_device_type() : null;
            } catch {
                evtDevT = null;
            }
            annoDebug({
                hypothesisId: 'E',
                location: 'overlaySession.js:_onPenStageCaptured',
                message: 'pen capture canvas',
                data: { sx, sy, sx1, sy1, evKind, evtDevT },
            });
            // #endregion
        }

        const ET = Clutter.EventType;
        if (!ET)
            return this._penDown ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        let t = clutterEventType(event);
        /* Some stacks omit get_event_type on wrapped events; pen still has coords + device. */
        if (t == null || t === undefined) {
            if (this._penCaptureAcceptsEvent(event))
                t = ET.MOTION;
            else
                return this._penDown ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }
        if (penTabletCoercedMotion && ET.MOTION !== undefined) {
            if (
                t !== ET.MOTION &&
                t !== ET.TOUCH_UPDATE &&
                t !== ET.BUTTON_PRESS &&
                t !== ET.TOUCH_BEGIN &&
                t !== ET.BUTTON_RELEASE &&
                t !== ET.TOUCH_END &&
                t !== ET.TOUCH_CANCEL &&
                (ET.PROXIMITY_IN === undefined || t !== ET.PROXIMITY_IN) &&
                (ET.PROXIMITY_OUT === undefined || t !== ET.PROXIMITY_OUT)
            )
                t = ET.MOTION;
        }
        if (t === ET.BUTTON_PRESS || t === ET.TOUCH_BEGIN)
            return this._dispatchPenCapture(sx1, sy1, () => this._onPress(this._drawArea, event));
        if (t === ET.MOTION || t === ET.TOUCH_UPDATE)
            return this._dispatchPenCapture(sx1, sy1, () => this._onMotion(this._drawArea, event));
        if (t === ET.BUTTON_RELEASE || t === ET.TOUCH_END || t === ET.TOUCH_CANCEL)
            return this._dispatchPenCapture(sx1, sy1, () => this._onRelease(this._drawArea, event));
        /* Do not clear _penProximityArmed here: rapid PROXIMITY_OUT/IN flicker was clearing the arm
         * before POINTER MOTION arrived (logs: only evT 16/17/4, never evT 3 — drawing starved). */
        if (ET.PROXIMITY_OUT !== undefined && t === ET.PROXIMITY_OUT) {
            if (eventIsPenDrawDevice(event)) {
                this._penAwaitInkAfterRange = true;
                this._penDeferredAnchorStageXY = null;
            }
            return this._dispatchPenCapture(sx1, sy1, () => this._onRelease(this._drawArea, event));
        }
        /* Arm then let _onMotion run so PROXIMITY_IN + pressure/tool can start a stroke when MOTION
         * is missing from capture; dock excluded in _penMotionShouldImplicitPress.
         * When awaiting first ink after range, skip dispatch — implicit _onPress poisoned lastGood
         * (logs: no V, first D at stale 1375×648 → spokes). */
        if (ET.PROXIMITY_IN !== undefined && t === ET.PROXIMITY_IN) {
            this._penProximityArmed = true;
            this._penProximityArmedAt = Date.now();
            if (inR2 && !this._penAwaitInkAfterRange)
                this._dispatchPenCapture(sx1, sy1, () => this._onMotion(this._drawArea, event));
            return Clutter.EVENT_STOP;
        }
        if (ET.ENTER !== undefined && t === ET.ENTER) {
            if (eventIsPenDrawDevice(event)) {
                this._penProximityArmed = true;
                this._penProximityArmedAt = Date.now();
                return Clutter.EVENT_STOP;
            }
            if (this._penDown)
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        }
        /* Log E: evKind 28 while penDown — not MOTION/TOUCH_UPDATE; was EVENT_STOP with no _onMotion.
         * Wayland can deliver stylus motion on the core pointer stream under odd numeric types. */
        if (this._penDown && inR2 && !isLikelyKeyOrScrollEvent(event)) {
            const discrete =
                t === ET.BUTTON_PRESS ||
                t === ET.TOUCH_BEGIN ||
                t === ET.BUTTON_RELEASE ||
                t === ET.TOUCH_END ||
                t === ET.TOUCH_CANCEL ||
                (ET.PROXIMITY_IN !== undefined && t === ET.PROXIMITY_IN) ||
                (ET.PROXIMITY_OUT !== undefined && t === ET.PROXIMITY_OUT) ||
                (ET.ENTER !== undefined && t === ET.ENTER) ||
                (ET.LEAVE !== undefined && t === ET.LEAVE);
            if (!discrete && t !== ET.MOTION && t !== ET.TOUCH_UPDATE) {
                if (this._penUnknownMotionDbgN < 36) {
                    this._penUnknownMotionDbgN++;
                    let evtDevT = null;
                    try {
                        evtDevT =
                            typeof event.get_device_type === 'function' ? event.get_device_type() : null;
                    } catch {
                        evtDevT = null;
                    }
                    // #region agent log
                    annoDebug({
                        hypothesisId: 'N',
                        location: 'overlaySession.js:_onPenStageCaptured',
                        message: 'penDown unknown evKind → dispatch _onMotion',
                        data: { t, sx1, sy1, evtDevT },
                    });
                    // #endregion
                }
                return this._dispatchPenCapture(sx1, sy1, () => this._onMotion(this._drawArea, event));
            }
        }
        if (this._penDown)
            return Clutter.EVENT_STOP;
        return Clutter.EVENT_PROPAGATE;
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
        dock.connect('enter-event', () => {
            this._dockExpandIfShrunk();
            this._bumpDockActivity();
            return Clutter.EVENT_PROPAGATE;
        });
        const dragHandle = new St.Button({
            style_class: 'anno-dock-drag',
            label: '⠿',
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        dragHandle.connect('button-press-event', (a, ev) => this._onDockDragHandlePress(a, ev));

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

        const undoBtn = new St.Button({
            style_class: 'anno-dock-undo',
            label: _('Undo'),
            reactive: true,
            can_focus: false,
        });
        undoBtn.connect('clicked', () => {
            if (this._model.undoOne())
                this._drawArea.queue_repaint();
        });

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

        for (const w of [dragHandle, swRow, undoBtn, clearBtn]) {
            w.connect('enter-event', () => {
                this._dockExpandIfShrunk();
                this._bumpDockActivity();
                return Clutter.EVENT_PROPAGATE;
            });
        }

        dock.add_child(dragHandle);
        dock.add_child(swRow);
        dock.add_child(undoBtn);
        dock.add_child(clearBtn);
        this._clearBtn = clearBtn;
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
        const stageXY = this._penCapStageXYUse && this._penCapStageXYPair ? this._penCapStageXYPair : this._stageCoordsFromEvent(event);
        if (!stageXY)
            return [0, 0];
        const [sx, sy] = stageXY;
        if (typeof sx !== 'number' || typeof sy !== 'number' || Number.isNaN(sx) || Number.isNaN(sy))
            return [0, 0];
        const [cx, cy] = this._drawArea.get_transformed_position();
        return [sx - cx, sy - cy];
    }

    /** End current pen stroke without a full release event (e.g. hand-off to dock palette). */
    _commitPenStrokeFromCapture() {
        if (!this._penDown)
            return;
        this._lastGoodCapStageXY = null;
        this._penDown = false;
        if (this._model.eraserPath)
            this._model.finishErase();
        else
            this._model.commitCurrent();
        this._drawArea.queue_repaint();
    }

    _onPress(actor, event) {
        try {
            if (this._pressDbgN < 12) {
                this._pressDbgN++;
                // #region agent log
                annoDebug({
                    hypothesisId: 'D',
                    location: 'overlaySession.js:_onPress',
                    message: 'press on drawArea',
                    data: {
                        visible: this._root.visible,
                        isPen: eventIsPenDrawDevice(event),
                        mode: (() => {
                            try {
                                return stylusModeOnPress(event);
                            } catch {
                                return 'err';
                            }
                        })(),
                    },
                });
                // #endregion
            }
            if (!this._root.visible)
                return Clutter.EVENT_PROPAGATE;
            if (eventIsPenDrawDevice(event) && !this._penDown && this._forwardPenDockIfSwatchHit(event))
                return Clutter.EVENT_STOP;
            if (this._penEventLikelyOverDockPalette(event)) {
                if (this._penDown)
                    this._commitPenStrokeFromCapture();
                return Clutter.EVENT_PROPAGATE;
            }
            /* Tablet stream can repeat numeric type 16 (same as BUTTON_PRESS) with no evT 3 MOTION
             * (log P: only evT 16 while penDown). Treat as motion after the stroke has started. */
            if (this._penDown) {
                if (this._penDupPressDbgN < 30) {
                    this._penDupPressDbgN++;
                    // #region agent log
                    annoDebug({
                        hypothesisId: 'Q',
                        location: 'overlaySession.js:_onPress',
                        message: 'penDown repeat press-type → _onMotion',
                        data: { evT: clutterEventType(event) },
                    });
                    // #endregion
                }
                return this._onMotion(actor, event);
            }
            if (!eventIsPenDrawDevice(event))
                return Clutter.EVENT_PROPAGATE;

            const mode = stylusModeOnPress(event);
            if (mode === 'none')
                return Clutter.EVENT_PROPAGATE;

            const tPress = clutterEventType(event);
            const ETp = Clutter.EventType;
            const isDiscretePress =
                ETp &&
                tPress != null &&
                (tPress === ETp.BUTTON_PRESS ||
                    tPress === ETp.TOUCH_BEGIN ||
                    tPress === 16);
            if (!this._penDown && this._penAwaitInkAfterRange && isDiscretePress) {
                try {
                    const pair = this._penCapStageXYPair;
                    if (
                        pair &&
                        pair.length >= 2 &&
                        typeof pair[0] === 'number' &&
                        typeof pair[1] === 'number'
                    )
                        this._penDeferredAnchorStageXY = [pair[0], pair[1]];
                } catch {
                    this._penDeferredAnchorStageXY = null;
                }
                if (this._penDeferredInkDbgN < 20) {
                    this._penDeferredInkDbgN++;
                    // #region agent log
                    annoDebug({
                        hypothesisId: 'V',
                        location: 'overlaySession.js:_onPress',
                        message: 'deferred discrete press (no ink until motion)',
                        data: {
                            mode,
                            evT: tPress,
                            anchor: this._penDeferredAnchorStageXY,
                        },
                    });
                    // #endregion
                }
                return Clutter.EVENT_STOP;
            }

            const [x, y] = this._localFromEvent(event);
            const p = getPressure01(event);
            const winSeq = this._windowSeqFromLocal(x, y);

            if (mode === 'erase') {
                this._model.commitCurrent();
                this._model.beginErase(x, y, winSeq);
            } else {
                this._model.finishErase();
                this._model.beginStroke(x, y, p, winSeq);
            }
            this._penDown = true;
            this._penAwaitInkAfterRange = false;
            this._penDeferredAnchorStageXY = null;
            this._drawArea.queue_repaint();
            return Clutter.EVENT_STOP;
        } catch (e) {
            logError(e, 'annotations overlay press');
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _onMotion(actor, event) {
        try {
            if (!this._root.visible)
                return Clutter.EVENT_PROPAGATE;

            if (!this._penDown) {
                if (!eventIsPenDrawDevice(event) && !this._penProximityArmed)
                    return Clutter.EVENT_PROPAGATE;
                if (this._penAwaitInkAfterRange && eventIsPenDrawDevice(event)) {
                    if (
                        !this._penDeferredInkAwaitingMotion() &&
                        this._penEventLikelyOverDockPalette(event)
                    )
                        return Clutter.EVENT_STOP;
                    const tM = clutterEventType(event);
                    const ETm = Clutter.EventType;
                    const motionish =
                        ETm &&
                        tM != null &&
                        (tM === ETm.MOTION || tM === ETm.TOUCH_UPDATE);
                    if (
                        motionish &&
                        this._penDeferredAnchorStageXY &&
                        this._penCapStageXYPair
                    ) {
                        const [mx, my] = this._penCapStageXYPair;
                        const [ax, ay] = this._penDeferredAnchorStageXY;
                        const d2 = (mx - ax) * (mx - ax) + (my - ay) * (my - ay);
                        if (d2 >= PEN_INK_DRAG_UNLOCK2) {
                            this._penAwaitInkAfterRange = false;
                            this._penDeferredAnchorStageXY = null;
                            if (this._penDeferredInkDbgN < 20) {
                                this._penDeferredInkDbgN++;
                                // #region agent log
                                annoDebug({
                                    hypothesisId: 'V',
                                    location: 'overlaySession.js:_onMotion',
                                    message: 'ink unlock after drag from deferred tap',
                                    data: { mx, my, ax, ay, d2 },
                                });
                                // #endregion
                            }
                            return this._onPress(actor, event);
                        }
                        return Clutter.EVENT_STOP;
                    }
                }
                if (this._penMotionShouldImplicitPress(event)) {
                    /* Do not start ink from implicit press while deferred-ink gate is active — it clears
                     * await before the real BUTTON_PRESS and seeds bogus anchors (log: no V before D). */
                    if (this._penAwaitInkAfterRange)
                        return Clutter.EVENT_STOP;
                    this._penAwaitInkAfterRange = false;
                    return this._onPress(actor, event);
                }
                return Clutter.EVENT_PROPAGATE;
            }

            /* Capture path sets _penCapStageXYUse; event type may be non-MOTION (log evKind 28). */
            if (!eventIsPenDrawDevice(event) && !this._penCapStageXYUse) {
                const t = clutterEventType(event);
                const ET = Clutter.EventType;
                if (!ET || t == null || (t !== ET.MOTION && t !== ET.TOUCH_UPDATE))
                    return Clutter.EVENT_PROPAGATE;
            }

            if (this._penEventLikelyOverDockPalette(event)) {
                this._commitPenStrokeFromCapture();
                return Clutter.EVENT_STOP;
            }

            const [x, y] = this._localFromEvent(event);
            const p = getPressure01(event);

            if (this._model.eraserPath)
                this._model.appendErase(x, y);
            else
                this._model.appendPoint(x, y, p);
            this._refreshPenStrokeLastGoodStageXY();
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
            if (!this._penDown) {
                const t0 = clutterEventType(event);
                const ET = Clutter.EventType;
                if (
                    eventIsPenDrawDevice(event) &&
                    ET &&
                    ET.PROXIMITY_OUT !== undefined &&
                    t0 === ET.PROXIMITY_OUT
                )
                    return Clutter.EVENT_PROPAGATE;
                if (this._penDeferredAnchorStageXY && ET && t0 != null) {
                    const releaseLike =
                        t0 === ET.BUTTON_RELEASE ||
                        t0 === ET.TOUCH_END ||
                        t0 === ET.TOUCH_CANCEL;
                    if (eventIsPenDrawDevice(event) && releaseLike)
                        this._penDeferredAnchorStageXY = null;
                }
            }
            if (!eventIsPenDrawDevice(event)) {
                if (!this._penDown)
                    return Clutter.EVENT_PROPAGATE;
                const t = clutterEventType(event);
                const ET = Clutter.EventType;
                if (!ET || t == null || t === undefined)
                    return Clutter.EVENT_PROPAGATE;
                const releaseLike =
                    t === ET.BUTTON_RELEASE ||
                    t === ET.TOUCH_END ||
                    t === ET.TOUCH_CANCEL ||
                    (ET.PROXIMITY_OUT !== undefined && t === ET.PROXIMITY_OUT);
                if (!releaseLike)
                    return Clutter.EVENT_PROPAGATE;
            }

            this._commitPenStrokeFromCapture();
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
            this._lastGoodCapStageXY = null;
            this._penProximityArmed = false;
            this._penProximityArmedAt = 0;
            this._penAwaitInkAfterRange = true;
            this._penDeferredAnchorStageXY = null;
            this._model.commitCurrent();
            this._model.finishErase();
        } else {
            this._syncGeometry();
            this._ensureStackedOnTop();
            this._penAwaitInkAfterRange = true;
            this._penDeferredAnchorStageXY = null;
            this._bumpDockActivity();
        }
        this._syncPenStageCapture();
        this._drawArea.queue_repaint();
        this._ext.syncShellPointerPassthrough(this._root.visible);
    }

    get visible() {
        return this._root.visible;
    }

    destroy() {
        if (this._dockShrinkSrc) {
            GLib.source_remove(this._dockShrinkSrc);
            this._dockShrinkSrc = 0;
        }
        if (this._dockDragSafetySrc) {
            GLib.source_remove(this._dockDragSafetySrc);
            this._dockDragSafetySrc = undefined;
        }
        if (this._dockDragSeq) {
            global.stage.disconnect(this._dockDragSeq);
            this._dockDragSeq = undefined;
        }
        for (const { actor, id } of this._penCapConnections) {
            try {
                actor.disconnect(id);
            } catch {
                /* ignore */
            }
        }
        this._penCapConnections = [];
        if (this._monitorsSig) {
            Main.layoutManager.disconnect(this._monitorsSig);
            this._monitorsSig = 0;
        }
        try {
            this._drawArea._annoSession = null;
        } catch {
            /* ignore */
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
