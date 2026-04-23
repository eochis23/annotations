/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#pragma once

#include <glib.h>

typedef struct _MetaAnnotationLayer MetaAnnotationLayer;
typedef struct _MetaAnnotationDBus MetaAnnotationDBus;

MetaAnnotationDBus *meta_annotation_dbus_new (MetaAnnotationLayer *layer);

void meta_annotation_dbus_free (MetaAnnotationDBus *dbus);

/* Emit RegionActivated(s id, s kind) on org.gnome.Mutter.Annotation.
 * `kind` is one of: "press", "release", "touch-begin", "touch-end".
 * Safe to call before the bus name is acquired (no-op in that case). */
void meta_annotation_dbus_emit_region_activated (MetaAnnotationDBus *dbus,
                                                 const char         *id,
                                                 const char         *kind);
