/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#include "config.h"

#include "compositor/meta-annotation-layer.h"

#include "core/meta-annotation-input.h"
#include "backends/meta-backend-private.h"
#include "clutter/clutter-mutter.h"
#include "clutter/clutter-texture-content.h"
#include "cogl/cogl.h"
#include "meta/meta-backend.h"
#include "meta/display.h"
#include "meta/window.h"
#include "meta/meta-workspace-manager.h"
#include "meta/workspace.h"
#include "mtk/mtk.h"

#include <cairo.h>
#include <glib.h>
#include <math.h>

/* Drawing constants for pressure-sensitive ink. */
#define ANNOT_BASE_WIDTH   6.0f
#define ANNOT_MIN_PRESSURE 0.1f

typedef struct _ChromeRegion
{
  char *id;
  graphene_rect_t rect;
} ChromeRegion;

typedef struct _WindowInk
{
  MetaWindow *window;
  cairo_surface_t *surface;
  int width, height;
  gulong pos_id, size_id, min_id, ws_id, unm_id;
  MetaAnnotationLayer *layer;
} WindowInk;

struct _MetaAnnotationLayer
{
  MetaBackend *backend;
  MetaDisplay *display;  /* weak; compositor tears us down before display */
  ClutterActor *actor;

  /* Stage-sized surface that mirrors into the actor's CoglTexture. Rebuilt
   * from unattached_surface + per-window surfaces by recompose(). Kept
   * named `surface` so sync_texture_from_surface stays a one-liner. */
  cairo_surface_t *surface;
  /* Stage-sized surface that catches strokes started over the desktop. */
  cairo_surface_t *unattached_surface;
  int stage_width, stage_height;

  /* MetaWindow* -> WindowInk*. Values owned; freed via hash table dtor. */
  GHashTable *per_window;

  gboolean active;
  gboolean paused;
  float rgba[4];

  /* Stroke state. stroke_anchor is a weak pointer so that if the
   * anchor window is finalized out from under us (e.g. between a
   * portal-style async hop in a future refactor) we see NULL rather
   * than a dangling pointer. on_window_unmanaged still runs first in
   * practice and nulls it explicitly; the weak pointer is belt and
   * braces. NULL also means "targeting unattached_surface". */
  MetaWindow *stroke_anchor;
  float stroke_last_x, stroke_last_y;   /* in target-surface local coords */
  gboolean stroke_active;
  float last_pressure;          /* last known tablet pressure, [0, 1] */

  /* Connection ids */
  gulong width_notify_id;
  gulong height_notify_id;
  gulong restacked_id;
  gulong active_ws_id;

  /* Coalesced recompose */
  guint recompose_idle_id;
  /* Set when a recompose was skipped because the actor isn't visible.
   * Cleared after the next recompose actually runs. */
  gboolean recompose_dirty;

  /* Chrome regions (unchanged from pre-window-attached code path). */
  GArray *chrome_regions;
  char *chrome_press_id;
};

static void schedule_recompose (MetaAnnotationLayer *layer);
static void sync_texture_from_surface (MetaAnnotationLayer *layer);
static void recompose (MetaAnnotationLayer *layer);

static void
set_stroke_anchor (MetaAnnotationLayer *layer, MetaWindow *anchor)
{
  if (layer->stroke_anchor == anchor)
    return;

  if (layer->stroke_anchor)
    g_object_remove_weak_pointer (G_OBJECT (layer->stroke_anchor),
                                  (gpointer *) &layer->stroke_anchor);
  layer->stroke_anchor = anchor;
  if (layer->stroke_anchor)
    g_object_add_weak_pointer (G_OBJECT (layer->stroke_anchor),
                               (gpointer *) &layer->stroke_anchor);
}

/* --------------- Chrome regions --------------- */

static void
chrome_region_clear (gpointer data)
{
  ChromeRegion *r = data;
  g_clear_pointer (&r->id, g_free);
}

static GArray *
ensure_chrome_regions (MetaAnnotationLayer *layer)
{
  if (!layer->chrome_regions)
    {
      layer->chrome_regions = g_array_new (FALSE, FALSE, sizeof (ChromeRegion));
      g_array_set_clear_func (layer->chrome_regions, chrome_region_clear);
    }
  return layer->chrome_regions;
}

/* --------------- Texture upload --------------- */

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
  CoglTexture *tex;

  if (!layer->surface)
    return;

  tex = get_cogl_texture (layer);
  if (!tex || !COGL_IS_TEXTURE (tex))
    return;

  /* Re-entrancy (e.g. stage notify -> recreate_buffers) can replace actor
   * content and free the CoglTexture between calls; keep a ref for the
   * whole upload. */
  g_object_ref (tex);

  stride = cairo_image_surface_get_stride (layer->surface);
  data = cairo_image_surface_get_data (layer->surface);

  if (!cogl_texture_set_data (tex,
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
    if (layer->actor)
      clutter_actor_queue_redraw (layer->actor);
  }

  g_object_unref (tex);
}

/* --------------- Surface helpers --------------- */

