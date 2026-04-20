/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#include "config.h"

#include "core/meta-annotation-input.h"

#include "clutter/clutter-mutter.h"
#include "clutter/clutter.h"
#include "clutter/clutter-input-device-tool.h"

#include <stdio.h>

/* When the annotation layer is active, non-mouse pointer-class devices should
 * not move the compositor master pointer (see meta_seat_impl update_device_coords).
 * Written from the main thread; read from the input thread (atomic). */
static volatile gint annotation_non_mouse_isolated = 0;

/* Integrated pens often appear as a tablet device plus a separate POINTER node
 * in the same libinput device group; the latter mirrors hover without pressure
 * and bypasses name heuristics. Track recent tablet-family motion by group. */
static GMutex        annotation_tablet_group_mutex;
static gboolean      annotation_tablet_group_valid;
static gint64        annotation_tablet_group_id;
static gboolean      annotation_tablet_xy_valid;
static gfloat        annotation_last_tablet_x;
static gfloat        annotation_last_tablet_y;
static gint64        annotation_tablet_monotonic_us;

#define ANNOTATION_TABLET_GROUP_COALESCE_USEC (200 * G_TIME_SPAN_MILLISECOND)
#define ANNOTATION_TABLET_PROXIMITY_TIME_USEC  (400 * G_TIME_SPAN_MILLISECOND)
#define ANNOTATION_TABLET_PROXIMITY_DIST2      (200.0f * 200.0f)
#define ANNOTATION_UNKNOWN_LIBINPUT_GROUP       ((gint64) -1)

/* #region agent log */
void
meta_annotation_debug_append_ndjson (const gchar *hypothesis_id,
                                     const gchar *location,
                                     const gchar *message,
                                     gint          a,
                                     gint          b,
                                     gint          c,
                                     gint          d)
{
  g_autofree gchar *cache_path = NULL;
  const gchar *pathv[4];
  guint n;
  guint i;

  cache_path = g_build_filename (g_get_user_cache_dir (),
                                 "mutter-annotation-338895.ndjson",
                                 NULL);
  pathv[0] = "/home/eochis/Projects/annotations/.cursor/debug-338895.log";
  pathv[1] = "/tmp/mutter-debug-338895.ndjson";
  pathv[2] = cache_path;
  pathv[3] = NULL;
  n = 3;

  for (i = 0; i < n; i++)
    {
      FILE *f = fopen (pathv[i], "a");

      if (!f)
        continue;

      fprintf (f,
               "{\"sessionId\":\"338895\",\"hypothesisId\":\"%s\",\"location\":\"%s\",\"message\":\"%s\","
               "\"data\":{\"a\":%d,\"b\":%d,\"c\":%d,\"d\":%d},\"timestamp\":%" G_GINT64_FORMAT "}\n",
               hypothesis_id, location, message, a, b, c, d,
               (gint64) g_get_monotonic_time ());
      fflush (f);
      fclose (f);
    }
}

static void
annotation_input_agent_log (const char *hypothesis_id,
                            const char *message,
                            int           a,
                            int           b,
                            int           c,
                            int           d)
{
  meta_annotation_debug_append_ndjson (hypothesis_id,
                                         "meta-annotation-input.c",
                                         message, a, b, c, d);
}

/* #endregion */

void
meta_annotation_input_set_non_mouse_pointer_isolated (gboolean isolated)
{
  g_atomic_int_set (&annotation_non_mouse_isolated, isolated ? 1 : 0);
  if (!isolated)
    {
      g_mutex_lock (&annotation_tablet_group_mutex);
      annotation_tablet_group_valid = FALSE;
      annotation_tablet_xy_valid = FALSE;
      g_mutex_unlock (&annotation_tablet_group_mutex);
    }
}

void
meta_annotation_input_note_tablet_family_motion (gint64 libinput_device_group,
                                                 float  x,
                                                 float  y)
{
  if (!g_atomic_int_get (&annotation_non_mouse_isolated))
    return;

  g_mutex_lock (&annotation_tablet_group_mutex);
  annotation_tablet_xy_valid = TRUE;
  annotation_last_tablet_x = x;
  annotation_last_tablet_y = y;
  annotation_tablet_monotonic_us = g_get_monotonic_time ();
  if (libinput_device_group != ANNOTATION_UNKNOWN_LIBINPUT_GROUP)
    {
      annotation_tablet_group_valid = TRUE;
      annotation_tablet_group_id = libinput_device_group;
    }
  g_mutex_unlock (&annotation_tablet_group_mutex);
}

