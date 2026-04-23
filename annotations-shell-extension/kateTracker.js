/* SPDX-License-Identifier: GPL-2.0-or-later */

/* Kate-specific scroll-following tracker for annotations.
 *
 * Design: one per-window `KateWindowTracker` per currently-mapped Kate
 * top-level. On enable(), this module does an Atspi.init, registers
 * two global AT-SPI listeners (value-changed for scroll, bounds-changed
 * for window layout shifts), walks each Kate window's accessibility
 * tree once to identify:
 *
 *   - the editor widget: the largest AT-SPI TEXT-role descendant that
 *     is NOT inside a TERMINAL-role ancestor (so Kate's embedded
 *     Konsole pane is excluded - this is the "separate the terminal
 *     and the code editing portion" requirement);
 *   - a vertical scrollbar near the editor, whose value-changed events
 *     will drive scroll updates.
 *
 * The editor's extents (in Atspi's WINDOW coord type, i.e. relative
 * to the top-level) are pushed to Mutter via SetWindowEditorRegion;
 * scroll updates are computed from the editor's text interface
 * (character 0's window-local y vs. its baseline captured on first
 * publish) so we don't have to guess whether the scrollbar reports
 * values in lines, pixels, or document units.
 *
 * All Mutter-side identification is by PID: the tracker collects
 * `meta_window_get_pid()` once and passes it through every D-Bus
 * call. Multiple Kate top-levels owned by the same PID share the same
 * scroll offset, which is correct for single-process Kate but a known
 * limitation if Kate is ever configured to embed multiple unrelated
 * documents in distinct top-levels under one process. */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Atspi from 'gi://Atspi';

const BUS = 'org.gnome.Mutter.Annotation';
const PATH = '/org/gnome/Mutter/Annotation';
const IFACE = 'org.gnome.Mutter.Annotation';

/* wm_class values Kate actually ships with, normalized to lowercase.
 * Wayland: 'org.kde.kate'. X11: 'kate'. Flatpak / packaging variants
 * occasionally show up with an 'org.kde.Kate' form so we case-fold. */
const KATE_WM_CLASSES = new Set(['kate', 'org.kde.kate']);

/* Reject accidental TEXT-role matches that are clearly not the main
 * editor (breadcrumb labels, line-number strip, tool-view title
 * bars). The real KateView is typically hundreds of pixels in both
 * dimensions; these thresholds are conservative but comfortably below
 * any editor-sized widget on a typical display. */
const MIN_EDITOR_WIDTH = 200;
const MIN_EDITOR_HEIGHT = 200;

/* How deep we're willing to walk each top-level. Kate's real tree
 * depth is ~10-15; a generous cap keeps a pathological widget graph
 * from stalling the Shell main loop. */
const MAX_TREE_DEPTH = 40;

/* Retries for initial accessibility discovery. Kate registers with
 * AT-SPI asynchronously after its window is mapped, so the first walk
 * often comes up empty. Back off exponentially and then give up. */
const DISCOVERY_ATTEMPT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 6000];

function dbusCall(methodName, parameters) {
    Gio.DBus.session.call(
        BUS, PATH, IFACE, methodName,
        parameters ?? null, null,
        Gio.DBusCallFlags.NONE, -1, null,
        (c, res) => {
            try { c.call_finish(res); }
            catch (e) { /* Mutter not owning the name yet, etc. -- swallow. */ }
        });
}

function removeSource(id) {
    if (id)
        GLib.source_remove(id);
    return 0;
}

/* Safe wrappers: AT-SPI calls throw opaque GLib errors whenever an
 * accessible has gone stale (window closed, Qt app quit, cache
 * evicted). We never want those to take the Shell main loop down. */
function safeRole(acc) {
    try { return acc.get_role(); } catch (e) { return -1; }
}

function safeExtents(acc, coordType) {
    try { return acc.get_extents(coordType); }
    catch (e) { return null; }
}

function safeChildCount(acc) {
    try { return acc.get_child_count(); } catch (e) { return 0; }
}

function safeChild(acc, i) {
    try { return acc.get_child_at_index(i); } catch (e) { return null; }
}

function safePid(acc) {
    try { return acc.get_process_id(); } catch (e) { return -1; }
}

