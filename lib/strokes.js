/* SPDX-License-Identifier: GPL-2.0-or-later */
import Cairo from 'gi://cairo';

/** @typedef {{x:number,y:number,p:number}} Pt */
/** @typedef {{rgba:number[], pts:Pt[]}} Stroke */

const ERASE_RADIUS = 10;
const ERASE_RADIUS_SQ = ERASE_RADIUS * ERASE_RADIUS;

export function pressureToLineWidth(pressure) {
    const minW = 0.9;
    const maxW = 7.0;
    const floorP = 0.08;
    let p = pressure;
    if (p < floorP)
        p = floorP;
    if (p > 1.0)
        p = 1.0;
    return minW + (maxW - minW) * p;
}

function pointSegmentDistSq(px, py, ax, ay, bx, by) {
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const abLenSq = abx * abx + aby * aby;
    if (abLenSq < 1e-18) {
        const dx = px - ax;
        const dy = py - ay;
        return dx * dx + dy * dy;
    }
    let t = (apx * abx + apy * aby) / abLenSq;
    if (t < 0)
        t = 0;
    else if (t > 1)
        t = 1;
    const cx = ax + t * abx;
    const cy = ay + t * aby;
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy;
}

function pointToPolylineDistSq(px, py, pts) {
    if (!pts || pts.length === 0)
        return Number.POSITIVE_INFINITY;
    if (pts.length === 1) {
        const dx = px - pts[0].x;
        const dy = py - pts[0].y;
        return dx * dx + dy * dy;
    }
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i + 1 < pts.length; i++) {
        const d = pointSegmentDistSq(px, py,
            pts[i].x, pts[i].y,
            pts[i + 1].x, pts[i + 1].y);
        if (d < best)
            best = d;
    }
    return best;
}

function strokeHitByEraser(stroke, eraserPts) {
    if (!stroke.pts?.length || !eraserPts?.length)
        return false;
    for (const s of stroke.pts) {
        if (pointToPolylineDistSq(s.x, s.y, eraserPts) <= ERASE_RADIUS_SQ)
            return true;
    }
    for (const e of eraserPts) {
        if (pointToPolylineDistSq(e.x, e.y, stroke.pts) <= ERASE_RADIUS_SQ)
            return true;
    }
    return false;
}

export class StrokeModel {
    constructor() {
        /** @type {Stroke[]} */
        this.strokes = [];
        /** @type {Stroke|null} */
        this.current = null;
        /** @type {Pt[]} */
        this.eraserPath = null;
        /** @type {number[]} */
        this.penRGBA = [0.1, 0.1, 0.1, 1.0];
    }

    setPenColor(r, g, b, a = 1.0) {
        this.penRGBA = [r, g, b, a];
    }

    clearAll() {
        this.strokes = [];
        this.current = null;
        this.eraserPath = null;
    }

    /** Apply content-movement translation to all committed and in-progress geometry. */
    translateAll(dx, dy) {
        for (const s of this.strokes) {
            for (const p of s.pts) {
                p.x += dx;
                p.y += dy;
            }
        }
        if (this.current) {
            for (const p of this.current.pts) {
                p.x += dx;
                p.y += dy;
            }
        }
        if (this.eraserPath) {
            for (const p of this.eraserPath) {
                p.x += dx;
                p.y += dy;
            }
        }
    }

    beginStroke(x, y, p) {
        this.commitCurrent();
        this.eraserPath = null;
        this.current = { rgba: [...this.penRGBA], pts: [{ x, y, p }] };
    }

    beginErase(x, y) {
        this.commitCurrent();
        this.current = null;
        this.eraserPath = [{ x, y, p: 0 }];
    }

    appendErase(x, y) {
        if (!this.eraserPath)
            this.eraserPath = [];
        this.eraserPath.push({ x, y, p: 0 });
        this._applyEraser();
    }

    appendPoint(x, y, p) {
        if (!this.current)
            return;
        this.current.pts.push({ x, y, p });
    }

    commitCurrent() {
        if (this.current && this.current.pts.length > 0)
            this.strokes.push(this.current);
        this.current = null;
    }

    finishErase() {
        if (this.eraserPath?.length)
            this._applyEraser();
        this.eraserPath = null;
    }

    _applyEraser() {
        if (!this.eraserPath?.length)
            return;
        this.strokes = this.strokes.filter(s => !strokeHitByEraser(s, this.eraserPath));
    }

    /**
     * @param {import('cairo').Context} cr
     * @param {number} width
     * @param {number} height
     */
    paint(cr, width, height) {
        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();
        cr.setOperator(Cairo.Operator.OVER);

        for (const s of this.strokes)
            this._drawStroke(cr, s);
        if (this.current)
            this._drawStroke(cr, this.current);
        if (this.eraserPath?.length > 1) {
            cr.save();
            cr.setSourceRGBA(1, 0.2, 0.2, 0.35);
            cr.setLineWidth(2);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.moveTo(this.eraserPath[0].x, this.eraserPath[0].y);
            for (let i = 1; i < this.eraserPath.length; i++)
                cr.lineTo(this.eraserPath[i].x, this.eraserPath[i].y);
            cr.stroke();
            cr.restore();
        }
    }

    /**
     * @param {cairo.Context} cr
     * @param {Stroke} stroke
     */
    _drawStroke(cr, stroke) {
        const pts = stroke.pts;
        if (!pts?.length)
            return;
        const [r, g, b, a] = stroke.rgba;
        cr.setSourceRGBA(r, g, b, a);
        if (pts.length === 1) {
            let rad = 0.5 * pressureToLineWidth(pts[0].p);
            if (rad < 0.5)
                rad = 0.5;
            cr.arc(pts[0].x, pts[0].y, rad, 0, Math.PI * 2);
            cr.fill();
            return;
        }
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        for (let i = 0; i + 1 < pts.length; i++) {
            const w = 0.5 * (pressureToLineWidth(pts[i].p) + pressureToLineWidth(pts[i + 1].p));
            cr.setLineWidth(w);
            cr.moveTo(pts[i].x, pts[i].y);
            cr.lineTo(pts[i + 1].x, pts[i + 1].y);
            cr.stroke();
        }
    }

    serialize() {
        return JSON.stringify({
            strokes: this.strokes,
        });
    }

    /**
     * @param {string} json
     */
    deserialize(json) {
        try {
            const o = JSON.parse(json);
            if (o.strokes && Array.isArray(o.strokes))
                this.strokes = o.strokes;
        } catch {
            /* ignore */
        }
    }
}
