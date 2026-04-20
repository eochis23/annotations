/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#pragma once

#include <glib.h>
#include <clutter/clutter.h>

void     meta_annotation_debug_append_ndjson (const gchar *hypothesis_id,
                                              const gchar *location,
                                              const gchar *message,
                                              gint          a,
                                              gint          b,
                                              gint          c,
                                              gint          d);

gboolean meta_annotation_event_targets_overlay (const ClutterEvent *event);

void     meta_annotation_input_set_non_mouse_pointer_isolated (gboolean isolated);

void     meta_annotation_input_note_tablet_family_motion (gint64 libinput_device_group,
                                                          float  x,
                                                          float  y);

void     meta_annotation_input_note_from_pointer_if_stylus_class (ClutterInputDevice     *device,
                                                                 ClutterInputDeviceTool *tool,
                                                                 const double            *axes,
                                                                 gint64                  libinput_device_group,
                                                                 float                   x,
                                                                 float                   y);

gboolean meta_annotation_input_skip_master_pointer_update (ClutterInputDevice     *device,
                                                           ClutterInputDeviceTool *tool,
                                                           const double            *motion_axes,
                                                           gint64                  libinput_device_group,
                                                           float                   pointer_pos_x,
                                                           float                   pointer_pos_y);

gboolean meta_annotation_input_skip_pointer_motion_coalesced (ClutterInputDevice     *device,
                                                               ClutterInputDeviceTool *tool,
                                                               const double            *motion_axes,
                                                               gint64                  libinput_device_group,
                                                               float                   pointer_pos_x,
                                                               float                   pointer_pos_y);

void     meta_annotation_input_debug_emit_pointer_position_if_leak (ClutterInputDevice *device,
                                                                    gboolean            freeze_cursor,
                                                                    float               pos_x,
                                                                    float               pos_y);

gboolean meta_annotation_input_event_should_skip_wayland_seat_sync (const ClutterEvent *event);