/* Per-Kate-window state + polling cache. */
class KateWindowTracker {
    constructor(win, owner) {
        this.win = win;
        this.owner = owner;
        this.pid = win.get_pid();
        this.wmClass = win.get_wm_class() ?? '';

        this.editor = null;         /* Atspi.Accessible of the KateView-ish widget */
        this.scrollbar = null;      /* cached editor-adjacent vertical scrollbar */
        /* Editor-relative Y of char 0 at tracker startup. Storing the
         * offset relative to the editor widget (not the window) means
         * a window resize / tool-view reflow that shifts the editor
         * inside its top-level doesn't leak into the scroll signal:
         * both char0 and editor move together, and their delta stays
         * constant until real scrolling happens. */
        this.charBaseYRel = null;
        this.lastRegionSig = '';    /* "x,y,w,h" last published, so we debounce */
        this.lastScrollY = null;

        this._sizeId = win.connect('size-changed', () => this._republishRegion());
        this._posId  = win.connect('position-changed', () => this._republishRegion());
        this._unmId  = win.connect('unmanaged', () => this.destroy());
        this._retryCount = 0;
        this._retryId = 0;

        this._scheduleDiscovery();
    }

    /* Walks through the process tree once per retry attempt. Stops
     * retrying once we've found both the editor and a plausible
     * scrollbar, OR once DISCOVERY_ATTEMPT_DELAYS_MS is exhausted
     * (editor-only is still useful: SetWindowEditorRegion goes out and
     * ink pins to the window without follow-scroll until the user
     * triggers bounds-changed later). */
    _scheduleDiscovery() {
        const delay = DISCOVERY_ATTEMPT_DELAYS_MS[
            Math.min(this._retryCount, DISCOVERY_ATTEMPT_DELAYS_MS.length - 1)];
        this._retryId = removeSource(this._retryId);
        this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._retryId = 0;
            if (!this.win) return GLib.SOURCE_REMOVE;

            this._tryDiscover();

            const gotEverything = this.editor && this.scrollbar;
            const exhausted = ++this._retryCount >= DISCOVERY_ATTEMPT_DELAYS_MS.length;
            if (gotEverything || exhausted) {
                /* Single, actionable warning if we gave up without
                 * the minimum required pieces. Pointing at the real
                 * cause (Qt accessibility off, at-spi2-core not
                 * running) is much more useful than silent failure;
                 * see KATE_COMPATIBILITY.md for the full diagnosis
                 * flow. Gated on exhaustion so a normal app startup
                 * (which typically resolves on the first or second
                 * retry) stays quiet. */
                if (exhausted && !this.editor) {
                    console.warn(
                        `KateTrackerManager: discovery exhausted for pid ${this.pid} ` +
                        `(wm_class='${this.wmClass}') without finding an editor accessible. ` +
                        'Scroll-following will be inactive for this window. ' +
                        'Likely causes: at-spi2-core is not running on the session bus, ' +
                        'or Qt accessibility is disabled. See KATE_COMPATIBILITY.md.');
                } else if (exhausted && this.editor && this.charBaseYRel === null) {
                    console.warn(
                        `KateTrackerManager: editor found for pid ${this.pid} ` +
                        'but Text.get_character_extents(0) kept returning a degenerate ' +
                        'rect; scroll-following may be imprecise. ' +
                        'Open a non-empty document in this editor.');
                }
                return GLib.SOURCE_REMOVE;
            }
            this._scheduleDiscovery();
            return GLib.SOURCE_REMOVE;
        });
    }

    _tryDiscover() {
        let app = null;
        let desktop = null;
        try { desktop = Atspi.get_desktop(0); } catch (e) { return; }
        if (!desktop) return;

        const n = safeChildCount(desktop);
        for (let i = 0; i < n; i++) {
            const a = safeChild(desktop, i);
            if (!a) continue;
            if (safePid(a) === this.pid) { app = a; break; }
        }
        if (!app) return;

        const found = { editor: null, editorArea: 0, scrollbar: null };
        this._walk(app, 0, false, found);

        if (found.editor)
            this.editor = found.editor;
        if (found.scrollbar)
            this.scrollbar = found.scrollbar;

        if (this.editor) {
            this._captureBaseline();
            this._republishRegion();
            /* Scroll state may be non-zero at discovery (user opened
             * Kate already scrolled into the doc). Push once. */
            this._republishScroll();
        }
    }

    /* Depth-first walk. `inTerminal` propagates down from any
     * TERMINAL-role ancestor so Konsole's embedded text view can't be
     * mis-selected as the editor. */
    _walk(node, depth, inTerminal, found) {
        if (!node || depth > MAX_TREE_DEPTH) return;
        const role = safeRole(node);

        const insideTerminal = inTerminal || role === Atspi.Role.TERMINAL;

        if (!insideTerminal && role === Atspi.Role.TEXT) {
            const ext = safeExtents(node, Atspi.CoordType.WINDOW);
            if (ext && ext.width >= MIN_EDITOR_WIDTH &&
                ext.height >= MIN_EDITOR_HEIGHT) {
                const area = ext.width * ext.height;
                if (area > found.editorArea) {
                    /* Found a better editor candidate. Any previously
                     * cached scrollbar was tied to the old candidate;
                     * reset so the search below re-picks one adjacent
                     * to the new winner. */
                    found.editor = node;
                    found.editorArea = area;
                    found.scrollbar = null;
                }
            }
        }

        /* Collect vertical scrollbars as we see them. A later pass
         * filters to the one adjacent to the best editor. */
        if (!insideTerminal && role === Atspi.Role.SCROLL_BAR) {
            const ext = safeExtents(node, Atspi.CoordType.WINDOW);
            if (ext && ext.height > ext.width && ext.height >= 30) {
                /* Keep the first editor-adjacent scrollbar if we
                 * already have an editor; else stash it and we'll
                 * match it up after the walk. */
                if (found.editor && !found.scrollbar) {
                    if (this._scrollbarAdjacent(ext, found.editor))
                        found.scrollbar = node;
                } else if (!found.editor) {
                    found.scrollbar = node;
                }
            }
        }

        const n = safeChildCount(node);
        for (let i = 0; i < n; i++)
            this._walk(safeChild(node, i), depth + 1, insideTerminal, found);
    }

    /* "Adjacent" = vertical scrollbar on the right edge of the
     * editor, with overlapping y-range. The 60px slack is generous
     * enough to cover Kate's optional mini-map / line-number strip
     * between the text area and the scrollbar. */
    _scrollbarAdjacent(sbExt, editorAcc) {
        const ed = safeExtents(editorAcc, Atspi.CoordType.WINDOW);
        if (!ed) return false;
        const nearRight = Math.abs(sbExt.x - (ed.x + ed.width)) < 60 ||
                          (sbExt.x >= ed.x && sbExt.x <= ed.x + ed.width + 60);
        const yOverlap = (sbExt.y + sbExt.height > ed.y) &&
                         (sbExt.y < ed.y + ed.height);
        return nearRight && yOverlap;
    }

    /* Capture the editor-relative y of character 0 once at discovery.
     * `char0.y - editor.y` is invariant under editor relocation inside
     * its top-level (both move together); only document scrolling
     * changes it. That lets later scroll-event handling compute a
     * pure pixel delta without also picking up tool-view reflow noise. */
    _captureBaseline() {
        if (!this.editor || this.charBaseYRel !== null) return;
        try {
            const text = this.editor.query_text?.();
            if (!text) return;
            const rect = text.get_character_extents(0, Atspi.CoordType.WINDOW);
            const ed = safeExtents(this.editor, Atspi.CoordType.WINDOW);
            /* Qt's accessible-text impl has been observed to hand back an
             * all-zero rect when char 0 is scrolled far enough out of
             * view that the layout cache doesn't currently hold it.
             * Treat that as "no baseline available" and let the next
             * value-changed event re-try; baselining to a garbage 0
             * would wedge every future scroll delta. */
            if (rect && ed && !(rect.x === 0 && rect.y === 0 &&
                                rect.width === 0 && rect.height === 0))
                this.charBaseYRel = rect.y - ed.y;
        } catch (e) { /* no Text interface? we'll fall back later */ }
    }

    _republishRegion() {
        if (!this.editor || !this.win) return;
        if (this.win.minimized) return;
        const ext = safeExtents(this.editor, Atspi.CoordType.WINDOW);
        if (!ext || ext.width < 1 || ext.height < 1) return;

        const x = Math.round(ext.x);
        const y = Math.round(ext.y);
        const w = Math.round(ext.width);
        const h = Math.round(ext.height);
        const sig = `${x},${y},${w},${h}`;
        if (sig === this.lastRegionSig) return;
        this.lastRegionSig = sig;

        dbusCall('SetWindowEditorRegion',
            new GLib.Variant('(uiiii)', [this.pid, x, y, w, h]));
    }

    /* Recompute scroll_y from char 0's current editor-relative y and
     * the baseline captured at discovery. Result is in pixels:
     * scrolling the document downward raises scroll_y, which matches
     * the compositor's convention (positive scroll moves ink upward
     * in the viewport). Falls back to the raw scrollbar value if the
     * Text interface isn't available -- that yields correct motion
     * direction, possibly at a reduced / line-quantized resolution,
     * which still beats nothing. */
    _republishScroll() {
        if (!this.editor) return;
        let sy = 0;
        let ok = false;

        if (this.charBaseYRel !== null) {
            try {
                const text = this.editor.query_text?.();
                if (text) {
                    const rect = text.get_character_extents(0, Atspi.CoordType.WINDOW);
                    const ed = safeExtents(this.editor, Atspi.CoordType.WINDOW);
                    /* Same guard as _captureBaseline: trust a
                     * non-degenerate rect only. A zero-rect response
                     * here would compute a spurious multi-hundred-px
                     * scroll spike and shove every follow stroke off
                     * the editor for one frame. */
                    if (rect && ed && !(rect.x === 0 && rect.y === 0 &&
                                        rect.width === 0 && rect.height === 0)) {
                        const curRel = rect.y - ed.y;
                        sy = this.charBaseYRel - curRel;
                        ok = true;
                    }
                }
            } catch (e) { /* stale accessible; drop through */ }
        }

        if (!ok && this.scrollbar) {
            try {
                const v = this.scrollbar.query_value?.();
                if (v) {
                    sy = Math.round(v.current_value);
                    ok = true;
                }
            } catch (e) { /* no Value interface? give up silently */ }
        }

        if (!ok) return;

        const syRound = Math.round(sy);
        if (this.lastScrollY === syRound) return;
        this.lastScrollY = syRound;

        dbusCall('SetWindowScroll',
            new GLib.Variant('(uii)', [this.pid, 0, syRound]));
    }

    /* Identifies an AT-SPI event as belonging to this tracker's Kate
     * window. Prefers direct reference equality with our cached
     * scrollbar (fast, zero false positives), falls back to
     * pid + role + bounds-adjacent-to-editor (covers the case where
     * Atspi rebuilds the wrapper objects between the tree walk and
     * the event, which reportedly happens on app resume from
     * suspend). */
    handleValueChangedSource(source) {
        if (!source) return false;
        if (safePid(source) !== this.pid) return false;
        if (safeRole(source) !== Atspi.Role.SCROLL_BAR) return false;

        if (this.scrollbar && source === this.scrollbar) {
            this._republishScroll();
            return true;
        }

        /* Reference didn't match but PID + role did. Accept if the
         * scrollbar is adjacent to our cached editor. This covers the
         * fresh-wrapper case and also lets us pick up the editor
         * scrollbar if discovery ran before Kate had finished
         * building its widget tree. */
        if (!this.editor) return false;
        const ext = safeExtents(source, Atspi.CoordType.WINDOW);
        if (!ext || ext.height <= ext.width) return false;
        if (!this._scrollbarAdjacent(ext, this.editor)) return false;

        this.scrollbar = source;
        this._republishScroll();
        return true;
    }

    handleBoundsChangedSource(source) {
        if (!source || !this.editor) return false;
        if (safePid(source) !== this.pid) return false;
        if (source !== this.editor) return false;

        /* Editor's on-screen footprint moved within its top-level
         * (tool view opened, tab bar toggled, etc). Republish the
         * region so Mutter's clip / origin match. Crucially we do
         * *not* re-baseline char0: scrolling hasn't happened, and
         * charBaseYRel is editor-relative so a pure editor relocation
         * doesn't invalidate it. Re-baselining here would retroactively
         * shift every already-stored follow stroke. */
        this.lastRegionSig = '';
        this._republishRegion();
        return true;
    }

    destroy() {
        this._retryId = removeSource(this._retryId);
        if (this._sizeId) { try { this.win.disconnect(this._sizeId); } catch (e) {} this._sizeId = 0; }
        if (this._posId)  { try { this.win.disconnect(this._posId);  } catch (e) {} this._posId  = 0; }
        if (this._unmId)  { try { this.win.disconnect(this._unmId);  } catch (e) {} this._unmId  = 0; }

        /* Best-effort region clear so Mutter doesn't keep a stale
         * editor region cached against the now-dead WindowInk. */
        if (this.pid > 0) {
            dbusCall('SetWindowEditorRegion',
                new GLib.Variant('(uiiii)', [this.pid, 0, 0, 0, 0]));
        }

        this.owner._forgetTracker(this.win);
        this.editor = null;
        this.scrollbar = null;
        this.win = null;
    }
}

