/* SPDX-License-Identifier: GPL-2.0-or-later */
import Clutter from 'gi://Clutter';

/**
 * @param {Clutter.Event} event
 * @returns {boolean}
 */
export function eventIsStylusLike(event) {
    const device = event.get_device();
    if (!device)
        return false;

    const type = device.get_device_type();
    if (type === Clutter.InputDeviceType.TABLET_TOOL)
        return true;

    /* Some stacks route the stylus as a core pointer with a pressure axis. */
    if (type === Clutter.InputDeviceType.POINTER) {
        if (eventHasPressure(event) && getPressure01(event) > 0.001)
            return true;
    }

    return false;
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
    if (!eventIsStylusLike(event))
        return 'none';
    const btn = event.get_button();
    if (btn === Clutter.BUTTON_SECONDARY || btn === Clutter.BUTTON_MIDDLE)
        return 'erase';
    /* Primary or 0 (first contact on some drivers). */
    return 'draw';
}
