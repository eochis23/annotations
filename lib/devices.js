/* SPDX-License-Identifier: GPL-2.0-or-later */
import Clutter from 'gi://Clutter';

/**
 * @param {Clutter.Event} event
 * @returns {Clutter.EventType|null}
 */
export function clutterEventType(event) {
    if (!event)
        return null;
    try {
        if (typeof event.get_event_type === 'function')
            return event.get_event_type();
    } catch {
        /* ignore */
    }
    /* Do not call event.get_type(): on GJS that is usually GObject.get_type() (a GType id),
       not Clutter.EventType — it produced bogus values (e.g. 4, 16) in debug logs. */
    try {
        if (typeof event.type === 'function')
            return event.type();
    } catch {
        /* ignore */
    }
    try {
        if (typeof event.type === 'number')
            return event.type;
    } catch {
        /* ignore */
    }
    try {
        const et = /** @type {*} */ (event).event_type;
        if (typeof et === 'number')
            return et;
    } catch {
        /* ignore */
    }
    return null;
}

/**
 * Prefer source device (hardware); `get_device()` can throw on some Mutter/GJS builds.
 * @param {Clutter.Event} event
 * @returns {object|null}
 */
function inputDeviceFromEvent(event) {
    if (!event)
        return null;
    try {
        if (typeof event.get_source_device === 'function') {
            const d = event.get_source_device();
            if (d)
                return d;
        }
    } catch {
        /* ignore */
    }
    try {
        if (typeof event.get_device === 'function')
            return event.get_device() ?? null;
    } catch {
        return null;
    }
    return null;
}

/** @param {object|null} device */
function safeDeviceType(device) {
    if (!device)
        return null;
    try {
        return device.get_device_type();
    } catch {
        return null;
    }
}

/** @param {object} IDT `Clutter.InputDeviceType` */
function clutterPointerDeviceType(IDT) {
    if (!IDT)
        return null;
    if (IDT.POINTER_DEVICE !== undefined)
        return IDT.POINTER_DEVICE;
    if (IDT.POINTER !== undefined)
        return IDT.POINTER;
    return null;
}

/**
 * Physical pen / tablet tool (not mouse, not pad, not touchscreen).
 * Names vary across Mutter/GIR: TABLET_TOOL vs PEN_DEVICE/ERASER_DEVICE; POINTER vs POINTER_DEVICE.
 * @param {number|null|undefined} type `Clutter.InputDeviceType`
 * @param {object} IDT
 */
function clutterDeviceTypeIsPenHardware(type, IDT) {
    if (type == null || type === undefined || !IDT)
        return false;
    for (const k of ['TABLET_TOOL', 'TABLET_DEVICE', 'PEN_DEVICE', 'ERASER_DEVICE']) {
        if (IDT[k] !== undefined && type === IDT[k])
            return true;
    }
    return false;
}

/**
 * Wayland tablet events often carry a non-null `Clutter.Event.get_device_tool`
 * (pen / eraser / brush, …) while `get_device_type` stays generic.
 * Excludes tool type MOUSE so the tablet puck stays click-through.
 * @param {Clutter.Event} event
 */
