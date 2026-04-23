/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#pragma once

#include <glib.h>
#include <clutter/clutter.h>

#include "meta/meta-backend.h"
#include "meta/display.h"

typedef struct _MetaAnnotationLayer MetaAnnotationLayer;

META_EXPORT
MetaAnnotationLayer *meta_annotation_layer_new (MetaBackend *backend,
                                                MetaDisplay *display);

META_EXPORT
void meta_annotation_layer_destroy (MetaAnnotationLayer *layer);

META_EXPORT
ClutterActor *meta_annotation_layer_get_actor (MetaAnnotationLayer *layer);

META_EXPORT
void meta_annotation_layer_clear (MetaAnnotationLayer *layer);

META_EXPORT
void meta_annotation_layer_set_active (MetaAnnotationLayer *layer,
                                       gboolean          active);

META_EXPORT
gboolean meta_annotation_layer_get_active (MetaAnnotationLayer *layer);

META_EXPORT
void meta_annotation_layer_set_color (MetaAnnotationLayer *layer,
                                      double             r,
                                      double             g,
                                      double             b,
                                      double             a);

/* Pause hides the annotation actor without touching active state, chrome
 * regions, or pointer isolation. Used while the overview is showing so
 * ink doesn't paint on top of the workspace thumbnails. */
META_EXPORT
void meta_annotation_layer_set_paused (MetaAnnotationLayer *layer,
                                       gboolean             paused);

META_EXPORT
gboolean meta_annotation_layer_handle_event (MetaAnnotationLayer *layer,
                                             const ClutterEvent *event);

/* Chrome regions: rectangles in stage coordinates published by the shell
 * extension that mark where the dock buttons live. Press/release events that
 * land inside a region are converted by the compositor into RegionActivated
 * D-Bus signals instead of ink strokes (synthetic dock activation). */

META_EXPORT
void meta_annotation_layer_set_chrome_regions (MetaAnnotationLayer *layer,
                                               GVariant            *regions);

META_EXPORT
void meta_annotation_layer_clear_chrome_regions (MetaAnnotationLayer *layer);

/* Returns the id of the topmost (last-set) region containing (x, y), or
 * NULL if none. The returned string is owned by the layer and remains valid
 * until the next set/clear call. */
META_EXPORT
const char *meta_annotation_layer_pick_chrome_region (MetaAnnotationLayer *layer,
                                                      float                x,
                                                      float                y);

/* Scroll-following: the shell extension registers a "content-tracked"
 * editor region per matching PID, then pushes scroll updates as the
 * user scrolls the document. Strokes whose first point lands inside
 * the region get stored in editor content space and move with scroll;
 * strokes outside stay pinned to the window surface (existing
 * behavior). Calling SetWindowEditorRegion with w=0 or h=0 clears it;
 * unknown PIDs are no-ops. */

META_EXPORT
void meta_annotation_layer_set_window_editor_region (MetaAnnotationLayer *layer,
                                                     guint32              pid,
                                                     int                  x,
                                                     int                  y,
                                                     int                  w,
                                                     int                  h);

META_EXPORT
void meta_annotation_layer_set_window_scroll (MetaAnnotationLayer *layer,
                                              guint32              pid,
                                              int                  scroll_x,
                                              int                  scroll_y);

/* Per-stroke "press consumed by chrome" tracking, used by the compositor
 * routing path so motion events arriving between a chrome press and its
 * release don't open an ink stroke if the user drags off the dock. */
META_EXPORT
void meta_annotation_layer_set_chrome_press_active (MetaAnnotationLayer *layer,
                                                    const char          *id);

META_EXPORT
gboolean meta_annotation_layer_chrome_press_active (MetaAnnotationLayer *layer,
                                                    const char         **id_out);

META_EXPORT
void meta_annotation_layer_clear_chrome_press (MetaAnnotationLayer *layer);
