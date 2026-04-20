/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#include "config.h"

#include "compositor/meta-annotation-layer.h"

#include "core/meta-annotation-input.h"
#include "backends/meta-backend-private.h"
#include "clutter/clutter-mutter.h"
#include "clutter/clutter-texture-content.h"
#include "cogl/cogl.h"
#include "meta/meta-backend.h"

#include <cairo.h>
#include <math.h>
#include <stdio.h>

/* #region agent log */
#define ANNOTATION_AGENT_LOG_PRIMARY "/home/eochis/Projects/annotations/.cursor/debug-338895.log"
#define ANNOTATION_AGENT_LOG_FALLBACK "/tmp/mutter-debug-338895.ndjson"

static void
annotation_agent_log (const char *hypothesis_id,
                        const char *location,
                        const char *message,
                        int           a,
                        int           b,
                        int           c,
                        int           d)
{
  FILE *f = fopen (ANNOTATION_AGENT_LOG_PRIMARY, "a");

  if (!f)
    f = fopen (ANNOTATION_AGENT_LOG_FALLBACK, "a");
  if (!f)
    return;

  fprintf (f,
           "{\"sessionId\":\"338895\",\"hypothesisId\":\"%s\",\"location\":\"%s\",\"message\":\"%s\","
           "\"data\":{\"a\":%d,\"b\":%d,\"c\":%d,\"d\":%d},\"timestamp\":%" G_GINT64_FORMAT "}\n",
           hypothesis_id, location, message, a, b, c, d,
           (gint64) g_get_monotonic_time ());
  fflush (f);
  fclose (f);
}

/* #endregion */

struct _MetaAnnotationLayer
{
  MetaBackend *backend;
  ClutterActor *actor;
  cairo_surface_t *surface;
  gboolean active;
  float rgba[4];
  float last_x;
  float last_y;
  gboolean stroke_active;
  gulong width_notify_id;
  gulong height_notify_id;
};

static CoglTexture *
get_cogl_texture (MetaAnnotationLayer *layer)
{
  ClutterContent *c;

  if (!layer->actor)
    return NULL;

  c = clutter_actor_get_content (layer->actor);
  if (!c || !CLUTTER_IS_TEXTURE_CONTENT (c))
    return NULL;

  return clutter_texture_content_get_texture (CLUTTER_TEXTURE_CONTENT (c));
}

static void
sync_texture_from_surface (MetaAnnotationLayer *layer)
{
  int stride;
  guchar *data;

  if (!layer->surface || !get_cogl_texture (layer))
    return;

  /* #region agent log */
  {
    CoglTexture *tex = get_cogl_texture (layer);
    int cw = cairo_image_surface_get_width (layer->surface);
    int ch = cairo_image_surface_get_height (layer->surface);
    int tw = cogl_texture_get_width (tex);
    int th = cogl_texture_get_height (tex);

    annotation_agent_log ("H_texture", "meta-annotation-layer.c:sync",
                          "cairo_vs_cogl", cw, ch, tw, th);
    if (cw != tw || ch != th)
      annotation_agent_log ("H_texture", "meta-annotation-layer.c:sync",
                            "size_mismatch_warn_still_upload", cw, ch, tw, th);
  }
  /* #endregion */

  stride = cairo_image_surface_get_stride (layer->surface);
  data = cairo_image_surface_get_data (layer->surface);

  if (!cogl_texture_set_data (get_cogl_texture (layer),
                              COGL_PIXEL_FORMAT_CAIRO_ARGB32_COMPAT,
                              stride,
                              data,
                              0,
                              NULL))
    g_warning ("meta_annotation_layer: texture upload failed");

  {
    ClutterContent *c = clutter_actor_get_content (layer->actor);

    if (c)
      clutter_content_invalidate (c);
  }
}

static void
clear_surface (MetaAnnotationLayer *layer)
{
  cairo_t *cr;

  if (!layer->surface)
    return;

  cr = cairo_create (layer->surface);
  cairo_set_operator (cr, CAIRO_OPERATOR_CLEAR);
  cairo_paint (cr);
  cairo_destroy (cr);

  cairo_surface_flush (layer->surface);
  sync_texture_from_surface (layer);
}

