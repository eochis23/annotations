/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#pragma once

#include <glib.h>

typedef struct _MetaAnnotationLayer MetaAnnotationLayer;
typedef struct _MetaAnnotationDBus MetaAnnotationDBus;

MetaAnnotationDBus *meta_annotation_dbus_new (MetaAnnotationLayer *layer);

void meta_annotation_dbus_free (MetaAnnotationDBus *dbus);