static cairo_surface_t *
cairo_surface_new_cleared (int width, int height)
{
  cairo_surface_t *s;
  cairo_t *cr;

  s = cairo_image_surface_create (CAIRO_FORMAT_ARGB32, width, height);
  cr = cairo_create (s);
  cairo_set_operator (cr, CAIRO_OPERATOR_CLEAR);
  cairo_paint (cr);
  cairo_destroy (cr);
  cairo_surface_flush (s);
  return s;
}

static void
surface_clear (cairo_surface_t *s)
{
  cairo_t *cr;

  if (!s)
    return;

  cr = cairo_create (s);
  cairo_set_operator (cr, CAIRO_OPERATOR_CLEAR);
  cairo_paint (cr);
  cairo_destroy (cr);
  cairo_surface_flush (s);
}

static void
recreate_buffers (MetaAnnotationLayer *layer,
                  int                  width,
                  int                  height)
{
  CoglContext *ctx;

  if (width < 1 || height < 1)
    return;

  /* Actor is the sole owner of ClutterContent. */
  if (layer->actor)
    clutter_actor_set_content (layer->actor, NULL);
  g_clear_pointer (&layer->surface, cairo_surface_destroy);
  g_clear_pointer (&layer->unattached_surface, cairo_surface_destroy);

  layer->surface = cairo_surface_new_cleared (width, height);
  layer->unattached_surface = cairo_surface_new_cleared (width, height);
  layer->stage_width = width;
  layer->stage_height = height;

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
  schedule_recompose (layer);
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

  recreate_buffers (layer, width, height);
  layer->stroke_active = FALSE;
  set_stroke_anchor (layer, NULL);
}

/* --------------- Anchor / windows --------------- */

static gboolean
window_is_eligible_anchor (MetaWindow *win, MetaWorkspace *active_ws)
{
  MetaWindowType type;

  if (!win)
    return FALSE;
  if (meta_window_is_override_redirect (win))
    return FALSE;
  if (meta_window_is_hidden (win))
    return FALSE;

  type = meta_window_get_window_type (win);
  if (type == META_WINDOW_DESKTOP || type == META_WINDOW_DOCK)
    return FALSE;

  if (!meta_window_is_on_all_workspaces (win) &&
      active_ws &&
      !meta_window_located_on_workspace (win, active_ws))
    return FALSE;

  return TRUE;
}

static MetaWorkspace *
get_active_workspace (MetaAnnotationLayer *layer)
{
  MetaWorkspaceManager *wm;

  if (!layer->display)
    return NULL;

  wm = meta_display_get_workspace_manager (layer->display);
  if (!wm)
    return NULL;

  return meta_workspace_manager_get_active_workspace (wm);
}

static MetaWindow *
pick_anchor_window (MetaAnnotationLayer *layer, float x, float y)
{
  g_autoptr (GSList) all = NULL;
  g_autoptr (GSList) sorted = NULL;
  GSList *l;
  MetaWindow *hit = NULL;
  MetaWorkspace *active_ws;

  if (!layer->display)
    return NULL;

  {
    GList *glist = meta_display_list_all_windows (layer->display);
    for (GList *gl = glist; gl; gl = gl->next)
      all = g_slist_prepend (all, gl->data);
    g_list_free (glist);
  }

  sorted = meta_display_sort_windows_by_stacking (layer->display, all);
  active_ws = get_active_workspace (layer);

  /* sorted is bottom-to-top; walk in reverse for topmost hit. */
  sorted = g_slist_reverse (sorted);
  for (l = sorted; l; l = l->next)
    {
      MetaWindow *win = l->data;
      MtkRectangle fr;

      if (!window_is_eligible_anchor (win, active_ws))
        continue;

      meta_window_get_frame_rect (win, &fr);
      if (mtk_rectangle_contains_pointf (&fr, x, y))
        {
          hit = win;
          break;
        }
    }

  return hit;
}

/* --------------- Window ink --------------- */

static void on_window_position_changed  (MetaWindow *win, gpointer data);
static void on_window_size_changed      (MetaWindow *win, gpointer data);
static void on_window_min_notify        (MetaWindow *win, GParamSpec *pspec, gpointer data);
static void on_window_workspace_changed (MetaWindow *win, gpointer data);
static void on_window_unmanaged         (MetaWindow *win, gpointer data);

static void
window_ink_free (gpointer data)
{
  WindowInk *ink = data;

  if (!ink)
    return;

  /* Relies on the Mutter invariant that MetaWindow::unmanaged fires
   * before the window is finalized. on_window_unmanaged removes us
   * from per_window (which frees `ink` via this function), so if we
   * reach here from any other path the window reference below must
   * still be alive. If a future refactor dispatches unmanaged inside
   * dispose or skips it entirely for some window death path, this
   * path would touch a dangling pointer and must be switched to use
   * g_signal_handlers_disconnect_by_data + a weak pointer on
   * ink->window instead. */
  if (ink->window)
    {
      g_clear_signal_handler (&ink->pos_id, ink->window);
      g_clear_signal_handler (&ink->size_id, ink->window);
      g_clear_signal_handler (&ink->min_id, ink->window);
      g_clear_signal_handler (&ink->ws_id, ink->window);
      g_clear_signal_handler (&ink->unm_id, ink->window);
      ink->window = NULL;
    }
  g_clear_pointer (&ink->surface, cairo_surface_destroy);
  g_free (ink);
}