/* Top-level: one instance lives alongside the extension, spun up in
 * enable() and torn down in disable(). */
export class KateTrackerManager {
    constructor() {
        this._trackers = new Map();      /* MetaWindow -> KateWindowTracker */
        this._displayWindowCreatedId = 0;
        this._atspiListener = null;
        this._atspiRegistered = [];
        this._initialized = false;
    }

    enable() {
        if (this._initialized) return;

        try {
            /* Atspi.init() is idempotent and returns 0 on success;
             * any throw here leaves us with _initialized=false and
             * subsequent enable() calls retry. */
            const rc = Atspi.init();
            if (rc !== 0 && rc !== 1) {
                console.warn(`KateTrackerManager: Atspi.init rc=${rc}`);
                return;
            }
        } catch (e) {
            console.warn(`KateTrackerManager: Atspi.init failed: ${e.message}`);
            return;
        }

        try {
            this._atspiListener =
                Atspi.EventListener.new_simple((event) => this._onAtspiEvent(event));
        } catch (e) {
            console.warn(`KateTrackerManager: EventListener.new_simple failed: ${e.message}`);
            return;
        }

        for (const type of ['object:value-changed', 'object:bounds-changed']) {
            try {
                this._atspiListener.register(type);
                this._atspiRegistered.push(type);
            } catch (e) {
                console.warn(`KateTrackerManager: register(${type}) failed: ${e.message}`);
            }
        }

        /* Existing Kate windows (extension enabled after Kate was
         * already running). list_all_windows is defined on
         * MetaDisplay and returns a GList that GJS flattens to
         * JS array. */
        let existing = [];
        try { existing = global.display.list_all_windows(); }
        catch (e) {
            /* Some Shell versions don't expose this; fall back to
             * workspace iteration. */
            try {
                const ws = global.workspace_manager;
                for (let i = 0; i < ws.get_n_workspaces(); i++)
                    existing.push(...ws.get_workspace_by_index(i).list_windows());
            } catch (e2) { /* leave existing empty */ }
        }
        for (const w of existing) {
            if (this._isKate(w)) this._trackIfNew(w);
        }

        this._displayWindowCreatedId = global.display.connect(
            'window-created', (_display, w) => {
                if (this._isKate(w)) this._trackIfNew(w);
            });

        this._initialized = true;
    }