static gboolean
tool_is_drawing_stylus (ClutterInputDeviceTool *tool)
{
  ClutterInputDeviceToolType ttype;

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
      strstr (l, "elan") != NULL ||
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

/* True for POINTER devices that should use the annotation overlay instead of
 * behaving as the core mouse (same rules for routing and pointer isolation). */
static gboolean
pointer_device_matches_annotation_pointer (ClutterInputDevice     *device,
                                           ClutterInputDeviceTool *tool,
                                           const ClutterEvent     *event,
                                           const double            *motion_axes)
{
  ClutterInputCapabilities caps;
  unsigned int dw, dh;
  gdouble *axes;
  guint n_axes;

  caps = clutter_input_device_get_capabilities (device);
  if (caps & CLUTTER_INPUT_CAPABILITY_TABLET_TOOL)
    return TRUE;
  if (tool_is_drawing_stylus (tool))
    return TRUE;
  if (clutter_input_device_get_dimensions (device, &dw, &dh) && dw > 0 && dh > 0)
    return TRUE;
  if (device_name_hints_stylus (device))
    return TRUE;

  /* Integrated pens often report as POINTER with pressure on motion only.
   * Seat impl passes motion_axes (no ClutterEvent yet). */
  if ((caps & CLUTTER_INPUT_CAPABILITY_TOUCHPAD) == 0)
    {
      if (event &&
          clutter_event_type (event) == CLUTTER_MOTION)
        {
          axes = clutter_event_get_axes (event, &n_axes);
          if (axes != NULL &&
              (int) CLUTTER_INPUT_AXIS_PRESSURE < (int) n_axes &&
              axes[CLUTTER_INPUT_AXIS_PRESSURE] > 0.0)
            return TRUE;
        }
      else if (motion_axes &&
               motion_axes[CLUTTER_INPUT_AXIS_PRESSURE] > 0.0)
        return TRUE;
    }

  return FALSE;
}

gboolean
meta_annotation_input_skip_master_pointer_update (ClutterInputDevice     *device,
                                                  ClutterInputDeviceTool *tool,
                                                  const double            *motion_axes,
                                                  gint64                  libinput_device_group,
                                                  float                   pointer_pos_x,
                                                  float                   pointer_pos_y)
{
  if (!g_atomic_int_get (&annotation_non_mouse_isolated))
    return FALSE;
  if (!device)
    return FALSE;

  if (clutter_input_device_get_device_type (device) == CLUTTER_POINTER_DEVICE &&
      libinput_device_group != ANNOTATION_UNKNOWN_LIBINPUT_GROUP)
    {
      gboolean same_group = FALSE;
      gint64 age = 0;

      g_mutex_lock (&annotation_tablet_group_mutex);
      if (annotation_tablet_group_valid &&
          annotation_tablet_group_id == libinput_device_group)
        {
          gint64 now = g_get_monotonic_time ();

          age = now - annotation_tablet_monotonic_us;
          if (age >= 0 && age < ANNOTATION_TABLET_GROUP_COALESCE_USEC)
            same_group = TRUE;
        }
      g_mutex_unlock (&annotation_tablet_group_mutex);

      if (same_group)
        {
          /* #region agent log */
          annotation_input_agent_log ("H_group_ptr", "skip_master_tablet_group",
                                      (int) (libinput_device_group & G_MAXINT),
                                      (int) (age > G_MAXINT ? G_MAXINT : age),
                                      1, 0);
          /* #endregion */
          return TRUE;
        }
    }

  /* Some machines expose pen as TABLET and a separate POINTER “mouse” that is
   * not in the same libinput device group; positions still track in screen space. */
  if (clutter_input_device_get_device_type (device) == CLUTTER_POINTER_DEVICE &&
      (clutter_input_device_get_capabilities (device) & CLUTTER_INPUT_CAPABILITY_TOUCHPAD) == 0)
    {
      gboolean near_tablet = FALSE;
      gint64 age = 0;
      gfloat dx, dy, d2;

      g_mutex_lock (&annotation_tablet_group_mutex);
      if (annotation_tablet_xy_valid)
        {
          gint64 now = g_get_monotonic_time ();

          age = now - annotation_tablet_monotonic_us;
          if (age >= 0 && age < ANNOTATION_TABLET_PROXIMITY_TIME_USEC)
            {
              dx = pointer_pos_x - annotation_last_tablet_x;
              dy = pointer_pos_y - annotation_last_tablet_y;
              d2 = dx * dx + dy * dy;
              if (d2 <= ANNOTATION_TABLET_PROXIMITY_DIST2)
                near_tablet = TRUE;
            }
        }
      g_mutex_unlock (&annotation_tablet_group_mutex);

      if (near_tablet)
        {
          /* #region agent log */
          annotation_input_agent_log ("H_prox_ptr", "skip_master_near_tablet",
                                      (int) (dx > 0 ? dx + 0.5f : dx - 0.5f),
                                      (int) (dy > 0 ? dy + 0.5f : dy - 0.5f),
                                      (int) (age > G_MAXINT ? G_MAXINT : age),
                                      1);
          /* #endregion */
          return TRUE;
        }
    }

  if (clutter_input_device_get_device_type (device) != CLUTTER_POINTER_DEVICE)
    return FALSE;

  return pointer_device_matches_annotation_pointer (device, tool, NULL, motion_axes);
}

gboolean
meta_annotation_input_skip_pointer_motion_coalesced (ClutterInputDevice     *device,
                                                      ClutterInputDeviceTool *tool,
                                                      const double            *motion_axes,
                                                      gint64                  libinput_device_group,
                                                      float                   pointer_pos_x,
                                                      float                   pointer_pos_y)
{
  if (meta_annotation_input_skip_master_pointer_update (device, tool, motion_axes,
                                                        libinput_device_group,
                                                        pointer_pos_x,
                                                        pointer_pos_y))
    return TRUE;
  if (!g_atomic_int_get (&annotation_non_mouse_isolated))
    return FALSE;

  /* Tablet-class devices never update priv->pointer_state, but they still
   * emitted POINTER_POSITION_CHANGED_IN_IMPL when freeze was always FALSE,
   * so the core pointer followed the pen. Freeze while annotations isolate
   * non-mouse overlay input. */
  if (device)
    {
      ClutterInputDeviceType t = clutter_input_device_get_device_type (device);

      if (t == CLUTTER_TABLET_DEVICE ||
          t == CLUTTER_PEN_DEVICE ||
          t == CLUTTER_ERASER_DEVICE ||
          t == CLUTTER_CURSOR_DEVICE)
        {
          /* #region agent log */
          {
            static guint tablet_freeze_log_counter = 0;

            if ((++tablet_freeze_log_counter % 25) == 1)
              annotation_input_agent_log ("H_tablet_freeze", "skip_motion_coalesced_tablet_class",
                                          (int) t, 1, 0, 0);
          }
          /* #endregion */
          return TRUE;
        }
    }

  if (!device || clutter_input_device_get_device_type (device) != CLUTTER_POINTER_DEVICE)
    return FALSE;
  if (clutter_input_device_get_capabilities (device) & CLUTTER_INPUT_CAPABILITY_TOUCHPAD)
    return FALSE;
  if (!motion_axes)
    return FALSE;

  return motion_axes[CLUTTER_INPUT_AXIS_PRESSURE] > 0.0;
}

gboolean
meta_annotation_event_targets_overlay (const ClutterEvent *event)
{
  ClutterInputDevice *device;
  ClutterInputDeviceType dtype;
  ClutterEventType type;
  gboolean overlay;

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

  /* Touch events may use the stage virtual pointer as source_device (see
   * clutter_event_touch_new); classify by event type, not device type. */
  if (type == CLUTTER_TOUCH_BEGIN ||
      type == CLUTTER_TOUCH_UPDATE ||
      type == CLUTTER_TOUCH_END ||
      type == CLUTTER_TOUCH_CANCEL)
    return TRUE;

  device = clutter_event_get_source_device (event);
  if (!device)
    return FALSE;

  dtype = clutter_input_device_get_device_type (device);
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
        overlay = FALSE;
      else
        overlay = pointer_device_matches_annotation_pointer (
          device, clutter_event_get_device_tool (event), event, NULL);
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

gboolean
meta_annotation_input_event_should_skip_wayland_seat_sync (const ClutterEvent *event)
{
  if (!g_atomic_int_get (&annotation_non_mouse_isolated))
    return FALSE;

  return meta_annotation_event_targets_overlay (event);
}