static WindowInk *
ensure_window_ink (MetaAnnotationLayer *layer, MetaWindow *win)
{
  WindowInk *ink;
  MtkRectangle fr;

  ink = g_hash_table_lookup (layer->per_window, win);
  if (ink)
    return ink;

  meta_window_get_frame_rect (win, &fr);
  if (fr.width < 1 || fr.height < 1)
    return NULL;

  ink = g_new0 (WindowInk, 1);
  ink->window = win;
  ink->layer = layer;
  ink->width = fr.width;
  ink->height = fr.height;
  ink->surface = cairo_surface_new_cleared (fr.width, fr.height);

  ink->pos_id  = g_signal_connect (win, "position-changed",
                                   G_CALLBACK (on_window_position_changed), ink);
  ink->size_id = g_signal_connect (win, "size-changed",
                                   G_CALLBACK (on_window_size_changed), ink);
  ink->min_id  = g_signal_connect (win, "notify::minimized",
                                   G_CALLBACK (on_window_min_notify), ink);
  ink->ws_id   = g_signal_connect (win, "workspace-changed",
                                   G_CALLBACK (on_window_workspace_changed), ink);
  ink->unm_id  = g_signal_connect (win, "unmanaged",
                                   G_CALLBACK (on_window_unmanaged), ink);

  g_hash_table_insert (layer->per_window, win, ink);
  return ink;
}

static void
window_ink_resize_to_frame (WindowInk *ink)
{
  MtkRectangle fr;
  cairo_surface_t *new_s;
  cairo_t *cr;

  if (!ink || !ink->window)
    return;

  meta_window_get_frame_rect (ink->window, &fr);
  if (fr.width < 1 || fr.height < 1)
    return;

  if (ink->surface && ink->width == fr.width && ink->height == fr.height)
    return;

  new_s = cairo_surface_new_cleared (fr.width, fr.height);

  if (ink->surface)
    {
      /* Preserve existing ink at (0,0). Shrinks clip, grows show transparent. */
      cr = cairo_create (new_s);
      cairo_set_operator (cr, CAIRO_OPERATOR_SOURCE);
      cairo_set_source_surface (cr, ink->surface, 0, 0);
      cairo_paint (cr);
      cairo_destroy (cr);
      cairo_surface_destroy (ink->surface);
    }

  ink->surface = new_s;
  ink->width = fr.width;
  ink->height = fr.height;
  cairo_surface_flush (ink->surface);
}

static void
on_window_position_changed (MetaWindow *win, gpointer data)
{
  WindowInk *ink = data;
  (void) win;
  schedule_recompose (ink->layer);
}

static void
on_window_size_changed (MetaWindow *win, gpointer data)
{
  WindowInk *ink = data;
  (void) win;
  window_ink_resize_to_frame (ink);
  schedule_recompose (ink->layer);
}

static void
on_window_min_notify (MetaWindow *win, GParamSpec *pspec, gpointer data)
{
  WindowInk *ink = data;
  (void) win; (void) pspec;
  schedule_recompose (ink->layer);
}

static void
on_window_workspace_changed (MetaWindow *win, gpointer data)
{
  WindowInk *ink = data;
  (void) win;
  schedule_recompose (ink->layer);
}

static void
on_window_unmanaged (MetaWindow *win, gpointer data)
{
  WindowInk *ink = data;
  MetaAnnotationLayer *layer = ink->layer;

  if (layer->stroke_anchor == win)
    {
      set_stroke_anchor (layer, NULL);
      layer->stroke_active = FALSE;
    }

  /* Freeing `ink` via hash_table_remove also disconnects this handler;
   * GLib allows disconnecting from within the running callback. */
  g_hash_table_remove (layer->per_window, win);
  schedule_recompose (layer);
}

/* --------------- Global signal handlers --------------- */

static void
on_display_restacked (MetaDisplay *display, gpointer data)
{
  (void) display;
  schedule_recompose ((MetaAnnotationLayer *) data);
}

static void
on_active_workspace_changed (MetaWorkspaceManager *wm, gpointer data)
{
  (void) wm;
  schedule_recompose ((MetaAnnotationLayer *) data);
}

/* --------------- Recompose --------------- */

static gboolean
recompose_idle_cb (gpointer data)
{
  MetaAnnotationLayer *layer = data;

  layer->recompose_idle_id = 0;
  recompose (layer);
  return G_SOURCE_REMOVE;
}

static void
schedule_recompose (MetaAnnotationLayer *layer)
{
  if (!layer || !layer->surface)
    return;
  /* No point uploading a fresh composite if the actor is hidden. Just
   * remember that we owe a recompose and perform it on next show. */
  if (!layer->active || layer->paused)
    {
      layer->recompose_dirty = TRUE;
      return;
    }
  if (layer->recompose_idle_id != 0)
    return;
  layer->recompose_idle_id = g_idle_add (recompose_idle_cb, layer);
}

