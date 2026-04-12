/* SPDX-License-Identifier: GPL-2.0-or-later */
import Clutter from 'gi://Clutter';

/**
 * @param {Clutter.Event} event
 * @returns {Clutter.EventType|null}
 */
function clutterEventType(event) {
    if (!event)
        return null;
    try {
        if (typeof event.get_event_type === 'function')
            return event.get_event_type();
    } catch {
        /* ignore */
    }
    try {
        if (typeof event.get_type === 'function')
            return event.get_type();
    } catch {
        /* ignore */
    }
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

/**
 * When device introspection fails, still accept events we explicitly connected on the canvas.
 * @param {Clutter.Event} event
 * @returns {boolean}
 */
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
        const device = inputDeviceFromEvent(event);
        if (!device)
            return false;

        const type = safeDeviceType(device);
        const IDT = Clutter.InputDeviceType;
        if (!IDT)
            return false;
        if (type === IDT.TABLET_TOOL)
            return true;

        if (type === IDT.POINTER) {
            if (eventHasPressure(event))
                return true;
        }

        return false;
    } catch {
        return false;
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
        if (!eventIsDrawInput(event))
            return 'none';
        const btn = event.get_button();
        if (btn === Clutter.BUTTON_SECONDARY || btn === Clutter.BUTTON_MIDDLE)
            return 'erase';
        return 'draw';
    } catch {
        return 'none';
    }
}
