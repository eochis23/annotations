/* SPDX-License-Identifier: GPL-2.0-or-later */
import Clutter from 'gi://Clutter';
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
    overlayPenCanvasAcceptsPickEvent,
    stylusModeOnPress,
} from './devices.js';

/** Pressure above this starts a stroke when the driver never sends BUTTON_PRESS (tablet + Wayland). */
const IMPLICIT_PRESSURE_START = 0.015;

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
        const accept = overlayPenCanvasAcceptsPickEvent(ev);
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
        /** @type {object|null} stage that owns `_penStageCapSig` */
        this._penCapStage = null;
        /** @type {number} `captured-event` handler id */
        this._penStageCapSig = 0;
        /** When set, {@link _localFromEvent} uses this stage pair instead of {@link _stageCoordsFromEvent}. */
        this._penCapStageXYUse = false;
        /** @type {[number, number]|null} */
        this._penCapStageXYPair = null;
        /** @type {number} DEBUG: first N coord-repair samples (hypothesis H) */
        this._penCoordRepairDbgN = 0;
        /** @type {number} DEBUG: dock vs master pointer disagree (hypothesis I) */
        this._penDockPtrOverrideDbgN = 0;
        this._monitorsSig = 0;

        this._drawArea = new PenOverlayDrawingArea({
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
        this._syncPenStageCapture();
    }

    /**
     * Pick often runs without {@link Clutter.get_current_event}, so the canvas is omitted from
     * hit-testing for the pen too. Capture pen events on the stage before they reach the actor
     * picked below the overlay; mouse stays pick-based pass-through.
     */
    _syncPenStageCapture() {
        const want = this._root.visible;
        if (want && !this._penStageCapSig) {
            const st =
                global.stage ??
                (typeof Main?.uiGroup?.get_stage === 'function' ? Main.uiGroup.get_stage() : null);
            if (st && typeof st.connect === 'function') {
                this._penCapStage = st;
                this._penStageCapSig = st.connect('captured-event', (_actor, event) =>
                    this._onPenStageCaptured(event)
                );
                // #region agent log
                annoDebug({
                    hypothesisId: 'F',
                    location: 'overlaySession.js:_syncPenStageCapture',
                    message: 'pen stage capture connected',
                    data: { sig: this._penStageCapSig, usedUiGroupStage: st !== global.stage },
                });
                // #endregion
            }
        } else if (!want && this._penStageCapSig) {
            try {
                this._penCapStage?.disconnect(this._penStageCapSig);
            } catch {
                /* ignore */
            }
            this._penStageCapSig = 0;
            this._penCapStage = null;
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

    /** @param {number} sx @param {number} sy stage coordinates */
    _stagePointInOverlayRoot(sx, sy) {
        const L = this._rootLocalFromStageXY(sx, sy);
        if (L) {
            try {
                const br = this._root.get_allocation_box();
                const [lx, ly] = L;
                return lx >= br.x1 && ly >= br.y1 && lx < br.x2 && ly < br.y2;
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

    _penCaptureAcceptsEvent(event) {
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
        )
            return true;
        if (!this._penDown)
            return false;
        if (!ET || t == null || t === undefined)
            return false;
        return (
            t === ET.MOTION ||
            t === ET.TOUCH_UPDATE ||
            t === ET.BUTTON_RELEASE ||
            t === ET.TOUCH_END ||
            t === ET.TOUCH_CANCEL ||
            (ET.PROXIMITY_OUT !== undefined && t === ET.PROXIMITY_OUT)
        );
    }

    /**
     * @param {Clutter.Event} event
     * @returns {Clutter.EventReturn}
     */
    _onPenStageCaptured(event) {
        if (!this._root.visible)
            return Clutter.EVENT_PROPAGATE;
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
        if (!this._penCaptureAcceptsEvent(event))
            return Clutter.EVENT_PROPAGATE;

        const xy = this._stageCoordsFromEvent(event);
        if (!xy)
            return Clutter.EVENT_PROPAGATE;
        const [sx, sy] = xy;
        if (typeof sx !== 'number' || typeof sy !== 'number' || Number.isNaN(sx) || Number.isNaN(sy))
            return Clutter.EVENT_PROPAGATE;
        const tGate = clutterEventType(event);
        const ETGate = Clutter.EventType;
        const proxInGate =
            ETGate &&
            ETGate.PROXIMITY_IN !== undefined &&
            tGate === ETGate.PROXIMITY_IN &&
            eventIsPenDrawDevice(event);
        const enterPenGate =
            ETGate && ETGate.ENTER !== undefined && tGate === ETGate.ENTER && eventIsPenDrawDevice(event);

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
        let inR2 = this._stagePointInOverlayRoot(sx1, sy1);
        if (
            !inR2 &&
            this._penDown &&
            ETGate &&
            tGate != null &&
            (tGate === ETGate.MOTION || tGate === ETGate.TOUCH_UPDATE)
        ) {
            const [cx, cy] = this._clampStageXYToRootBounds(sx1, sy1);
            sx1 = cx;
            sy1 = cy;
            inR2 = this._stagePointInOverlayRoot(sx1, sy1);
        }
        if (!inR2 && !proxInGate && !enterPenGate)
            return Clutter.EVENT_PROPAGATE;
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
        /* Let the dock take hover/clicks. If a stroke was started on the canvas (e.g. after ENTER
         * armed proximity) and the pen then moves onto the palette, commit first — logs showed
         * MOTION at ~1029×235 then ~217×40 with inDock true, producing a spurious long segment. */
        if (inR2 && this._stagePointInDockPalette(sx1, sy1)) {
            if (!this._penDown || !eventIsPenDrawDevice(event))
                return Clutter.EVENT_PROPAGATE;
            /* Tablet MOTION coords can disagree with the core pointer (logs G: inDock true on ev
             * while drawing). Require master pointer agreement before committing mid-stroke. */
            let commitForDock = true;
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
                    if (!this._stagePointInDockPalette(p[0], p[1])) {
                        commitForDock = false;
                        if (this._penDockPtrOverrideDbgN < 20) {
                            this._penDockPtrOverrideDbgN++;
                            // #region agent log
                            annoDebug({
                                hypothesisId: 'I',
                                location: 'overlaySession.js:_onPenStageCaptured',
                                message: 'dock hit ignored; pointer on canvas',
                                data: { sx1, sy1, px: p[0], py: p[1] },
                            });
                            // #endregion
                        }
                    }
                }
            } catch {
                /* keep commitForDock */
            }
            if (commitForDock) {
                this._commitPenStrokeFromCapture();
                return Clutter.EVENT_PROPAGATE;
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
            return Clutter.EVENT_PROPAGATE;
        let t = clutterEventType(event);
        /* Some stacks omit get_event_type on wrapped events; pen still has coords + device. */
        if (t == null || t === undefined) {
            if (this._penCaptureAcceptsEvent(event))
                t = ET.MOTION;
            else
                return Clutter.EVENT_PROPAGATE;
        }
        if (t === ET.BUTTON_PRESS || t === ET.TOUCH_BEGIN)
            return this._dispatchPenCapture(sx1, sy1, () => this._onPress(this._drawArea, event));
        if (t === ET.MOTION || t === ET.TOUCH_UPDATE)
            return this._dispatchPenCapture(sx1, sy1, () => this._onMotion(this._drawArea, event));
        if (t === ET.BUTTON_RELEASE || t === ET.TOUCH_END || t === ET.TOUCH_CANCEL)
            return this._dispatchPenCapture(sx1, sy1, () => this._onRelease(this._drawArea, event));
        /* Do not clear _penProximityArmed here: rapid PROXIMITY_OUT/IN flicker was clearing the arm
         * before POINTER MOTION arrived (logs: only evT 16/17/4, never evT 3 — drawing starved). */
        if (ET.PROXIMITY_OUT !== undefined && t === ET.PROXIMITY_OUT)
            return this._dispatchPenCapture(sx1, sy1, () => this._onRelease(this._drawArea, event));
        /* Arm then let _onMotion run so PROXIMITY_IN + pressure/tool can start a stroke when MOTION
         * is missing from capture; dock excluded in _penMotionShouldImplicitPress. */
        if (ET.PROXIMITY_IN !== undefined && t === ET.PROXIMITY_IN) {
            this._penProximityArmed = true;
            this._penProximityArmedAt = Date.now();
            if (inR2)
                this._dispatchPenCapture(sx1, sy1, () => this._onMotion(this._drawArea, event));
            return Clutter.EVENT_STOP;
        }
        if (ET.ENTER !== undefined && t === ET.ENTER) {
            if (eventIsPenDrawDevice(event)) {
                this._penProximityArmed = true;
                this._penProximityArmedAt = Date.now();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
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
            if (!eventIsPenDrawDevice(event))
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
            if (!this._root.visible)
                return Clutter.EVENT_PROPAGATE;

            if (!this._penDown) {
                if (!eventIsPenDrawDevice(event) && !this._penProximityArmed)
                    return Clutter.EVENT_PROPAGATE;
                if (this._penMotionShouldImplicitPress(event))
                    return this._onPress(actor, event);
                return Clutter.EVENT_PROPAGATE;
            }

            if (!eventIsPenDrawDevice(event)) {
                const t = clutterEventType(event);
                const ET = Clutter.EventType;
                if (!ET || t == null || (t !== ET.MOTION && t !== ET.TOUCH_UPDATE))
                    return Clutter.EVENT_PROPAGATE;
            }

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
            this._penProximityArmed = false;
            this._penProximityArmedAt = 0;
            this._model.commitCurrent();
            this._model.finishErase();
        } else {
            this._syncGeometry();
            this._ensureStackedOnTop();
        }
        this._syncPenStageCapture();
        this._drawArea.queue_repaint();
    }

    get visible() {
        return this._root.visible;
    }

    destroy() {
        if (this._penStageCapSig) {
            try {
                this._penCapStage?.disconnect(this._penStageCapSig);
            } catch {
                /* ignore */
            }
            this._penStageCapSig = 0;
            this._penCapStage = null;
        }
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