static gboolean
window_is_visible_for_ink (MetaWindow *win, MetaWorkspace *active_ws)
{
  gboolean minimized = FALSE;

  if (!window_is_eligible_anchor (win, active_ws))
    return FALSE;

  g_object_get (win, "minimized", &minimized, NULL);
  if (minimized)
    return FALSE;

  return TRUE;
}

static void
recompose (MetaAnnotationLayer *layer)
{
  g_autoptr (GSList) all = NULL;
  g_autoptr (GSList) sorted = NULL;
  GSList *l;
  MetaWorkspace *active_ws;
  cairo_t *cr;
  cairo_region_t *covered_by_higher;
  GPtrArray *visible_windows;
  GArray *rects;
  cairo_surface_t *composite;
  guint i;

  if (!layer->surface || !layer->display)
    return;

  /* Guard against a direct call (see meta_annotation_layer_clear) made
   * while the actor isn't visible. The upload would be thrown away. */
  if (!layer->active || layer->paused)
    {
      layer->recompose_dirty = TRUE;
      return;
    }

  layer->recompose_dirty = FALSE;

  /* Pin the composite surface for the duration. cogl_texture_set_data
   * and clutter_actor_queue_redraw can indirectly fire stage
   * notify::{width,height} -> recreate_buffers, which replaces
   * layer->surface out from under us. Taking a local reference keeps
   * the cairo writes below valid even if that happens. */
  composite = cairo_surface_reference (layer->surface);

  /* Start with a cleared composite surface. */
  surface_clear (composite);

  active_ws = get_active_workspace (layer);

  {
    GList *glist = meta_display_list_all_windows (layer->display);
    for (GList *gl = glist; gl; gl = gl->next)
      all = g_slist_prepend (all, gl->data);
    g_list_free (glist);
  }

  sorted = meta_display_sort_windows_by_stacking (layer->display, all);
  /* sorted is bottom-to-top. Build parallel arrays of visible windows +
   * frame rects in the same order. */
  visible_windows = g_ptr_array_new ();
  rects = g_array_new (FALSE, FALSE, sizeof (MtkRectangle));

  for (l = sorted; l; l = l->next)
    {
      MetaWindow *win = l->data;
      MtkRectangle fr;

      if (!window_is_visible_for_ink (win, active_ws))
        continue;

      meta_window_get_frame_rect (win, &fr);
      if (fr.width < 1 || fr.height < 1)
        continue;

      g_ptr_array_add (visible_windows, win);
      g_array_append_val (rects, fr);
    }

  /* Paint unattached ink first, clipped to "no eligible window covers it".
   * That's stage rect minus union of all visible frame rects. */
  cr = cairo_create (composite);
  if (layer->unattached_surface)
    {
      cairo_save (cr);
      cairo_rectangle (cr, 0, 0, layer->stage_width, layer->stage_height);
      cairo_clip (cr);

      /* Subtract each window's frame rect. Using even-odd fills on
       * sub-rectangles is awkward, so build a cairo region and clip by it. */
      {
        cairo_region_t *vis = cairo_region_create_rectangle (
          &(cairo_rectangle_int_t){0, 0,
                                    layer->stage_width, layer->stage_height});
        for (i = 0; i < visible_windows->len; i++)
          {
            MtkRectangle fr = g_array_index (rects, MtkRectangle, i);
            cairo_rectangle_int_t r = { fr.x, fr.y, fr.width, fr.height };
            cairo_region_subtract_rectangle (vis, &r);
          }

          cairo_new_path (cr);
          for (i = 0; i < (guint) cairo_region_num_rectangles (vis); i++)
            {
              cairo_rectangle_int_t r;
              cairo_region_get_rectangle (vis, i, &r);
              cairo_rectangle (cr, r.x, r.y, r.width, r.height);
            }
          cairo_clip (cr);
          cairo_region_destroy (vis);
      }

      cairo_set_operator (cr, CAIRO_OPERATOR_OVER);
      cairo_set_source_surface (cr, layer->unattached_surface, 0, 0);
      cairo_paint (cr);
      cairo_restore (cr);
    }

  /* For each visible window, paint its ink clipped by "this window's frame
   * rect minus all higher visible frame rects". Walk top-to-bottom
   * accumulating covered area, then paint. */
  covered_by_higher = cairo_region_create ();
  {
    /* Allocate a per-index visible region so we can paint bottom-to-top. */
    cairo_region_t **vis_regions =
      g_new0 (cairo_region_t *, visible_windows->len);

    for (i = visible_windows->len; i-- > 0;)
      {
        MtkRectangle fr = g_array_index (rects, MtkRectangle, i);
        cairo_rectangle_int_t r = { fr.x, fr.y, fr.width, fr.height };
        cairo_region_t *vis = cairo_region_create_rectangle (&r);

        cairo_region_subtract (vis, covered_by_higher);
        vis_regions[i] = vis;
        cairo_region_union_rectangle (covered_by_higher, &r);
      }

    for (i = 0; i < visible_windows->len; i++)
      {
        MetaWindow *win = g_ptr_array_index (visible_windows, i);
        MtkRectangle fr = g_array_index (rects, MtkRectangle, i);
        cairo_region_t *vis = vis_regions[i];
        WindowInk *ink;
        int k, nrects;

        ink = g_hash_table_lookup (layer->per_window, win);
        if (!ink || !ink->surface)
          {
            cairo_region_destroy (vis);
            continue;
          }

        cairo_save (cr);
        cairo_new_path (cr);
        nrects = cairo_region_num_rectangles (vis);
        for (k = 0; k < nrects; k++)
          {
            cairo_rectangle_int_t r;
            cairo_region_get_rectangle (vis, k, &r);
            cairo_rectangle (cr, r.x, r.y, r.width, r.height);
          }
        cairo_clip (cr);

        cairo_set_operator (cr, CAIRO_OPERATOR_OVER);
        cairo_set_source_surface (cr, ink->surface, fr.x, fr.y);
        cairo_paint (cr);
        cairo_restore (cr);

        cairo_region_destroy (vis);
      }

    g_free (vis_regions);
  }
  cairo_region_destroy (covered_by_higher);

  g_ptr_array_free (visible_windows, TRUE);
  g_array_free (rects, TRUE);

  cairo_destroy (cr);

  cairo_surface_flush (composite);

  /* If recreate_buffers ran re-entrantly while we were drawing (e.g.
   * from a stage resize signal fired indirectly by an earlier cairo
   * or Cogl call), layer->surface is now a freshly-allocated surface
   * of a different size. Skip the upload: recreate_buffers already
   * scheduled a follow-up recompose which will do the right work. */
  if (layer->surface == composite)
    sync_texture_from_surface (layer);
  else
    layer->recompose_dirty = TRUE;

  cairo_surface_destroy (composite);
}