export function eventHasStylusDeviceTool(event) {
    try {
        if (typeof event.get_device_tool !== 'function')
            return false;
        const tool = event.get_device_tool();
        if (!tool)
            return false;
        const TTT = Clutter.InputDeviceToolType;
        if (!TTT)
            return false;
        let tt = null;
        if (typeof tool.get_tool_type === 'function')
            tt = tool.get_tool_type();
        if (tt == null || tt === TTT.NONE || tt === TTT.MOUSE)
            return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * @param {Clutter.Event} event
 * @returns {number|null|undefined}
 */
function clutterEventDeviceType(event) {
    if (!event)
        return null;
    try {
        if (typeof event.get_device_type === 'function')
            return event.get_device_type();
    } catch {
        /* ignore */
    }
    return null;
}

/**
 * @param {Clutter.Event} event
 * @returns {boolean}
 */
export function eventIsPointerButtonOrMotion(event) {
    const t = clutterEventType(event);
    const ET = Clutter.EventType;
    if (!ET || t == null)
        return false;
    return (
        t === ET.BUTTON_PRESS ||
        t === ET.BUTTON_RELEASE ||
        t === ET.MOTION ||
        t === ET.TOUCH_BEGIN ||
        t === ET.TOUCH_UPDATE ||
        t === ET.TOUCH_END ||
        t === ET.TOUCH_CANCEL ||
        (ET.PROXIMITY_IN !== undefined && t === ET.PROXIMITY_IN) ||
        (ET.PROXIMITY_OUT !== undefined && t === ET.PROXIMITY_OUT) ||
        t === ET.ENTER ||
        t === ET.LEAVE
    );
}

function isLikelyPointerEvent(event) {
    const t = clutterEventType(event);
    if (t === null || t === undefined)
        return false;
    const ET = Clutter.EventType;
    if (!ET)
        return false;
    const candidates = [
        ET.BUTTON_PRESS,
        ET.BUTTON_RELEASE,
        ET.MOTION,
        ET.TOUCH_BEGIN,
        ET.TOUCH_UPDATE,
        ET.TOUCH_END,
        ET.PROXIMITY_IN,
        ET.PROXIMITY_OUT,
        ET.PAD_BUTTON_PRESS,
        ET.PAD_BUTTON_RELEASE,
    ];
    for (const c of candidates) {
        if (c !== undefined && t === c)
            return true;
    }
    return false;
}

function isLikelyKeyOrScrollEvent(event) {
    const t = clutterEventType(event);
    if (t === null || t === undefined)
        return false;
    const ET = Clutter.EventType;
    if (!ET)
        return false;
    return (
        t === ET.KEY_PRESS ||
        t === ET.KEY_RELEASE ||
        t === ET.SCROLL ||
        t === ET.SCROLL_STOP ||
        t === ET.TOUCHPAD_PINCH ||
        t === ET.TOUCHPAD_SWIPE
    );
}

/**
 * If we cannot read event type but get_button works, treat as pointer (never for keys).
 * @param {Clutter.Event} event
 */
function looksLikePointerByButton(event) {
    if (isLikelyKeyOrScrollEvent(event))
        return false;
    try {
        if (typeof event.get_button !== 'function')
            return false;
        const b = event.get_button();
        return b >= 0 && b <= 32;
    } catch {
        return false;
    }
}

/**
 * Device-based stylus detection only — never assume uncaught native calls are safe.
 * @param {Clutter.Event} event
 * @returns {boolean}
 */
export function eventIsStylusLike(event) {
    try {
        if (eventHasStylusDeviceTool(event))
            return true;

        const IDT = Clutter.InputDeviceType;
        if (!IDT)
            return false;

        const fromEvent = clutterEventDeviceType(event);
        if (clutterDeviceTypeIsPenHardware(fromEvent, IDT))
            return true;

        const device = inputDeviceFromEvent(event);
        const type = safeDeviceType(device);
        if (clutterDeviceTypeIsPenHardware(type, IDT))
            return true;

        const ptrT = clutterPointerDeviceType(IDT);
        if (ptrT != null && type === ptrT && eventHasPressure(event))
            return true;

        return false;
    } catch {
        return false;
    }
}

/**
 * Pen / tablet tool only (no mouse, no finger touch): pen/eraser/tablet-tool device types,
 * or a core pointer event that carries a pressure axis.
 * @param {Clutter.Event} event
 * @returns {boolean}
 */
export function eventIsPenDrawDevice(event) {
    return eventIsStylusLike(event);
}

/**
 * For {@link Clutter.Actor.pick}: include the pen canvas when this returns true.
 * When null (pick without a current Clutter event), reject: Mutter often runs pick
 * without {@link Clutter.get_current_event}; treating null as "pen" blocked mouse
 * pass-through. Pen hits the ink surface via the overlay stage `captured-event`
 * handler when pick runs without a current event.
 * @param {Clutter.Event|null} event
 * @returns {boolean}
 */
export function overlayPenCanvasAcceptsPickEvent(event) {
    if (event == null)
        return false;
    try {
        if (isLikelyKeyOrScrollEvent(event))
            return false;
        if (eventIsPenDrawDevice(event))
            return true;
        if (isLikelyPointerEvent(event))
            return false;
        return true;
    } catch {
        return true;
    }
}

/**
 * Accept drawing input from pen/tablet or from a normal mouse pointer.
 * Prefer event-kind checks first so we never call into device APIs for normal mice.
 * @param {Clutter.Event} event
 * @returns {boolean}
 */
export function eventIsDrawInput(event) {
    if (!event)
        return false;
    try {
        if (isLikelyKeyOrScrollEvent(event))
            return false;
        if (isLikelyPointerEvent(event))
            return true;
    } catch {
        /* fall through */
    }
    try {
        if (eventIsStylusLike(event))
            return true;
        const device = inputDeviceFromEvent(event);
        const IDT = Clutter.InputDeviceType;
        if (device && IDT && safeDeviceType(device) === IDT.POINTER)
            return true;
    } catch {
        /* ignore */
    }
    try {
        return looksLikePointerByButton(event);
    } catch {
        return false;
    }
}

/**
 * @param {Clutter.Event} event
 * @returns {boolean}
 */
export function eventHasPressure(event) {
    try {
        return event.has_axis_value?.(Clutter.InputAxis.PRESSURE) ?? false;
    } catch {
        return false;
    }
}

/**
 * @param {Clutter.Event} event
 * @returns {number} 0..1 or 1 if unknown
 */
export function getPressure01(event) {
    try {
        if (!eventHasPressure(event))
            return 1.0;
        let v = event.get_axis_value(Clutter.InputAxis.PRESSURE);
        if (v < 0)
            v = 0;
        else if (v > 1)
            v = 1;
        return v;
    } catch {
        return 1.0;
    }
}

/**
 * @param {Clutter.Event} event
 * @returns {'draw'|'erase'|'none'}
 */
export function stylusModeOnPress(event) {
    try {
        if (!eventIsPenDrawDevice(event))
            return 'none';
        const btn = event.get_button();
        if (btn === Clutter.BUTTON_SECONDARY || btn === Clutter.BUTTON_MIDDLE)
            return 'erase';
        return 'draw';
    } catch {
        return 'none';
    }
}
