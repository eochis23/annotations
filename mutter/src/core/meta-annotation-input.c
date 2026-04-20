/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#include "config.h"

#include "core/meta-annotation-input.h"

#include "clutter/clutter-mutter.h"
#include "clutter/clutter.h"
#include "clutter/clutter-input-device-tool.h"

#include <stdio.h>

/* #region agent log */
#define ANNOTATION_INPUT_LOG_PRIMARY "/home/eochis/Projects/annotations/.cursor/debug-338895.log"
#define ANNOTATION_INPUT_LOG_FALLBACK "/tmp/mutter-debug-338895.ndjson"

static void
annotation_input_agent_log (const char *hypothesis_id,
                            const char *message,
                            int           a,
                            int           b,
                            int           c,
                            int           d)
{
  FILE *f = fopen (ANNOTATION_INPUT_LOG_PRIMARY, "a");

  if (!f)
    f = fopen (ANNOTATION_INPUT_LOG_FALLBACK, "a");
  if (!f)
    return;

  fprintf (f,
           "{\"sessionId\":\"338895\",\"hypothesisId\":\"%s\",\"location\":\"meta-annotation-input.c\","
           "\"message\":\"%s\",\"data\":{\"a\":%d,\"b\":%d,\"c\":%d,\"d\":%d},\"timestamp\":%" G_GINT64_FORMAT "}\n",
           hypothesis_id, message, a, b, c, d,
           (gint64) g_get_monotonic_time ());
  fflush (f);
  fclose (f);
}

/* #endregion */

static gboolean
event_tool_is_drawing_stylus (const ClutterEvent *event)
{
  ClutterInputDeviceTool *tool;
  ClutterInputDeviceToolType ttype;

  tool = clutter_event_get_device_tool (event);
  if (!tool)
    return FALSE;

  ttype = clutter_input_device_tool_get_tool_type (tool);
  switch (ttype)
    {
    case CLUTTER_INPUT_DEVICE_TOOL_PEN:
    case CLUTTER_INPUT_DEVICE_TOOL_ERASER:
    case CLUTTER_INPUT_DEVICE_TOOL_BRUSH:
    case CLUTTER_INPUT_DEVICE_TOOL_PENCIL:
    case CLUTTER_INPUT_DEVICE_TOOL_AIRBRUSH:
      return TRUE;
    default:
      return FALSE;
    }
}

static gboolean
device_name_hints_stylus (ClutterInputDevice *device)
{
  const char *name;
  g_autofree gchar *l = NULL;

  name = clutter_input_device_get_device_name (device);
  if (!name || name[0] == '\0')
    return FALSE;

  l = g_utf8_strdown (name, -1);

  if (strstr (l, "stylus") != NULL ||
      strstr (l, "digitizer") != NULL ||
      strstr (l, "wacom") != NULL ||
      strstr (l, "elan ") != NULL ||
      strstr (l, "elan-") != NULL ||
      strstr (l, "ntrig") != NULL ||
      strstr (l, "tablet") != NULL ||
      strstr (l, "surface pen") != NULL ||
      strstr (l, "ms pen") != NULL)
    return TRUE;

  /* Avoid matching unrelated "pen" substrings (e.g. "compensation"). */
  if (g_str_has_prefix (l, "pen ") || g_str_has_suffix (l, " pen"))
    return TRUE;

  return strstr (l, " pen ") != NULL;
}

gboolean
meta_annotation_event_targets_overlay (const ClutterEvent *event)
{
  ClutterInputDevice *device;
  ClutterInputDeviceType dtype;
  ClutterInputCapabilities caps;
  ClutterEventType type;
  gboolean overlay;

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
  overlay = FALSE;

  switch (dtype)
    {
    case CLUTTER_TOUCHSCREEN_DEVICE:
    case CLUTTER_TABLET_DEVICE:
    case CLUTTER_PEN_DEVICE:
    case CLUTTER_ERASER_DEVICE:
    case CLUTTER_CURSOR_DEVICE:
      overlay = TRUE;
      break;

    case CLUTTER_POINTER_DEVICE:
      if (type == CLUTTER_SCROLL)
        {
          overlay = FALSE;
          break;
        }
      if (caps & CLUTTER_INPUT_CAPABILITY_TABLET_TOOL)
        {
          overlay = TRUE;
          break;
        }
      if (event_tool_is_drawing_stylus (event))
        {
          overlay = TRUE;
          break;
        }
      {
        unsigned int dw, dh;

        if (clutter_input_device_get_dimensions (device, &dw, &dh) && dw > 0 && dh > 0)
          {
            overlay = TRUE;
            break;
          }
      }
      if (device_name_hints_stylus (device))
        {
          overlay = TRUE;
          break;
        }
      /* Do not treat "absolute pointer motion" alone as stylus: some seats emit
       * absolute MOTION for the primary pointer; routing those here returns
       * CLUTTER_EVENT_STOP from the annotation layer and breaks GDM login. */
      break;

    case CLUTTER_TOUCHPAD_DEVICE:
    case CLUTTER_KEYBOARD_DEVICE:
    case CLUTTER_PAD_DEVICE:
    case CLUTTER_EXTENSION_DEVICE:
    case CLUTTER_JOYSTICK_DEVICE:
    case CLUTTER_N_DEVICE_TYPES:
    default:
      overlay = FALSE;
      break;
    }

  /* #region agent log */
  if (dtype == CLUTTER_POINTER_DEVICE && type == CLUTTER_BUTTON_PRESS)
    {
      int tool_t = -1;
      ClutterInputDeviceTool *t = clutter_event_get_device_tool (event);

      if (t)
        tool_t = (int) clutter_input_device_tool_get_tool_type (t);
      annotation_input_agent_log ("H_overlay_route", "pointer_overlay_decision",
                                  (int) type, (int) dtype, tool_t, overlay ? 1 : 0);
    }
  /* #endregion */

  return overlay;
}