/* --------------- Lifecycle --------------- */

MetaAnnotationLayer *
meta_annotation_layer_new (MetaBackend *backend, MetaDisplay *display)
{
  MetaAnnotationLayer *layer;
  ClutterActor *stage = meta_backend_get_stage (backend);
  MetaWorkspaceManager *wm;

  layer = g_new0 (MetaAnnotationLayer, 1);
  layer->backend = g_object_ref (backend);
  layer->display = display;
  layer->active = FALSE;
  layer->paused = FALSE;
  layer->rgba[0] = 1.0f;
  layer->rgba[1] = 0.2f;
  layer->rgba[2] = 0.2f;
  layer->rgba[3] = 1.0f;
  layer->last_pressure = 1.0f;

  layer->per_window =
    g_hash_table_new_full (g_direct_hash, g_direct_equal,
                           NULL, window_ink_free);

  layer->actor = clutter_actor_new ();
  clutter_actor_set_name (layer->actor, "annotation-layer");
  clutter_actor_set_reactive (layer->actor, FALSE);
  clutter_actor_set_opacity (layer->actor, 255);

  /* MetaAnnotationLayer is a plain C struct, not a GObject, so
   * g_signal_connect_object rejects us with a g_critical and returns 0.
   * Use the plain connect and pair with g_clear_signal_handler in
   * _destroy, which is the shape the destroy code already expects. */
  layer->width_notify_id =
    g_signal_connect (stage, "notify::width",
                      G_CALLBACK (on_stage_size_changed), layer);
  layer->height_notify_id =
    g_signal_connect (stage, "notify::height",
                      G_CALLBACK (on_stage_size_changed), layer);

  if (display)
    {
      layer->restacked_id =
        g_signal_connect (display, "restacked",
                          G_CALLBACK (on_display_restacked), layer);
      wm = meta_display_get_workspace_manager (display);
      if (wm)
        layer->active_ws_id =
          g_signal_connect (wm, "active-workspace-changed",
                            G_CALLBACK (on_active_workspace_changed), layer);
    }

  on_stage_size_changed (stage, NULL, layer);
  clutter_actor_hide (layer->actor);

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

  stage = meta_backend_get_stage (layer->backend);

  if (layer->recompose_idle_id)
    {
      g_source_remove (layer->recompose_idle_id);
      layer->recompose_idle_id = 0;
    }

  /* Drop weak reference before the window hash is torn down. */
  set_stroke_anchor (layer, NULL);
  layer->stroke_active = FALSE;

  if (layer->display)
    {
      g_clear_signal_handler (&layer->restacked_id, layer->display);
      {
        MetaWorkspaceManager *wm =
          meta_display_get_workspace_manager (layer->display);
        if (wm)
          g_clear_signal_handler (&layer->active_ws_id, wm);
      }
    }

  g_clear_signal_handler (&layer->width_notify_id, stage);
  g_clear_signal_handler (&layer->height_notify_id, stage);

  /* Destroys each WindowInk, which in turn disconnects our per-window
   * signals. */
  g_clear_pointer (&layer->per_window, g_hash_table_unref);

  g_clear_pointer (&layer->surface, cairo_surface_destroy);
  g_clear_pointer (&layer->unattached_surface, cairo_surface_destroy);
  g_clear_pointer (&layer->actor, clutter_actor_destroy);
  g_clear_pointer (&layer->chrome_regions, g_array_unref);
  g_clear_pointer (&layer->chrome_press_id, g_free);
  g_clear_object (&layer->backend);
  layer->display = NULL;

  g_free (layer);
}