    disable() {
        if (!this._initialized) return;

        if (this._displayWindowCreatedId) {
            try { global.display.disconnect(this._displayWindowCreatedId); } catch (e) {}
            this._displayWindowCreatedId = 0;
        }

        if (this._atspiListener) {
            for (const type of this._atspiRegistered) {
                try { this._atspiListener.deregister(type); } catch (e) {}
            }
            this._atspiRegistered = [];
            this._atspiListener = null;
        }

        /* Trackers remove themselves from the map during destroy();
         * snapshot first so we're not mutating during iteration. */
        const snapshot = [...this._trackers.values()];
        this._trackers.clear();
        for (const t of snapshot) {
            try { t.destroy(); } catch (e) {}
        }

        this._initialized = false;
    }

    _isKate(win) {
        if (!win) return false;
        const cls = win.get_wm_class();
        return !!cls && KATE_WM_CLASSES.has(cls.toLowerCase());
    }

    _trackIfNew(win) {
        if (this._trackers.has(win)) return;
        const tracker = new KateWindowTracker(win, this);
        this._trackers.set(win, tracker);
    }

    _forgetTracker(win) {
        if (win) this._trackers.delete(win);
    }

    _onAtspiEvent(event) {
        if (!event || !event.source) return;
        if (this._trackers.size === 0) return;

        /* Fast pid prefilter: AT-SPI broadcasts events from every
         * app; skipping non-Kate events at the top of the callback
         * keeps the cost negligible for the 99% case. */
        const evPid = safePid(event.source);
        if (evPid <= 0) return;

        let pidMatches = false;
        for (const t of this._trackers.values()) {
            if (t.pid === evPid) { pidMatches = true; break; }
        }
        if (!pidMatches) return;

        const type = event.type;
        for (const t of this._trackers.values()) {
            if (t.pid !== evPid) continue;
            if (type === 'object:value-changed') {
                if (t.handleValueChangedSource(event.source)) break;
            } else if (type === 'object:bounds-changed') {
                if (t.handleBoundsChangedSource(event.source)) break;
            }
        }
    }
}
