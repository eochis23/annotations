/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#pragma once

#include <glib.h>
#include <clutter/clutter.h>

gboolean meta_annotation_event_targets_overlay (const ClutterEvent *event);

void     meta_annotation_input_set_non_mouse_pointer_isolated (gboolean isolated);

gboolean meta_annotation_input_skip_master_pointer_update (ClutterInputDevice     *device,
                                                           ClutterInputDeviceTool *tool,
                                                           const double            *motion_axes);

gboolean meta_annotation_input_skip_pointer_motion_coalesced (ClutterInputDevice     *device,
                                                               ClutterInputDeviceTool *tool,
                                                               const double            *motion_axes);

gboolean meta_annotation_input_event_should_skip_wayland_seat_sync (const ClutterEvent *event);
