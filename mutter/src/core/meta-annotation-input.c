/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#include "config.h"

#include "core/meta-annotation-input.h"

#include "clutter/clutter-mutter.h"
#include "clutter/clutter.h"

gboolean
meta_annotation_event_targets_overlay (const ClutterEvent *event)
{
  ClutterInputDevice *device;
  ClutterInputDeviceType dtype;
  ClutterInputCapabilities caps;
  ClutterEventType type;

  device = clutter_event_get_source_device (event);
  if (!device)
    return FALSE;

  type = clutter_event_type (event);
  switch (type)
    {
    case CLUTTER_MOTION:
    case CLUTTER_BUTTON_PRESS:
    case CLUTTER_BUTTON_RELEASE:
    case CLUTTER_TOUCH_BEGIN:
    case CLUTTER_TOUCH_UPDATE:
    case CLUTTER_TOUCH_END:
    case CLUTTER_TOUCH_CANCEL:
    case CLUTTER_SCROLL:
      break;
    default:
      return FALSE;
    }

  dtype = clutter_input_device_get_device_type (device);
  caps = clutter_input_device_get_capabilities (device);

  switch (dtype)
    {
    case CLUTTER_TOUCHSCREEN_DEVICE:
    case CLUTTER_TABLET_DEVICE:
    case CLUTTER_PEN_DEVICE:
    case CLUTTER_ERASER_DEVICE:
    case CLUTTER_CURSOR_DEVICE:
      return TRUE;

    case CLUTTER_POINTER_DEVICE:
      if (caps & CLUTTER_INPUT_CAPABILITY_TABLET_TOOL)
        return TRUE;
      return FALSE;

    case CLUTTER_TOUCHPAD_DEVICE:
    case CLUTTER_KEYBOARD_DEVICE:
    case CLUTTER_PAD_DEVICE:
    case CLUTTER_EXTENSION_DEVICE:
    case CLUTTER_JOYSTICK_DEVICE:
    case CLUTTER_N_DEVICE_TYPES:
    default:
      return FALSE;
    }
}