ClutterActor *
meta_annotation_layer_get_actor (MetaAnnotationLayer *layer)
{
  g_return_val_if_fail (layer != NULL, NULL);
  return layer->actor;
}

/* --------------- Public setters --------------- */

void
meta_annotation_layer_clear (MetaAnnotationLayer *layer)
{
  GHashTableIter iter;
  gpointer k, v;

  g_return_if_fail (layer != NULL);

  surface_clear (layer->unattached_surface);
  if (layer->per_window)
    {
      g_hash_table_iter_init (&iter, layer->per_window);
      while (g_hash_table_iter_next (&iter, &k, &v))
        {
          WindowInk *ink = v;
          surface_clear (ink->surface);
        }
    }
  /* Clear the composite too, so a clear-while-paused leaves it
   * consistent with the per-window sources. recompose() early-returns
   * when paused without touching layer->surface, and any intermediate
   * peek at the surface between clear and unpause would otherwise see
   * pre-clear pixels. */
  surface_clear (layer->surface);

  layer->stroke_active = FALSE;
  set_stroke_anchor (layer, NULL);

  /* An already-queued idle would fire later and re-upload the same
   * cleared composite. Drop it; we compose synchronously below. */
  g_clear_handle_id (&layer->recompose_idle_id, g_source_remove);
  recompose (layer);
}

static void
update_actor_visibility (MetaAnnotationLayer *layer)
{
  if (!layer->actor)
    return;

  if (layer->active && !layer->paused)
    {
      if (clutter_actor_get_parent (layer->actor) == NULL)
        {
          ClutterActor *stage = meta_backend_get_stage (layer->backend);
          if (stage)
            clutter_actor_insert_child_above (stage, layer->actor, NULL);
        }
      /* If anything changed while we were hidden, compose synchronously
       * before the actor is shown so the first frame post-unpause is
       * always correct. An idle-dispatched recompose would leave the
       * prior Cogl texture contents visible for one frame at 60Hz,
       * which is a visible blink on overview close. */
      if (layer->recompose_dirty)
        {
          g_clear_handle_id (&layer->recompose_idle_id, g_source_remove);
          recompose (layer);
        }

      clutter_actor_show (layer->actor);
    }
  else
    {
      clutter_actor_hide (layer->actor);
    }
}

void
meta_annotation_layer_set_active (MetaAnnotationLayer *layer,
                                  gboolean             active)
{
  g_return_if_fail (layer != NULL);

  layer->active = active;
  meta_annotation_input_set_non_mouse_pointer_isolated (active);
  update_actor_visibility (layer);
}

gboolean
meta_annotation_layer_get_active (MetaAnnotationLayer *layer)
{
  g_return_val_if_fail (layer != NULL, FALSE);
  return layer->active;
}

