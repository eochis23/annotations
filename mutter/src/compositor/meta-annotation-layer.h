/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#pragma once

#include <glib.h>
#include <clutter/clutter.h>

#include "meta/meta-backend.h"

typedef struct _MetaAnnotationLayer MetaAnnotationLayer;

META_EXPORT
MetaAnnotationLayer *meta_annotation_layer_new (MetaBackend *backend);

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

META_EXPORT
gboolean meta_annotation_layer_handle_event (MetaAnnotationLayer *layer,
                                             const ClutterEvent *event);