static void
recreate_buffers (MetaAnnotationLayer *layer,
                  int                  width,
                  int                  height)
{
  CoglContext *ctx;

  if (width < 1 || height < 1)
    return;

  /* Actor is the sole owner of ClutterContent; avoid a second GObject ref in this struct. */
  if (layer->actor)
    clutter_actor_set_content (layer->actor, NULL);
  g_clear_pointer (&layer->surface, cairo_surface_destroy);

  layer->surface = cairo_image_surface_create (CAIRO_FORMAT_ARGB32, width, height);
  {
    cairo_t *cr = cairo_create (layer->surface);

    cairo_set_operator (cr, CAIRO_OPERATOR_CLEAR);
    cairo_paint (cr);
    cairo_destroy (cr);
  }
  cairo_surface_flush (layer->surface);

  ctx = clutter_backend_get_cogl_context (
    meta_backend_get_clutter_backend (layer->backend));
  {
    g_autoptr (CoglTexture) local_tex =
      COGL_TEXTURE (cogl_texture_2d_new_with_size (ctx, width, height));
    g_autoptr (ClutterContent) local_content = NULL;

    cogl_texture_allocate (local_tex, NULL);
    local_content = clutter_texture_content_new_from_texture (local_tex, NULL);
    clutter_actor_set_content (layer->actor, local_content);
  }

  clutter_actor_set_size (layer->actor, width, height);
  sync_texture_from_surface (layer);
}

static void
on_stage_size_changed (ClutterActor         *stage,
                       GParamSpec           *pspec,
                       MetaAnnotationLayer *layer)
{
  float width_f, height_f;
  int width, height;

  clutter_actor_get_size (stage, &width_f, &height_f);
  width = (int) ceilf (width_f);
  height = (int) ceilf (height_f);

  /* #region agent log */
  annotation_agent_log ("H_reentrancy", "meta-annotation-layer.c:on_stage_size_changed",
                        "stage_wh", width, height, 0, 0);
  /* #endregion */

  recreate_buffers (layer, width, height);
  layer->stroke_active = FALSE;
}

MetaAnnotationLayer *
meta_annotation_layer_new (MetaBackend *backend)
{
  MetaAnnotationLayer *layer;
  ClutterActor *stage = meta_backend_get_stage (backend);

  layer = g_new0 (MetaAnnotationLayer, 1);
  layer->backend = g_object_ref (backend);
  /* Inactive until the shell extension calls SetActive(true) over D-Bus. */
  layer->active = FALSE;
  layer->rgba[0] = 1.0f;
  layer->rgba[1] = 0.2f;
  layer->rgba[2] = 0.2f;
  layer->rgba[3] = 1.0f;

  layer->actor = clutter_actor_new ();
  clutter_actor_set_name (layer->actor, "annotation-layer");
  clutter_actor_set_reactive (layer->actor, FALSE);
  clutter_actor_set_opacity (layer->actor, 255);

  layer->width_notify_id =
    g_signal_connect_object (stage, "notify::width",
                             G_CALLBACK (on_stage_size_changed),
                             layer, G_CONNECT_DEFAULT);
  layer->height_notify_id =
    g_signal_connect_object (stage, "notify::height",
                             G_CALLBACK (on_stage_size_changed),
                             layer, G_CONNECT_DEFAULT);

  on_stage_size_changed (stage, NULL, layer);
  clutter_actor_hide (layer->actor);
  /* Parented by gnome-shell above uiGroup so drawing stays over shell chrome. */

  meta_annotation_input_set_non_mouse_pointer_isolated (FALSE);

  return layer;
}

void
meta_annotation_layer_destroy (MetaAnnotationLayer *layer)
{
  ClutterActor *stage;

  if (!layer)
    return;

  meta_annotation_input_set_non_mouse_pointer_isolated (FALSE);

  /* #region agent log */
  annotation_agent_log ("H_destroy", "meta-annotation-layer.c:destroy",
                        "enter", layer->actor ? 1 : 0,
                        layer->surface ? 1 : 0, 0, 0);
  /* #endregion */

  stage = meta_backend_get_stage (layer->backend);

  g_clear_signal_handler (&layer->width_notify_id, stage);
  g_clear_signal_handler (&layer->height_notify_id, stage);

  g_clear_pointer (&layer->surface, cairo_surface_destroy);
  g_clear_pointer (&layer->actor, clutter_actor_destroy);
  g_clear_object (&layer->backend);

  g_free (layer);
}

ClutterActor *
meta_annotation_layer_get_actor (MetaAnnotationLayer *layer)
{
  g_return_val_if_fail (layer != NULL, NULL);
  return layer->actor;
}

void
meta_annotation_layer_clear (MetaAnnotationLayer *layer)
{
  g_return_if_fail (layer != NULL);
  clear_surface (layer);
  layer->stroke_active = FALSE;
}

void
meta_annotation_layer_set_active (MetaAnnotationLayer *layer,
                                   gboolean            active)
{
  g_return_if_fail (layer != NULL);
  layer->active = active;
  meta_annotation_input_set_non_mouse_pointer_isolated (active);
  if (layer->actor)
    {
      if (active)
        clutter_actor_show (layer->actor);
      else
        clutter_actor_hide (layer->actor);
    }
}

gboolean
meta_annotation_layer_get_active (MetaAnnotationLayer *layer)
{
  g_return_val_if_fail (layer != NULL, FALSE);
  return layer->active;
}