void
meta_annotation_layer_set_paused (MetaAnnotationLayer *layer,
                                  gboolean             paused)
{
  gboolean was_paused;

  g_return_if_fail (layer != NULL);

  was_paused = layer->paused;
  layer->paused = paused;

  /* Going paused while a stroke is in flight would leave stroke_last_x/y
   * stale; on resume a fresh begin_stroke always reseeds those, but we
   * still want to mark the stroke ended so handle_event doesn't rely on
   * stroke_active while the actor is hidden. */
  if (!was_paused && paused && layer->stroke_active)
    {
      layer->stroke_active = FALSE;
      set_stroke_anchor (layer, NULL);
    }

  update_actor_visibility (layer);
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

/* --------------- Drawing --------------- */

static float
pressure_to_width_multiplier (float pressure)
{
  if (pressure < ANNOT_MIN_PRESSURE)
    pressure = ANNOT_MIN_PRESSURE;
  if (pressure > 1.0f)
    pressure = 1.0f;
  /* Mild gamma so light taps stay readable. */
  return sqrtf (pressure);
}

static void
draw_segment (MetaAnnotationLayer *layer,
              cairo_surface_t     *target,
              float                x1,
              float                y1,
              float                x2,
              float                y2,
              float                p1,
              float                p2)
{
  cairo_t *cr;
  float dx = x2 - x1;
  float dy = y2 - y1;
  float len2 = dx * dx + dy * dy;
  float w1 = ANNOT_BASE_WIDTH * pressure_to_width_multiplier (p1);
  float w2 = ANNOT_BASE_WIDTH * pressure_to_width_multiplier (p2);

  if (!target)
    return;

  cr = cairo_create (target);
  cairo_set_source_rgba (cr,
                         layer->rgba[0], layer->rgba[1],
                         layer->rgba[2], layer->rgba[3]);
  cairo_set_operator (cr, CAIRO_OPERATOR_OVER);

  if (len2 < 0.25f)
    {
      /* Tap / click without movement. */
      cairo_arc (cr, x1, y1, w1 * 0.5f, 0.0f, (float) (2.0 * M_PI));
      cairo_fill (cr);
    }
  else
    {
      float len = sqrtf (len2);
      float nx = -dy / len;
      float ny = dx / len;
      float hx1 = nx * w1 * 0.5f;
      float hy1 = ny * w1 * 0.5f;
      float hx2 = nx * w2 * 0.5f;
      float hy2 = ny * w2 * 0.5f;

      /* Filled trapezoid forms the stroke body. */
      cairo_new_path (cr);
      cairo_move_to (cr, x1 + hx1, y1 + hy1);
      cairo_line_to (cr, x2 + hx2, y2 + hy2);
      cairo_line_to (cr, x2 - hx2, y2 - hy2);
      cairo_line_to (cr, x1 - hx1, y1 - hy1);
      cairo_close_path (cr);
      cairo_fill (cr);

      /* Circular caps so consecutive segments join smoothly. */
      cairo_arc (cr, x1, y1, w1 * 0.5f, 0.0f, (float) (2.0 * M_PI));
      cairo_fill (cr);
      cairo_arc (cr, x2, y2, w2 * 0.5f, 0.0f, (float) (2.0 * M_PI));
      cairo_fill (cr);
    }
  cairo_destroy (cr);

  cairo_surface_flush (target);
}

/* --------------- Event handling --------------- */

static gboolean
pointer_has_draw_button (const ClutterEvent *event)
{
  ClutterModifierType state = clutter_event_get_state (event);

  return (state & CLUTTER_BUTTON1_MASK) != 0;
}

/* Return TRUE and set *out if the event carries a pressure axis value. */
static gboolean
event_get_pressure (const ClutterEvent *event, float *out)
{
  gdouble *axes;
  guint n_axes;

  if (!clutter_event_get_device_tool (event))
    return FALSE;

  axes = clutter_event_get_axes (event, &n_axes);
  if (!axes || (int) CLUTTER_INPUT_AXIS_PRESSURE >= (int) n_axes)
    return FALSE;

  if (out)
    *out = (float) axes[CLUTTER_INPUT_AXIS_PRESSURE];
  return TRUE;
}

static cairo_surface_t *
stroke_target_surface (MetaAnnotationLayer *layer)
{
  if (layer->stroke_anchor)
    {
      WindowInk *ink = g_hash_table_lookup (layer->per_window,
                                            layer->stroke_anchor);
      return ink ? ink->surface : NULL;
    }
  return layer->unattached_surface;
}

static void
convert_stage_to_local (MetaAnnotationLayer *layer,
                        float                stage_x,
                        float                stage_y,
                        float               *out_x,
                        float               *out_y)
{
  if (layer->stroke_anchor)
    {
      MtkRectangle fr;

      meta_window_get_frame_rect (layer->stroke_anchor, &fr);
      *out_x = stage_x - fr.x;
      *out_y = stage_y - fr.y;
    }
  else
    {
      *out_x = stage_x;
      *out_y = stage_y;
    }
}

static void
begin_stroke (MetaAnnotationLayer *layer, float stage_x, float stage_y,
              gboolean pressure_known, float pressure)
{
  MetaWindow *anchor;

  anchor = pick_anchor_window (layer, stage_x, stage_y);
  set_stroke_anchor (layer, anchor);

  if (anchor)
    ensure_window_ink (layer, anchor);

  convert_stage_to_local (layer, stage_x, stage_y,
                          &layer->stroke_last_x, &layer->stroke_last_y);
  layer->stroke_active = TRUE;
  /* Reset on unknown pressure so mouse / non-pressure touch after a
   * low-pressure stylus session renders at full width. Without this
   * reset, last_pressure leaks the final pressure of the previous
   * tablet stroke into subsequent mouse / touch strokes.
   *
   * Also treat pressure==0 (e.g. a pen-button press while hovering) as
   * unknown; rendering such an event at MIN_PRESSURE would produce a
   * ~1.9px stroke that the user didn't ask for. The motion handler
   * already gates on `pressure > 0` for the same reason. */
  layer->last_pressure =
    (pressure_known && pressure > 0.0f) ? pressure : 1.0f;
}

static void
continue_stroke (MetaAnnotationLayer *layer, float stage_x, float stage_y,
                 gboolean pressure_known, float pressure)
{
  cairo_surface_t *target;
  float lx, ly;
  float p_end;

  target = stroke_target_surface (layer);
  convert_stage_to_local (layer, stage_x, stage_y, &lx, &ly);
  p_end = pressure_known ? pressure : layer->last_pressure;

  if (target)
    draw_segment (layer, target,
                  layer->stroke_last_x, layer->stroke_last_y, lx, ly,
                  layer->last_pressure, p_end);

  layer->stroke_last_x = lx;
  layer->stroke_last_y = ly;
  layer->last_pressure = p_end;
  schedule_recompose (layer);
}

static void
end_stroke (MetaAnnotationLayer *layer)
{
  layer->stroke_active = FALSE;
  set_stroke_anchor (layer, NULL);
  schedule_recompose (layer);
}

gboolean
meta_annotation_layer_handle_event (MetaAnnotationLayer *layer,
                                    const ClutterEvent  *event)
{
  ClutterEventType type;
  graphene_point_t pos;
  float pressure = 0.0f;
  gboolean pressure_known;

  g_return_val_if_fail (layer != NULL, FALSE);
  g_return_val_if_fail (event != NULL, FALSE);

  if (!layer->active || layer->paused || !layer->surface)
    return FALSE;

  type = clutter_event_type (event);
  pressure_known = event_get_pressure (event, &pressure);

  switch (type)
    {
    case CLUTTER_BUTTON_PRESS:
      {
        guint btn = clutter_event_get_button (event);

        /* Primary, or any press while a tool is present. */
        if (btn != CLUTTER_BUTTON_PRIMARY && !clutter_event_get_device_tool (event))
          return TRUE;
      }
      clutter_event_get_coords (event, &pos.x, &pos.y);
      begin_stroke (layer, pos.x, pos.y, pressure_known, pressure);
      return TRUE;

    case CLUTTER_MOTION:
      {
        gboolean pressure_tip = pressure_known && pressure > 0.0f;
        gboolean btn = pointer_has_draw_button (event);

        if (!layer->stroke_active && !btn && !pressure_tip)
          return TRUE;

        clutter_event_get_coords (event, &pos.x, &pos.y);

        if (!layer->stroke_active && (btn || pressure_tip))
          {
            begin_stroke (layer, pos.x, pos.y, pressure_known, pressure);
            return TRUE;
          }

        continue_stroke (layer, pos.x, pos.y, pressure_known, pressure);

        if (!(btn || pressure_tip))
          end_stroke (layer);
        return TRUE;
      }

    case CLUTTER_BUTTON_RELEASE:
      if (layer->stroke_active)
        {
          clutter_event_get_coords (event, &pos.x, &pos.y);
          continue_stroke (layer, pos.x, pos.y, pressure_known, pressure);
        }
      end_stroke (layer);
      return TRUE;

    case CLUTTER_TOUCH_BEGIN:
      clutter_event_get_coords (event, &pos.x, &pos.y);
      begin_stroke (layer, pos.x, pos.y, pressure_known, pressure);
      return TRUE;

    case CLUTTER_TOUCH_UPDATE:
      if (layer->stroke_active)
        {
          clutter_event_get_coords (event, &pos.x, &pos.y);
          continue_stroke (layer, pos.x, pos.y, pressure_known, pressure);
        }
      return TRUE;

    case CLUTTER_TOUCH_END:
      if (layer->stroke_active)
        {
          clutter_event_get_coords (event, &pos.x, &pos.y);
          continue_stroke (layer, pos.x, pos.y, pressure_known, pressure);
        }
      end_stroke (layer);
      return TRUE;

    case CLUTTER_TOUCH_CANCEL:
      end_stroke (layer);
      return TRUE;

    default:
      return FALSE;
    }
}

/* --------------- Chrome regions (unchanged) --------------- */

void
meta_annotation_layer_set_chrome_regions (MetaAnnotationLayer *layer,
                                          GVariant            *regions)
{
  GArray *arr;
  GVariantIter iter;
  const char *id;
  gint32 x, y, w, h;

  g_return_if_fail (layer != NULL);

  arr = ensure_chrome_regions (layer);
  g_array_set_size (arr, 0);

  if (!regions)
    return;

  g_variant_iter_init (&iter, regions);
  while (g_variant_iter_loop (&iter, "(&siiii)", &id, &x, &y, &w, &h))
    {
      ChromeRegion r;

      if (w <= 0 || h <= 0 || !id)
        continue;

      r.id = g_strdup (id);
      graphene_rect_init (&r.rect, (float) x, (float) y, (float) w, (float) h);
      g_array_append_val (arr, r);
    }
}

void
meta_annotation_layer_clear_chrome_regions (MetaAnnotationLayer *layer)
{
  g_return_if_fail (layer != NULL);

  if (layer->chrome_regions)
    g_array_set_size (layer->chrome_regions, 0);
  g_clear_pointer (&layer->chrome_press_id, g_free);
}

const char *
meta_annotation_layer_pick_chrome_region (MetaAnnotationLayer *layer,
                                          float                x,
                                          float                y)
{
  g_return_val_if_fail (layer != NULL, NULL);

  if (!layer->chrome_regions || layer->chrome_regions->len == 0)
    return NULL;

  for (guint i = layer->chrome_regions->len; i-- > 0;)
    {
      ChromeRegion *r = &g_array_index (layer->chrome_regions, ChromeRegion, i);
      graphene_point_t p;

      graphene_point_init (&p, x, y);
      if (graphene_rect_contains_point (&r->rect, &p))
        return r->id;
    }

  return NULL;
}

void
meta_annotation_layer_set_chrome_press_active (MetaAnnotationLayer *layer,
                                               const char          *id)
{
  g_return_if_fail (layer != NULL);

  g_clear_pointer (&layer->chrome_press_id, g_free);
  if (id)
    layer->chrome_press_id = g_strdup (id);
}

gboolean
meta_annotation_layer_chrome_press_active (MetaAnnotationLayer *layer,
                                           const char         **id_out)
{
  g_return_val_if_fail (layer != NULL, FALSE);

  if (id_out)
    *id_out = layer->chrome_press_id;
  return layer->chrome_press_id != NULL;
}

void
meta_annotation_layer_clear_chrome_press (MetaAnnotationLayer *layer)
{
  g_return_if_fail (layer != NULL);
  g_clear_pointer (&layer->chrome_press_id, g_free);
}