void
meta_annotation_layer_set_color (MetaAnnotationLayer *layer,
                                  double               r,
                                  double               g,
                                  double               b,
                                  double               a)
{
  g_return_if_fail (layer != NULL);
  layer->rgba[0] = (float) r;
  layer->rgba[1] = (float) g;
  layer->rgba[2] = (float) b;
  layer->rgba[3] = (float) a;
}

static void
draw_segment (MetaAnnotationLayer *layer,
              float                  x1,
              float                  y1,
              float                  x2,
              float                  y2)
{
  cairo_t *cr;

  if (!layer->surface)
    return;

  /* #region agent log */
  annotation_agent_log ("H_coords", "meta-annotation-layer.c:draw_segment",
                        "line",
                        (int) floorf (x1), (int) floorf (y1),
                        (int) floorf (x2), (int) floorf (y2));
  /* #endregion */

  cr = cairo_create (layer->surface);
  cairo_set_source_rgba (cr,
                         layer->rgba[0], layer->rgba[1],
                         layer->rgba[2], layer->rgba[3]);
  cairo_set_line_width (cr, 4.0);
  cairo_set_line_cap (cr, CAIRO_LINE_CAP_ROUND);
  cairo_set_line_join (cr, CAIRO_LINE_JOIN_ROUND);
  cairo_move_to (cr, x1, y1);
  cairo_line_to (cr, x2, y2);
  cairo_stroke (cr);
  cairo_destroy (cr);

  cairo_surface_flush (layer->surface);
  sync_texture_from_surface (layer);
}

static gboolean pointer_has_draw_button (const ClutterEvent *event);

static gboolean
pointer_has_draw_button (const ClutterEvent *event)
{
  ClutterModifierType state = clutter_event_get_state (event);

  return (state & CLUTTER_BUTTON1_MASK) != 0;
}

gboolean
meta_annotation_layer_handle_event (MetaAnnotationLayer *layer,
                                    const ClutterEvent  *event)
{
  ClutterEventType type;
  graphene_point_t pos;

  g_return_val_if_fail (layer != NULL, FALSE);
  g_return_val_if_fail (event != NULL, FALSE);

  if (!layer->active || !layer->surface)
    return FALSE;

  type = clutter_event_type (event);

  /* #region agent log */
  {
    ClutterInputDevice *dev = clutter_event_get_source_device (event);
    int dtype = dev ? (int) clutter_input_device_get_device_type (dev) : -1;

    annotation_agent_log ("H_pen_path", "meta-annotation-layer.c:handle_event",
                          "entry", (int) type, dtype,
                          layer->stroke_active ? 1 : 0,
                          pointer_has_draw_button (event) ? 1 : 0);
  }
  /* #endregion */

  switch (type)
    {
    case CLUTTER_BUTTON_PRESS:
      if (clutter_event_get_button (event) != CLUTTER_BUTTON_PRIMARY)
        return TRUE;
      clutter_event_get_coords (event, &pos.x, &pos.y);
      layer->last_x = pos.x;
      layer->last_y = pos.y;
      layer->stroke_active = TRUE;
      return TRUE;

    case CLUTTER_MOTION:
      if (!layer->stroke_active && !pointer_has_draw_button (event))
        return TRUE;
      clutter_event_get_coords (event, &pos.x, &pos.y);
      if (layer->stroke_active || pointer_has_draw_button (event))
        {
          draw_segment (layer, layer->last_x, layer->last_y, pos.x, pos.y);
          layer->last_x = pos.x;
          layer->last_y = pos.y;
          layer->stroke_active = pointer_has_draw_button (event);
        }
      return TRUE;

    case CLUTTER_BUTTON_RELEASE:
      if (layer->stroke_active)
        {
          clutter_event_get_coords (event, &pos.x, &pos.y);
          draw_segment (layer, layer->last_x, layer->last_y, pos.x, pos.y);
        }
      layer->stroke_active = FALSE;
      return TRUE;

    case CLUTTER_TOUCH_BEGIN:
      clutter_event_get_coords (event, &pos.x, &pos.y);
      layer->last_x = pos.x;
      layer->last_y = pos.y;
      layer->stroke_active = TRUE;
      return TRUE;

    case CLUTTER_TOUCH_UPDATE:
      clutter_event_get_coords (event, &pos.x, &pos.y);
      if (layer->stroke_active)
        {
          draw_segment (layer, layer->last_x, layer->last_y, pos.x, pos.y);
          layer->last_x = pos.x;
          layer->last_y = pos.y;
        }
      return TRUE;

    case CLUTTER_TOUCH_END:
    case CLUTTER_TOUCH_CANCEL:
      layer->stroke_active = FALSE;
      return TRUE;

    default:
      return FALSE;
    }
}
