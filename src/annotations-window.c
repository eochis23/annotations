/* MIT License
 *
 * Copyright (c) 2026 Eric Ochis
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * SPDX-License-Identifier: MIT
 */

#include "config.h"

#include <glib/gi18n.h>
#include <string.h>
#include <gdk/gdk.h>
#if defined(GDK_WINDOWING_WAYLAND)
# include <gdk/wayland/gdkwayland.h>
#endif
#include <graphene.h>
#include <gtk/gtk.h>

#ifdef HAVE_GTK4_LAYER_SHELL
# include <gtk4-layer-shell/gtk4-layer-shell.h>
#endif
#if defined(GDK_WINDOWING_X11)
# include <gdk/x11/gdkx.h>
#endif

#include "annotations-window.h"

typedef struct
{
	gdouble x;
	gdouble y;
	gdouble pressure; /* 0..1 from tablet; 1 if unknown */
} AnnoPoint;

typedef struct
{
	GArray   *points; /* AnnoPoint */
	GdkRGBA   ink;
} AnnoStroke;

typedef enum
{
	STYLUS_NONE = 0,
	STYLUS_DRAW,
	STYLUS_ERASE
} StylusKind;

struct _AnnotationsWindow
{
	AdwApplicationWindow  parent_instance;

	/* Template widgets */
	GtkOverlay           *content_overlay;
	AdwToastOverlay     *toast_overlay;
	AdwHeaderBar         *main_header;
	GtkDrawingArea       *canvas;

	GPtrArray            *strokes;       /* AnnoStroke owned */
	AnnoStroke           *current_stroke;
	AnnoStroke           *eraser_path;
	gboolean              pen_down;
	gboolean              erasing;
	StylusKind            active_kind;

	GdkRGBA               pen_color;
	GtkWidget             *selected_swatch;

	/* Floating tool dock */
	GtkWidget             *floating_dock;
	GtkWidget             *dock_expanded;
	GtkWidget             *dock_collapsed;
	gboolean              dock_tools_open;
	gboolean              dock_gesture_dragging;
	gint                    dock_margin_x;
	gint                    dock_margin_y;
	gint                    dock_drag_start_mx;
	gint                    dock_drag_start_my;
	gdouble                 dock_ptr_overlay_x0;
	gdouble                 dock_ptr_overlay_y0;
	guint                   dock_idle_source;

	/* Wayland (!layer-shell): when TRUE, input region is dock-only so the mouse reaches
	 * windows below the canvas; when FALSE, the canvas is included for reliable pen hits. */
	gboolean                pass_mouse_through_canvas;

	/* Compositor input region: mouse/touch hit the dock only unless the pen is
	 * actively drawing (see annotations_input_region_apply). */
	guint                   input_region_idle;

	/* Wayland: coalesced gdk_toplevel_present when pass-through lets other windows activate. */
	guint                   wayland_restack_idle;

	/* Wayland: one-shot idle to re-apply input region after present() (next main-loop turn). */
	guint                   wayland_reapply_idle;

	/* Skip chaining another Wayland restack from apply() when apply is re-run after present(). */
	gboolean                suppress_wayland_restack;

	/* TRUE when using gtk4-layer-shell (Wayland wlr-layer-shell); else X11/maximized path. */
	gboolean                stacking_layer_shell;
};

G_DEFINE_FINAL_TYPE (AnnotationsWindow, annotations_window, ADW_TYPE_APPLICATION_WINDOW)

static void
anno_stroke_free (gpointer data)
{
	AnnoStroke *stroke = data;

	if (stroke == NULL)
		return;

	g_clear_pointer (&stroke->points, g_array_unref);
	g_free (stroke);
}

static AnnoStroke *
anno_stroke_new (void)
{
	AnnoStroke *stroke;

	stroke = g_new0 (AnnoStroke, 1);
	stroke->points = g_array_new (FALSE, FALSE, sizeof (AnnoPoint));

	return stroke;
}

static void
annotations_window_dispose (GObject *object)
{
	AnnotationsWindow *self = ANNOTATIONS_WINDOW (object);

	if (self->dock_idle_source != 0)
	{
		g_source_remove (self->dock_idle_source);
		self->dock_idle_source = 0;
	}

	if (self->input_region_idle != 0)
	{
		g_source_remove (self->input_region_idle);
		self->input_region_idle = 0;
	}

	if (self->wayland_restack_idle != 0)
	{
		g_source_remove (self->wayland_restack_idle);
		self->wayland_restack_idle = 0;
	}

	if (self->wayland_reapply_idle != 0)
	{
		g_source_remove (self->wayland_reapply_idle);
		self->wayland_reapply_idle = 0;
	}

	g_clear_pointer (&self->current_stroke, anno_stroke_free);
	g_clear_pointer (&self->eraser_path, anno_stroke_free);
	g_clear_pointer (&self->strokes, g_ptr_array_unref);

	G_OBJECT_CLASS (annotations_window_parent_class)->dispose (object);
}

static gboolean
event_is_stylus_device (GdkEvent *event)
{
	GdkDeviceTool *tool;
	GdkDevice *device;
	GdkInputSource src;
	double pr;

	tool = gdk_event_get_device_tool (event);
	if (tool != NULL)
	{
		GdkDeviceToolType t = gdk_device_tool_get_tool_type (tool);

		if (t == GDK_DEVICE_TOOL_TYPE_PEN ||
		    t == GDK_DEVICE_TOOL_TYPE_ERASER ||
		    t == GDK_DEVICE_TOOL_TYPE_PENCIL)
			return TRUE;
	}

	device = gdk_event_get_device (event);
	if (device == NULL)
		return FALSE;

	src = gdk_device_get_source (device);
	if (src == GDK_SOURCE_PEN)
		return TRUE;

	/* Wayland / libinput: the tablet tip is often routed as the core pointer (MOUSE)
	 * with a pressure axis, so GDK_SOURCE_PEN is never set. */
	if (src == GDK_SOURCE_MOUSE &&
	    gdk_event_get_axis (event, GDK_AXIS_PRESSURE, &pr) &&
	    pr > 0.001)
		return TRUE;

	return FALSE;
}

static StylusKind
event_stylus_kind (GdkEvent *event, GtkGesture *gesture)
{
	GdkDeviceTool *tool;
	guint button;

	if (event == NULL || !event_is_stylus_device (event))
		return STYLUS_NONE;

	button = gtk_gesture_single_get_current_button (GTK_GESTURE_SINGLE (gesture));
	if (button == 0 && gdk_event_get_event_type (event) == GDK_BUTTON_PRESS)
		button = gdk_button_event_get_button (event);

	tool = gdk_event_get_device_tool (event);
	if (tool != NULL)
	{
		GdkDeviceToolType t = gdk_device_tool_get_tool_type (tool);

		if (t == GDK_DEVICE_TOOL_TYPE_ERASER)
			return STYLUS_ERASE;
		if (t == GDK_DEVICE_TOOL_TYPE_PEN || t == GDK_DEVICE_TOOL_TYPE_PENCIL)
			return STYLUS_DRAW;
	}

	/* No tool (or unknown): treat pen secondary button as eraser for flaky drivers */
	if (button == GDK_BUTTON_SECONDARY)
		return STYLUS_ERASE;

	/* Some tablets report the physical eraser tip as middle button with no tool. */
	if (tool == NULL && button == GDK_BUTTON_MIDDLE)
		return STYLUS_ERASE;

	if (button == GDK_BUTTON_PRIMARY)
		return STYLUS_DRAW;

	/* Wayland: first press sometimes omits button in GtkGestureClick; still a pen device. */
	if (gdk_event_get_device (event) != NULL &&
	    gdk_device_get_source (gdk_event_get_device (event)) == GDK_SOURCE_PEN)
		return STYLUS_DRAW;

	/* Tablet-as-mouse: button id still unset but pressure already > 0 on press. */
	{
		double p;

		if (gdk_event_get_axis (event, GDK_AXIS_PRESSURE, &p) && p > 0.001)
			return STYLUS_DRAW;
	}

	return STYLUS_NONE;
}

static gdouble
event_get_pressure (GdkEvent *event)
{
	double v;

	if (event != NULL && gdk_event_get_axis (event, GDK_AXIS_PRESSURE, &v))
	{
		if (v < 0.0)
			v = 0.0;
		else if (v > 1.0)
			v = 1.0;
		return v;
	}

	return 1.0;
}

static gdouble
pressure_to_line_width (gdouble pressure)
{
	const gdouble min_w = 0.9;
	const gdouble max_w = 7.0;
	const gdouble floor_p = 0.08;

	if (pressure < floor_p)
		pressure = floor_p;
	if (pressure > 1.0)
		pressure = 1.0;

	return min_w + (max_w - min_w) * pressure;
}

typedef struct
{
	const char *hex;
	const char *css_class;
	const char *a11y_label;
} PenChoice;

static const PenChoice pen_choices[] = {
	{ "#1a1a1a", "anno-pen-black",  N_("Black") },
	{ "#ffffff", "anno-pen-white",  N_("White") },
	{ "#c62931", "anno-pen-red",    N_("Red") },
	{ "#26a269", "anno-pen-green",  N_("Green") },
	{ "#3584e4", "anno-pen-blue",   N_("Blue") },
	{ "#7b42a6", "anno-pen-purple", N_("Purple") },
};

static void
dock_css_register_once (void)
{
	static const char css[] =
		".anno-dock-shell { padding: 5px; border-radius: 9px; background-color: alpha(white, 0.94); box-shadow: 0 1px 3px alpha(black, 0.18); }\n"
		"@media (prefers-color-scheme: dark) {\n"
		"  .anno-dock-shell { background-color: alpha(black, 0.82); }\n"
		"}\n"
		".anno-drag-handle { min-height: 5px; min-width: 28px; margin-bottom: 3px; border-radius: 3px; background-color: alpha(black, 0.25); }\n"
		".anno-swatch { min-width: 22px; min-height: 22px; padding: 0; border-radius: 9999px; border: 1px solid alpha(black, 0.22); }\n"
		".anno-swatch-selected { outline: 2px solid #3584e4; outline-offset: 1px; }\n"
		".anno-pen-black { background-color: #1a1a1a; }\n"
		".anno-pen-white { background-color: #ffffff; border-color: alpha(black, 0.4); }\n"
		".anno-pen-red { background-color: #c62931; }\n"
		".anno-pen-green { background-color: #26a269; }\n"
		".anno-pen-blue { background-color: #3584e4; }\n"
		".anno-pen-purple { background-color: #7b42a6; }\n"
		".anno-clear-zone { min-height: 22px; margin-top: 2px; padding: 2px 0; border-radius: 6px; background-color: alpha(#c01c28, 0.12); }\n"
		".anno-clear-label { font-size: 0.72rem; font-weight: 600; color: #c01c28; opacity: 1; }\n"
		".anno-dock-collapsed { min-width: 26px; min-height: 26px; padding: 0; border-radius: 8px; justify-content: center; align-items: center; }\n"
		".anno-trans-layer { background-color: transparent; }\n"
		".anno-canvas-clear { background-color: transparent; }\n";

	static gsize done;

	if (g_once_init_enter (&done))
	{
		GdkDisplay *display;
		GtkCssProvider *provider;

		display = gdk_display_get_default ();
		if (display != NULL)
		{
			provider = gtk_css_provider_new ();
			gtk_css_provider_load_from_string (provider, css);
			gtk_style_context_add_provider_for_display (
				display,
				GTK_STYLE_PROVIDER (provider),
				GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
			g_object_unref (provider);
		}

		g_once_init_leave (&done, 1);
	}
}

static void
transparent_window_css_register_once (void)
{
	static const char css[] =
		"#anno-main-window {\n"
		"  background: none;\n"
		"  background-color: transparent;\n"
		"}\n"
		"#anno-content-root toastoverlay,\n"
		"#anno-content-root toolbarview,\n"
		"#anno-content-root toolbarview * {\n"
		"  background-color: transparent;\n"
		"  background-image: none;\n"
		"}\n"
		"#anno-canvas {\n"
		"  background-color: transparent;\n"
		"}\n";

	static gsize done;

	if (g_once_init_enter (&done))
	{
		GdkDisplay *display;
		GtkCssProvider *provider;

		display = gdk_display_get_default ();
		if (display != NULL)
		{
			provider = gtk_css_provider_new ();
			gtk_css_provider_load_from_string (provider, css);
			gtk_style_context_add_provider_for_display (
				display,
				GTK_STYLE_PROVIDER (provider),
				GTK_STYLE_PROVIDER_PRIORITY_USER);
			g_object_unref (provider);
		}

		g_once_init_leave (&done, 1);
	}
}

static void dock_clamp_margins (AnnotationsWindow *self);
static gboolean dock_idle_collapse_cb (gpointer user_data);
static gboolean dock_clamp_idle_cb (gpointer user_data);
static void annotations_input_region_apply (AnnotationsWindow *self);
static void annotations_input_region_schedule (AnnotationsWindow *self);
static gboolean annotations_input_region_retry_cb (gpointer user_data);
static void annotations_window_setup_stacking (AnnotationsWindow *self);
#if defined(GDK_WINDOWING_X11)
static void annotations_x11_net_wm_state_above (AnnotationsWindow *self);
#endif
static void annotations_window_reassert_above (AnnotationsWindow *self);
#if defined(GDK_WINDOWING_WAYLAND)
static void annotations_wayland_schedule_restack (AnnotationsWindow *self);
static gboolean annotations_wayland_reapply_input_idle_cb (gpointer user_data);
#endif
static void on_window_mapped (GtkWidget *widget, gpointer user_data);
static void on_notify_is_active (GObject *object, GParamSpec *pspec, gpointer user_data);
static void widget_strip_rec_focus (GtkWidget *widget);

static void
perform_clear_all (AnnotationsWindow *self)
{
	g_clear_pointer (&self->current_stroke, anno_stroke_free);
	g_clear_pointer (&self->eraser_path, anno_stroke_free);
	self->erasing = FALSE;
	self->pen_down = FALSE;
	self->active_kind = STYLUS_NONE;

	if (self->strokes != NULL)
		g_ptr_array_set_size (self->strokes, 0);

	gtk_widget_queue_draw (GTK_WIDGET (self->canvas));
	annotations_input_region_apply (self);
}

static void
dock_clear_idle_timer (AnnotationsWindow *self)
{
	if (self->dock_idle_source != 0)
	{
		g_source_remove (self->dock_idle_source);
		self->dock_idle_source = 0;
	}
}

static void
dock_reset_idle_timer (AnnotationsWindow *self)
{
	if (!self->dock_tools_open)
		return;

	dock_clear_idle_timer (self);
	self->dock_idle_source = g_timeout_add_seconds (5, dock_idle_collapse_cb, self);
}

static gboolean
dock_clamp_idle_cb (gpointer user_data)
{
	dock_clamp_margins (ANNOTATIONS_WINDOW (user_data));
	return G_SOURCE_REMOVE;
}

static gboolean
dock_idle_collapse_cb (gpointer user_data)
{
	AnnotationsWindow *self = user_data;

	self->dock_idle_source = 0;

	if (self->dock_gesture_dragging)
	{
		dock_reset_idle_timer (self);
		return G_SOURCE_REMOVE;
	}

	if (!self->dock_tools_open)
		return G_SOURCE_REMOVE;

	self->dock_tools_open = FALSE;
	gtk_widget_set_visible (self->dock_expanded, FALSE);
	gtk_widget_set_visible (self->dock_collapsed, TRUE);

	g_idle_add ((GSourceFunc) dock_clamp_idle_cb, self);

	return G_SOURCE_REMOVE;
}

static void
dock_open_tools (AnnotationsWindow *self)
{
	self->dock_tools_open = TRUE;
	gtk_widget_set_visible (self->dock_expanded, TRUE);
	gtk_widget_set_visible (self->dock_collapsed, FALSE);
	dock_reset_idle_timer (self);
	g_idle_add ((GSourceFunc) dock_clamp_idle_cb, self);
}

static void
on_overlay_resize (GObject *object, GParamSpec *pspec, gpointer user_data)
{
	(void) object;
	(void) pspec;

	dock_clamp_margins (ANNOTATIONS_WINDOW (user_data));
	annotations_input_region_schedule (ANNOTATIONS_WINDOW (user_data));
}

static gboolean
dock_input_rect_surface (AnnotationsWindow *self,
                         GdkSurface *surface,
                         cairo_rectangle_int_t *out)
{
	GtkNative *native;
	graphene_point_t in_pt;
	graphene_point_t out_pt;
	gint nw, nh, sw, sh, dw, dh;
	double rx, ry;

	if (self->floating_dock == NULL || !gtk_widget_get_mapped (self->floating_dock))
		return FALSE;

	native = gtk_widget_get_native (GTK_WIDGET (self));
	if (native == NULL)
		return FALSE;

	nw = gtk_widget_get_width (GTK_WIDGET (native));
	nh = gtk_widget_get_height (GTK_WIDGET (native));
	sw = gdk_surface_get_width (surface);
	sh = gdk_surface_get_height (surface);
	if (nw <= 0 || nh <= 0 || sw <= 0 || sh <= 0)
		return FALSE;

	graphene_point_init (&in_pt, 0.f, 0.f);
	if (!gtk_widget_compute_point (self->floating_dock,
	                               GTK_WIDGET (native),
	                               &in_pt,
	                               &out_pt))
		return FALSE;

	rx = (double) sw / (double) nw;
	ry = (double) sh / (double) nh;

	dw = gtk_widget_get_width (self->floating_dock);
	dh = gtk_widget_get_height (self->floating_dock);

	out->x = (int) (out_pt.x * rx + 0.5);
	out->y = (int) (out_pt.y * ry + 0.5);
	out->width = (int) (dw * rx + 0.5);
	out->height = (int) (dh * ry + 0.5);

	return out->width > 0 && out->height > 0;
}

static gboolean
canvas_input_rect_surface (AnnotationsWindow *self,
                           GdkSurface *surface,
                           cairo_rectangle_int_t *out)
{
	GtkNative *native;
	graphene_point_t in_pt;
	graphene_point_t out_pt;
	gint nw, nh, sw, sh, cw, ch;
	double rx, ry;

	if (self->canvas == NULL || !gtk_widget_get_mapped (GTK_WIDGET (self->canvas)))
		return FALSE;

	native = gtk_widget_get_native (GTK_WIDGET (self));
	if (native == NULL)
		return FALSE;

	nw = gtk_widget_get_width (GTK_WIDGET (native));
	nh = gtk_widget_get_height (GTK_WIDGET (native));
	sw = gdk_surface_get_width (surface);
	sh = gdk_surface_get_height (surface);
	if (nw <= 0 || nh <= 0 || sw <= 0 || sh <= 0)
		return FALSE;

	graphene_point_init (&in_pt, 0.f, 0.f);
	if (!gtk_widget_compute_point (GTK_WIDGET (self->canvas),
	                               GTK_WIDGET (native),
	                               &in_pt,
	                               &out_pt))
		return FALSE;

	rx = (double) sw / (double) nw;
	ry = (double) sh / (double) nh;

	cw = gtk_widget_get_width (GTK_WIDGET (self->canvas));
	ch = gtk_widget_get_height (GTK_WIDGET (self->canvas));

	out->x = (int) (out_pt.x * rx + 0.5);
	out->y = (int) (out_pt.y * ry + 0.5);
	out->width = (int) (cw * rx + 0.5);
	out->height = (int) (ch * ry + 0.5);

	return out->width > 0 && out->height > 0;
}

static void
annotations_surface_input_region_commit (GdkSurface *surface)
{
#if defined(GDK_WINDOWING_WAYLAND) && GTK_CHECK_VERSION (4, 18, 0)
	if (GDK_IS_WAYLAND_SURFACE (surface))
		gdk_wayland_surface_force_next_commit (surface);
#else
	(void) surface;
#endif
}

static void
annotations_input_region_apply (AnnotationsWindow *self)
{
	GdkDisplay *display;
	GdkSurface *surface;
	GtkNative *native;
	cairo_region_t *region;
	cairo_rectangle_int_t dock_rect;
	cairo_rectangle_int_t canvas_rect;
	gboolean merge_canvas_wayland;
	gboolean canvas_merged;

	if (!gtk_widget_get_realized (GTK_WIDGET (self)))
		return;

	display = gtk_widget_get_display (GTK_WIDGET (self));
	if (display == NULL || !gdk_display_supports_input_shapes (display))
		return;

	native = gtk_widget_get_native (GTK_WIDGET (self));
	if (native == NULL)
		return;

	surface = gtk_native_get_surface (native);
	if (surface == NULL || gdk_surface_is_destroyed (surface))
		return;

	if (self->pen_down)
	{
		gdk_surface_set_input_region (surface, NULL);
		annotations_surface_input_region_commit (surface);
		/* Expanding the input region from dock-only to the full surface can make
		 * some compositors / WMs re-evaluate stacking; keep the overlay on top. */
		annotations_window_reassert_above (self);
		return;
	}

	if (!dock_input_rect_surface (self, surface, &dock_rect))
	{
		/* NULL = full-surface input and blocks pass-through; avoid that while waiting
		 * for dock layout if the user asked for mouse-through. */
		if (self->pass_mouse_through_canvas)
		{
			g_idle_add (annotations_input_region_retry_cb, self);
			return;
		}
		gdk_surface_set_input_region (surface, NULL);
		annotations_surface_input_region_commit (surface);
		return;
	}

	merge_canvas_wayland = FALSE;
#if defined(GDK_WINDOWING_WAYLAND)
	/* Without gtk4-layer-shell, GNOME Wayland often routes the stylus like the core
	 * pointer. Unioning the canvas avoids stray presses on the window below; the user
	 * can enable "Mouse through canvas" in the dock to use dock-only input instead. */
	merge_canvas_wayland = !self->stacking_layer_shell && GDK_IS_WAYLAND_DISPLAY (display)
	                       && !self->pass_mouse_through_canvas;
#endif

	region = cairo_region_create ();
	cairo_region_union_rectangle (region, &dock_rect);
	canvas_merged = merge_canvas_wayland && canvas_input_rect_surface (self, surface, &canvas_rect);
	if (canvas_merged)
		cairo_region_union_rectangle (region, &canvas_rect);

	gdk_surface_set_input_region (surface, region);
	cairo_region_destroy (region);
	annotations_surface_input_region_commit (surface);

#if defined(GDK_WINDOWING_WAYLAND)
	/* Clicks pass through to clients below, which can take activation and raise above us;
	 * nudge the compositor to keep this overlay stacked for annotation. */
	if (!self->suppress_wayland_restack && !self->stacking_layer_shell
	    && GDK_IS_WAYLAND_DISPLAY (display) && self->pass_mouse_through_canvas
	    && !self->pen_down)
		annotations_wayland_schedule_restack (self);
#endif
}

static gboolean
annotations_input_region_retry_cb (gpointer user_data)
{
	annotations_input_region_schedule (ANNOTATIONS_WINDOW (user_data));
	return G_SOURCE_REMOVE;
}

static gboolean
annotations_input_region_idle_cb (gpointer user_data)
{
	AnnotationsWindow *self = user_data;

	self->input_region_idle = 0;
	annotations_input_region_apply (self);
	return G_SOURCE_REMOVE;
}

static void
annotations_input_region_schedule (AnnotationsWindow *self)
{
	if (!gtk_widget_get_realized (GTK_WIDGET (self)))
		return;

	if (!gdk_display_supports_input_shapes (gtk_widget_get_display (GTK_WIDGET (self))))
		return;

	if (self->input_region_idle != 0)
		g_source_remove (self->input_region_idle);

	self->input_region_idle = g_idle_add (annotations_input_region_idle_cb, self);
}

static void
annotations_window_setup_stacking (AnnotationsWindow *self)
{
	self->stacking_layer_shell = FALSE;

#ifdef HAVE_GTK4_LAYER_SHELL
	if (gtk_layer_is_supported ())
	{
		GtkWindow *win = GTK_WINDOW (self);

		gtk_layer_init_for_window (win);
		gtk_layer_set_namespace (win, "annotations");
		gtk_layer_set_layer (win, GTK_LAYER_SHELL_LAYER_OVERLAY);
		gtk_layer_set_exclusive_zone (win, 0);
		gtk_layer_set_keyboard_mode (win, GTK_LAYER_SHELL_KEYBOARD_MODE_NONE);
		gtk_layer_set_anchor (win, GTK_LAYER_SHELL_EDGE_TOP, TRUE);
		gtk_layer_set_anchor (win, GTK_LAYER_SHELL_EDGE_BOTTOM, TRUE);
		gtk_layer_set_anchor (win, GTK_LAYER_SHELL_EDGE_LEFT, TRUE);
		gtk_layer_set_anchor (win, GTK_LAYER_SHELL_EDGE_RIGHT, TRUE);
		self->stacking_layer_shell = TRUE;
		return;
	}
#endif
	gtk_window_maximize (GTK_WINDOW (self));
}

#if defined(GDK_WINDOWING_X11)
static void
annotations_x11_net_wm_state_above (AnnotationsWindow *self)
{
	GdkDisplay *gdisp;
	GtkNative *native;
	GdkSurface *surface;
	Display *xdpy;
	Window xroot, xwin;
	Atom net_wm_state, net_wm_state_above;
	XClientMessageEvent ev;

	gdisp = gtk_widget_get_display (GTK_WIDGET (self));
	if (!GDK_IS_X11_DISPLAY (gdisp))
		return;

	native = gtk_widget_get_native (GTK_WIDGET (self));
	if (native == NULL)
		return;

	surface = gtk_native_get_surface (native);
	if (surface == NULL || !GDK_IS_X11_SURFACE (surface))
		return;

	xdpy = gdk_x11_display_get_xdisplay (GDK_X11_DISPLAY (gdisp));
	xroot = gdk_x11_display_get_xrootwindow (gdisp);
	xwin = gdk_x11_surface_get_xid (surface);

	net_wm_state = XInternAtom (xdpy, "_NET_WM_STATE", False);
	net_wm_state_above = XInternAtom (xdpy, "_NET_WM_STATE_ABOVE", False);

	memset (&ev, 0, sizeof (ev));
	ev.type = ClientMessage;
	ev.send_event = True;
	ev.display = xdpy;
	ev.window = xwin;
	ev.message_type = net_wm_state;
	ev.format = 32;
	ev.data.l[0] = 1; /* _NET_WM_STATE_ADD */
	ev.data.l[1] = net_wm_state_above;
	ev.data.l[2] = 0;

	gdk_x11_display_error_trap_push (gdisp);
	XSendEvent (xdpy, xroot, False,
	            SubstructureNotifyMask | SubstructureRedirectMask,
	            (XEvent *) &ev);
	gdk_x11_display_error_trap_pop_ignored (gdisp);
	gdk_display_flush (gdisp);
}
#endif

static void
annotations_window_reassert_above (AnnotationsWindow *self)
{
	GdkDisplay *d;

	if (self->stacking_layer_shell)
		return;

	d = gtk_widget_get_display (GTK_WIDGET (self));
	if (d == NULL)
		return;

#if defined(GDK_WINDOWING_X11)
	if (GDK_IS_X11_DISPLAY (d))
		annotations_x11_net_wm_state_above (self);
#endif
}

#if defined(GDK_WINDOWING_WAYLAND)
static gboolean
annotations_wayland_reapply_input_idle_cb (gpointer user_data)
{
	AnnotationsWindow *self = user_data;

	self->wayland_reapply_idle = 0;

	if (self->stacking_layer_shell || !self->pass_mouse_through_canvas)
		return G_SOURCE_REMOVE;

	self->suppress_wayland_restack = TRUE;
	annotations_input_region_apply (self);
	self->suppress_wayland_restack = FALSE;
	return G_SOURCE_REMOVE;
}

static gboolean
annotations_wayland_restack_idle_cb (gpointer user_data)
{
	AnnotationsWindow *self = user_data;
	GtkNative *native;
	GdkSurface *surface;

	self->wayland_restack_idle = 0;

	if (self->stacking_layer_shell || !self->pass_mouse_through_canvas)
		return G_SOURCE_REMOVE;

	native = gtk_widget_get_native (GTK_WIDGET (self));
	if (native == NULL)
		return G_SOURCE_REMOVE;

	surface = gtk_native_get_surface (native);
	if (surface == NULL || gdk_surface_is_destroyed (surface))
		return G_SOURCE_REMOVE;

	if (!GDK_IS_WAYLAND_SURFACE (surface))
		return G_SOURCE_REMOVE;

	/* gdk_toplevel_present requires a non-NULL layout. It can reset the compositor
	 * input region; re-apply dock-only on the *next* idle so it wins after the commit. */
	{
		g_autoptr (GdkToplevelLayout) layout = NULL;

		layout = gdk_toplevel_layout_new ();
		gdk_toplevel_layout_set_maximized (layout, TRUE);
		gdk_toplevel_present (GDK_TOPLEVEL (surface), layout);
	}

	if (self->wayland_reapply_idle != 0)
		g_source_remove (self->wayland_reapply_idle);
	self->wayland_reapply_idle = g_idle_add (annotations_wayland_reapply_input_idle_cb, self);
	return G_SOURCE_REMOVE;
}

static void
annotations_wayland_schedule_restack (AnnotationsWindow *self)
{
	GdkDisplay *d;

	if (self->stacking_layer_shell || !self->pass_mouse_through_canvas)
		return;

	d = gtk_widget_get_display (GTK_WIDGET (self));
	if (d == NULL || !GDK_IS_WAYLAND_DISPLAY (d))
		return;

	if (self->wayland_restack_idle != 0)
		return;

	self->wayland_restack_idle = g_idle_add (annotations_wayland_restack_idle_cb, self);
}
#endif

static void
on_window_mapped (GtkWidget *widget, gpointer user_data)
{
	AnnotationsWindow *self = user_data;

	(void) widget;

#if defined(GDK_WINDOWING_X11)
	if (!self->stacking_layer_shell)
		annotations_x11_net_wm_state_above (self);
#endif
	annotations_input_region_schedule (self);
}

static void
on_notify_is_active (GObject *object, GParamSpec *pspec, gpointer user_data)
{
	AnnotationsWindow *self = ANNOTATIONS_WINDOW (object);

	(void) pspec;
	(void) user_data;

	if (gtk_window_is_active (GTK_WINDOW (self)))
		return;
	if (!self->pass_mouse_through_canvas || self->stacking_layer_shell)
		return;

#if defined(GDK_WINDOWING_WAYLAND)
	{
		GdkDisplay *d = gtk_widget_get_display (GTK_WIDGET (self));

		if (d != NULL && GDK_IS_WAYLAND_DISPLAY (d))
			annotations_wayland_schedule_restack (self);
	}
#endif
}

static void
widget_strip_rec_focus (GtkWidget *widget)
{
	GtkWidget *child;

	gtk_widget_set_can_focus (widget, FALSE);
	gtk_widget_set_focusable (widget, FALSE);

	for (child = gtk_widget_get_first_child (widget);
	     child != NULL;
	     child = gtk_widget_get_next_sibling (child))
		widget_strip_rec_focus (child);
}

static void
dock_clamp_margins (AnnotationsWindow *self)
{
	gint w, h, dw, dh, max_x, max_y;

	if (self->floating_dock == NULL || self->content_overlay == NULL)
		return;

	w = gtk_widget_get_width (GTK_WIDGET (self->content_overlay));
	h = gtk_widget_get_height (GTK_WIDGET (self->content_overlay));
	dw = gtk_widget_get_width (self->floating_dock);
	dh = gtk_widget_get_height (self->floating_dock);

	if (w <= 0 || h <= 0 || dw <= 0 || dh <= 0)
		return;

	max_x = MAX (0, w - dw);
	max_y = MAX (0, h - dh);

	self->dock_margin_x = CLAMP (self->dock_margin_x, 0, max_x);
	self->dock_margin_y = CLAMP (self->dock_margin_y, 0, max_y);

	gtk_widget_set_margin_start (self->floating_dock, self->dock_margin_x);
	gtk_widget_set_margin_top (self->floating_dock, self->dock_margin_y);

	annotations_input_region_schedule (self);
}

static void
on_dock_drag_begin (GtkGestureDrag *gesture,
                    gdouble         start_x,
                    gdouble         start_y,
                    gpointer        user_data)
{
	AnnotationsWindow *self = user_data;
	GtkWidget *gesture_widget;
	graphene_point_t in;
	graphene_point_t out;

	gesture_widget = gtk_event_controller_get_widget (GTK_EVENT_CONTROLLER (gesture));

	graphene_point_init (&in, start_x, start_y);
	if (!gtk_widget_compute_point (gesture_widget,
	                                GTK_WIDGET (self->content_overlay),
	                                &in, &out))
		return;

	self->dock_ptr_overlay_x0 = out.x;
	self->dock_ptr_overlay_y0 = out.y;
	self->dock_gesture_dragging = TRUE;
	self->dock_drag_start_mx = self->dock_margin_x;
	self->dock_drag_start_my = self->dock_margin_y;
	dock_clear_idle_timer (self);
}

static void
on_dock_drag_update (GtkGestureDrag *gesture,
                     gdouble          offset_x,
                     gdouble          offset_y,
                     gpointer         user_data)
{
	AnnotationsWindow *self = user_data;
	GtkWidget *gesture_widget;
	gdouble lx, ly;
	graphene_point_t in;
	graphene_point_t out;
	gint nx, ny;
	gint w, h, dw, dh, max_x, max_y;

	(void) offset_x;
	(void) offset_y;

	gesture_widget = gtk_event_controller_get_widget (GTK_EVENT_CONTROLLER (gesture));

	if (!gtk_gesture_get_point (GTK_GESTURE (gesture), NULL, &lx, &ly))
		return;

	graphene_point_init (&in, lx, ly);
	if (!gtk_widget_compute_point (gesture_widget,
	                                GTK_WIDGET (self->content_overlay),
	                                &in, &out))
		return;

	w = gtk_widget_get_width (GTK_WIDGET (self->content_overlay));
	h = gtk_widget_get_height (GTK_WIDGET (self->content_overlay));
	dw = gtk_widget_get_width (self->floating_dock);
	dh = gtk_widget_get_height (self->floating_dock);

	if (w <= 0 || h <= 0 || dw <= 0 || dh <= 0)
		return;

	max_x = MAX (0, w - dw);
	max_y = MAX (0, h - dh);

	nx = (gint) (self->dock_drag_start_mx + (out.x - self->dock_ptr_overlay_x0) + 0.5);
	ny = (gint) (self->dock_drag_start_my + (out.y - self->dock_ptr_overlay_y0) + 0.5);

	self->dock_margin_x = CLAMP (nx, 0, max_x);
	self->dock_margin_y = CLAMP (ny, 0, max_y);

	gtk_widget_set_margin_start (self->floating_dock, self->dock_margin_x);
	gtk_widget_set_margin_top (self->floating_dock, self->dock_margin_y);

	annotations_input_region_schedule (self);
}

static void
on_dock_drag_end (GtkGestureDrag *gesture,
                  gdouble          offset_x,
                  gdouble          offset_y,
                  gpointer         user_data)
{
	AnnotationsWindow *self = user_data;

	(void) gesture;
	(void) offset_x;
	(void) offset_y;

	self->dock_gesture_dragging = FALSE;
	if (self->dock_tools_open)
		dock_reset_idle_timer (self);
}

static void
attach_dock_drag (AnnotationsWindow *self, GtkWidget *widget)
{
	GtkGesture *drag;

	drag = GTK_GESTURE (gtk_gesture_drag_new ());
	gtk_gesture_single_set_button (GTK_GESTURE_SINGLE (drag), GDK_BUTTON_PRIMARY);
	g_signal_connect (drag, "drag-begin", G_CALLBACK (on_dock_drag_begin), self);
	g_signal_connect (drag, "drag-update", G_CALLBACK (on_dock_drag_update), self);
	g_signal_connect (drag, "drag-end", G_CALLBACK (on_dock_drag_end), self);
	gtk_widget_add_controller (widget, GTK_EVENT_CONTROLLER (drag));
}

static void
pen_color_apply (AnnotationsWindow *self, guint index, GtkWidget *swatch)
{
	g_return_if_fail (index < G_N_ELEMENTS (pen_choices));

	if (!gdk_rgba_parse (&self->pen_color, pen_choices[index].hex))
		gdk_rgba_parse (&self->pen_color, "#1a1a1a");

	if (self->selected_swatch != NULL)
		gtk_widget_remove_css_class (self->selected_swatch, "anno-swatch-selected");

	self->selected_swatch = swatch;
	gtk_widget_add_css_class (swatch, "anno-swatch-selected");
	dock_reset_idle_timer (self);
}

static void
on_swatch_released (GtkGestureClick *gesture,
                    gint              n_press,
                    gdouble           x,
                    gdouble           y,
                    gpointer          user_data)
{
	AnnotationsWindow *self;
	GdkEvent *event;
	GtkWidget *swatch;
	guint index;

	(void) n_press;
	(void) x;
	(void) y;

	event = gtk_event_controller_get_current_event (GTK_EVENT_CONTROLLER (gesture));
	if (event == NULL || !event_is_stylus_device (event))
		return;

	swatch = gtk_event_controller_get_widget (GTK_EVENT_CONTROLLER (gesture));
	self = g_object_get_data (G_OBJECT (swatch), "anno-window");
	g_return_if_fail (ANNOTATIONS_IS_WINDOW (self));

	index = GPOINTER_TO_UINT (user_data);
	pen_color_apply (self, index, swatch);
}

static void
on_clear_pen_double_pressed (GtkGestureClick *gesture,
                             gint              n_press,
                             gdouble           x,
                             gdouble           y,
                             gpointer          user_data)
{
	AnnotationsWindow *self = user_data;
	GdkEvent *event;

	(void) x;
	(void) y;

	if (n_press != 2)
		return;

	event = gtk_event_controller_get_current_event (GTK_EVENT_CONTROLLER (gesture));
	if (event == NULL || !event_is_stylus_device (event))
		return;

	perform_clear_all (self);
	dock_reset_idle_timer (self);
}

static void
on_collapsed_chip_released (GtkGestureClick *gesture,
                            gint              n_press,
                            gdouble           x,
                            gdouble           y,
                            gpointer          user_data)
{
	AnnotationsWindow *self = user_data;
	GdkEvent *event;

	(void) gesture;
	(void) n_press;
	(void) x;
	(void) y;

	event = gtk_event_controller_get_current_event (GTK_EVENT_CONTROLLER (gesture));
	if (event == NULL || !event_is_stylus_device (event))
		return;

	dock_open_tools (self);
}

static void
on_pass_mouse_through_active_notify (GObject *object, GParamSpec *pspec, gpointer user_data)
{
	AnnotationsWindow *self = user_data;
	AdwSwitchRow *sr = ADW_SWITCH_ROW (object);
	gboolean on;
	gboolean was;

	(void) pspec;
	was = self->pass_mouse_through_canvas;
	on = adw_switch_row_get_active (sr);
	self->pass_mouse_through_canvas = on;

	adw_action_row_set_subtitle (ADW_ACTION_ROW (sr),
	                             on
	                             ? _("Mouse clicks pass through the canvas. Turn off if the pen misses.")
	                             : _("Canvas captures input for reliable pen strokes."));

	if (was != on)
	{
		AdwToast *toast;

		toast = adw_toast_new (on
		                       ? _("Pass-through on")
		                       : _("Pen priority on"));
		adw_toast_set_timeout (toast, 2);
		adw_toast_overlay_add_toast (self->toast_overlay, toast);
	}

	/* Idle so we avoid re-entering surface updates during the notify emission. */
	annotations_input_region_schedule (self);
}

static void
setup_floating_dock (AnnotationsWindow *self)
{
	GtkWidget *shell;
	GtkWidget *outer_expanded;
	GtkWidget *handle;
	GtkWidget *swatch_col;
	GtkWidget *clear_box;
	GtkWidget *clear_lbl;
	GtkWidget *collapsed;
	GtkWidget *chip_lbl;
	GtkGesture *exp_click;
	guint i;
#if defined(GDK_WINDOWING_WAYLAND)
	gboolean show_mouse_through_toggle;
#endif

	self->dock_margin_x = 10;
	self->dock_margin_y = 10;
	self->dock_idle_source = 0;
	self->dock_tools_open = TRUE;
	self->dock_gesture_dragging = FALSE;

	shell = gtk_box_new (GTK_ORIENTATION_VERTICAL, 0);
	self->floating_dock = shell;
	gtk_widget_add_css_class (shell, "anno-dock-shell");
	gtk_widget_set_halign (shell, GTK_ALIGN_START);
	gtk_widget_set_valign (shell, GTK_ALIGN_START);
	gtk_widget_set_margin_start (shell, self->dock_margin_x);
	gtk_widget_set_margin_top (shell, self->dock_margin_y);
	gtk_widget_set_can_target (shell, TRUE);

	outer_expanded = gtk_box_new (GTK_ORIENTATION_VERTICAL, 5);
	self->dock_expanded = outer_expanded;

	handle = gtk_box_new (GTK_ORIENTATION_HORIZONTAL, 0);
	gtk_widget_add_css_class (handle, "anno-drag-handle");
	gtk_widget_set_tooltip_text (handle, _("Drag to move"));
	gtk_box_append (GTK_BOX (outer_expanded), handle);
	attach_dock_drag (self, handle);

	swatch_col = gtk_box_new (GTK_ORIENTATION_VERTICAL, 4);
	gtk_box_append (GTK_BOX (outer_expanded), swatch_col);

	for (i = 0; i < G_N_ELEMENTS (pen_choices); i++)
	{
		GtkWidget *swatch;
		GtkGesture *click;
		GdkRGBA rgba;

		swatch = gtk_box_new (GTK_ORIENTATION_VERTICAL, 0);
		gtk_widget_add_css_class (swatch, "anno-swatch");
		gtk_widget_add_css_class (swatch, pen_choices[i].css_class);
		gtk_accessible_update_property (GTK_ACCESSIBLE (swatch),
		                                GTK_ACCESSIBLE_PROPERTY_LABEL,
		                                _(pen_choices[i].a11y_label),
		                                -1);
		gtk_widget_set_can_target (swatch, TRUE);
		g_object_set_data (G_OBJECT (swatch), "anno-window", self);
		gtk_box_append (GTK_BOX (swatch_col), swatch);

		click = gtk_gesture_click_new ();
		gtk_gesture_single_set_button (GTK_GESTURE_SINGLE (click), GDK_BUTTON_PRIMARY);
		g_signal_connect (click, "released", G_CALLBACK (on_swatch_released), GUINT_TO_POINTER (i));
		gtk_widget_add_controller (swatch, GTK_EVENT_CONTROLLER (click));

		if (gdk_rgba_parse (&rgba, pen_choices[i].hex) &&
		    gdk_rgba_equal (&rgba, &self->pen_color))
		{
			self->selected_swatch = swatch;
			gtk_widget_add_css_class (swatch, "anno-swatch-selected");
		}
	}

	if (self->selected_swatch == NULL)
	{
		GtkWidget *first = gtk_widget_get_first_child (swatch_col);

		if (first != NULL)
		{
			self->selected_swatch = first;
			gtk_widget_add_css_class (first, "anno-swatch-selected");
		}
	}

#if defined(GDK_WINDOWING_WAYLAND)
	{
		GdkDisplay *disp = gtk_widget_get_display (GTK_WIDGET (self));

		show_mouse_through_toggle = disp != NULL && GDK_IS_WAYLAND_DISPLAY (disp)
		                            && !self->stacking_layer_shell;
	}
#else
# define show_mouse_through_toggle FALSE
#endif
	if (show_mouse_through_toggle)
	{
		GtkWidget *sw_row;

		self->pass_mouse_through_canvas = FALSE;

		sw_row = adw_switch_row_new ();
		adw_preferences_row_set_title (ADW_PREFERENCES_ROW (sw_row),
		                               _("Mouse through canvas"));
		adw_action_row_set_subtitle (ADW_ACTION_ROW (sw_row),
		                             _("Canvas captures input for reliable pen strokes."));
		gtk_widget_set_tooltip_text (
			sw_row,
			_("Send mouse clicks through the drawing area to windows below. "
			  "Turn off for the most reliable pen input on Wayland."));
		adw_switch_row_set_active (ADW_SWITCH_ROW (sw_row), FALSE);
		gtk_box_append (GTK_BOX (outer_expanded), sw_row);
		g_signal_connect_data (sw_row, "notify::active",
		                       G_CALLBACK (on_pass_mouse_through_active_notify),
		                       self, NULL,
		                       G_CONNECT_AFTER);
	}

	clear_box = gtk_box_new (GTK_ORIENTATION_VERTICAL, 0);
	gtk_widget_add_css_class (clear_box, "anno-clear-zone");
	gtk_widget_set_tooltip_text (clear_box, _("Double-tap with pen to clear all strokes"));
	clear_lbl = gtk_label_new (_("Clear"));
	gtk_widget_add_css_class (clear_lbl, "anno-clear-label");
	gtk_box_append (GTK_BOX (clear_box), clear_lbl);

	{
		GtkGesture *clear_gesture;

		clear_gesture = gtk_gesture_click_new ();
		gtk_gesture_single_set_button (GTK_GESTURE_SINGLE (clear_gesture), GDK_BUTTON_PRIMARY);
		g_signal_connect (clear_gesture, "pressed", G_CALLBACK (on_clear_pen_double_pressed), self);
		gtk_widget_add_controller (clear_box, GTK_EVENT_CONTROLLER (clear_gesture));
	}

	gtk_box_append (GTK_BOX (outer_expanded), clear_box);

	gtk_box_append (GTK_BOX (shell), outer_expanded);

	collapsed = gtk_box_new (GTK_ORIENTATION_VERTICAL, 0);
	self->dock_collapsed = collapsed;
	gtk_widget_add_css_class (collapsed, "anno-dock-collapsed");
	gtk_widget_set_visible (collapsed, FALSE);
	chip_lbl = gtk_label_new ("⋯");
	gtk_widget_add_css_class (chip_lbl, "title-2");
	gtk_box_append (GTK_BOX (collapsed), chip_lbl);
	gtk_widget_set_tooltip_text (collapsed, _("Show tools"));

	exp_click = gtk_gesture_click_new ();
	gtk_gesture_single_set_button (GTK_GESTURE_SINGLE (exp_click), GDK_BUTTON_PRIMARY);
	g_signal_connect (exp_click, "released", G_CALLBACK (on_collapsed_chip_released), self);
	gtk_widget_add_controller (collapsed, GTK_EVENT_CONTROLLER (exp_click));
	attach_dock_drag (self, collapsed);

	gtk_box_append (GTK_BOX (shell), collapsed);

	gtk_overlay_add_overlay (GTK_OVERLAY (self->content_overlay), shell);
	gtk_overlay_set_clip_overlay (GTK_OVERLAY (self->content_overlay), shell, FALSE);

	g_signal_connect (self->content_overlay, "notify::width", G_CALLBACK (on_overlay_resize), self);
	g_signal_connect (self->content_overlay, "notify::height", G_CALLBACK (on_overlay_resize), self);

	dock_reset_idle_timer (self);
	g_idle_add_once ((GSourceOnceFunc) dock_clamp_margins, self);
}

static gdouble
point_segment_dist_sq (gdouble px,
                       gdouble py,
                       gdouble ax,
                       gdouble ay,
                       gdouble bx,
                       gdouble by)
{
	gdouble abx, aby, apx, apy, ab_len_sq, t;
	gdouble cx, cy, dx, dy;

	abx = bx - ax;
	aby = by - ay;
	apx = px - ax;
	apy = py - ay;
	ab_len_sq = abx * abx + aby * aby;
	if (ab_len_sq < 1e-18)
	{
		dx = px - ax;
		dy = py - ay;
		return dx * dx + dy * dy;
	}

	t = (apx * abx + apy * aby) / ab_len_sq;
	if (t < 0.0)
		t = 0.0;
	else if (t > 1.0)
		t = 1.0;

	cx = ax + t * abx;
	cy = ay + t * aby;
	dx = px - cx;
	dy = py - cy;
	return dx * dx + dy * dy;
}

static gdouble
point_to_polyline_dist_sq (gdouble px, gdouble py, AnnoStroke *path)
{
	AnnoPoint *pts;
	guint n;
	gdouble best;
	guint i;

	if (path == NULL || path->points == NULL)
		return G_MAXDOUBLE;

	n = path->points->len;
	if (n == 0)
		return G_MAXDOUBLE;

	pts = (AnnoPoint *) path->points->data;
	if (n == 1)
	{
		gdouble dx = px - pts[0].x;
		gdouble dy = py - pts[0].y;
		return dx * dx + dy * dy;
	}

	best = G_MAXDOUBLE;
	for (i = 0; i + 1 < n; i++)
	{
		gdouble d;

		d = point_segment_dist_sq (px, py,
		                           pts[i].x, pts[i].y,
		                           pts[i + 1].x, pts[i + 1].y);
		if (d < best)
			best = d;
	}

	return best;
}

static gboolean
stroke_hit_by_eraser (AnnoStroke *stroke, AnnoStroke *eraser, gdouble radius_sq)
{
	AnnoPoint *spts, *epts;
	guint sn, en;
	guint i, j;

	if (stroke == NULL || eraser == NULL || eraser->points->len == 0)
		return FALSE;

	sn = stroke->points->len;
	en = eraser->points->len;
	spts = (AnnoPoint *) stroke->points->data;
	epts = (AnnoPoint *) eraser->points->data;

	for (i = 0; i < sn; i++)
	{
		if (point_to_polyline_dist_sq (spts[i].x, spts[i].y, eraser) <= radius_sq)
			return TRUE;
	}

	for (j = 0; j < en; j++)
	{
		if (point_to_polyline_dist_sq (epts[j].x, epts[j].y, stroke) <= radius_sq)
			return TRUE;
	}

	return FALSE;
}

static void
strokes_apply_eraser (AnnotationsWindow *self, AnnoStroke *eraser)
{
	const gdouble erase_radius = 10.0;
	gdouble radius_sq;

	if (self->strokes == NULL || eraser == NULL)
		return;

	radius_sq = erase_radius * erase_radius;

	for (gint i = (gint) self->strokes->len - 1; i >= 0; i--)
	{
		AnnoStroke *stroke = g_ptr_array_index (self->strokes, i);

		if (stroke_hit_by_eraser (stroke, eraser, radius_sq))
			g_ptr_array_remove_index (self->strokes, (guint) i);
	}
}

static void
eraser_apply_live (AnnotationsWindow *self)
{
	if (!self->erasing || self->eraser_path == NULL)
		return;

	if (self->eraser_path->points->len == 0)
		return;

	strokes_apply_eraser (self, self->eraser_path);
}

static void
draw_stroke (cairo_t *cr, AnnoStroke *stroke)
{
	AnnoPoint *pts;
	guint n;
	gdouble r;
	guint i;

	if (stroke == NULL || stroke->points == NULL)
		return;

	n = stroke->points->len;
	if (n == 0)
		return;

	gdk_cairo_set_source_rgba (cr, &stroke->ink);

	pts = (AnnoPoint *) stroke->points->data;
	if (n == 1)
	{
		r = 0.5 * pressure_to_line_width (pts[0].pressure);
		if (r < 0.5)
			r = 0.5;
		cairo_arc (cr, pts[0].x, pts[0].y, r, 0, 2 * G_PI);
		cairo_fill (cr);
		return;
	}

	cairo_set_line_cap (cr, CAIRO_LINE_CAP_ROUND);
	cairo_set_line_join (cr, CAIRO_LINE_JOIN_ROUND);

	for (i = 0; i + 1 < n; i++)
	{
		gdouble w;

		w = 0.5 * (pressure_to_line_width (pts[i].pressure) +
		          pressure_to_line_width (pts[i + 1].pressure));
		cairo_set_line_width (cr, w);
		cairo_move_to (cr, pts[i].x, pts[i].y);
		cairo_line_to (cr, pts[i + 1].x, pts[i + 1].y);
		cairo_stroke (cr);
	}
}

static void
on_canvas_draw (GtkDrawingArea *area,
                cairo_t        *cr,
                int             width,
                int             height,
                gpointer        user_data)
{
	AnnotationsWindow *self = user_data;

	(void) area;
	(void) width;
	(void) height;

	cairo_save (cr);
	cairo_set_operator (cr, CAIRO_OPERATOR_CLEAR);
	cairo_paint (cr);
	cairo_restore (cr);

	cairo_set_operator (cr, CAIRO_OPERATOR_OVER);

	for (guint s = 0; self->strokes != NULL && s < self->strokes->len; s++)
		draw_stroke (cr, g_ptr_array_index (self->strokes, s));

	if (self->current_stroke != NULL)
		draw_stroke (cr, self->current_stroke);
}

static void
stroke_append_point (AnnoStroke *stroke, gdouble x, gdouble y, gdouble pressure)
{
	AnnoPoint p;

	p.x = x;
	p.y = y;
	p.pressure = pressure;
	g_array_append_val (stroke->points, p);
}

static void
on_canvas_motion (GtkEventControllerMotion *motion,
                  gdouble                   x,
                  gdouble                   y,
                  gpointer                  user_data)
{
	AnnotationsWindow *self = user_data;
	GdkEvent *event;

	if (!self->pen_down)
		return;

	event = gtk_event_controller_get_current_event (GTK_EVENT_CONTROLLER (motion));
	if (event == NULL || !event_is_stylus_device (event))
		return;

	if (self->erasing)
	{
		if (self->active_kind != STYLUS_ERASE || self->eraser_path == NULL)
			return;
		stroke_append_point (self->eraser_path, x, y, 0.0);
		eraser_apply_live (self);
	}
	else
	{
		if (self->active_kind != STYLUS_DRAW || self->current_stroke == NULL)
			return;
		stroke_append_point (self->current_stroke, x, y, event_get_pressure (event));
	}

	gtk_widget_queue_draw (GTK_WIDGET (self->canvas));
}

static void
commit_current_draw (AnnotationsWindow *self)
{
	if (self->current_stroke == NULL)
		return;

	if (self->current_stroke->points->len > 0)
	{
		AnnoStroke *finished;

		finished = self->current_stroke;
		self->current_stroke = NULL;
		g_ptr_array_add (self->strokes, finished);
	}
	else
		g_clear_pointer (&self->current_stroke, anno_stroke_free);
}

static void
on_canvas_press (GtkGestureClick *gesture,
                 gint             n_press,
                 gdouble          x,
                 gdouble          y,
                 gpointer         user_data)
{
	AnnotationsWindow *self = user_data;
	GdkEvent *event;
	StylusKind kind;

	event = gtk_event_controller_get_current_event (GTK_EVENT_CONTROLLER (gesture));
	kind = event_stylus_kind (event, GTK_GESTURE (gesture));
	if (kind == STYLUS_NONE)
		return;

	if (kind == STYLUS_ERASE)
	{
		if (self->pen_down && self->erasing)
		{
			stroke_append_point (self->eraser_path, x, y, 0.0);
			eraser_apply_live (self);
			gtk_widget_queue_draw (GTK_WIDGET (self->canvas));
			goto input_region_sync;
		}

		if (self->pen_down && self->current_stroke != NULL)
			commit_current_draw (self);

		self->eraser_path = anno_stroke_new ();
		stroke_append_point (self->eraser_path, x, y, 0.0);
		self->erasing = TRUE;
		self->active_kind = STYLUS_ERASE;
		self->pen_down = TRUE;
		eraser_apply_live (self);
		gtk_widget_queue_draw (GTK_WIDGET (self->canvas));
		goto input_region_sync;
	}

	/* STYLUS_DRAW */
	if (self->pen_down && self->erasing && self->eraser_path != NULL)
	{
		strokes_apply_eraser (self, self->eraser_path);
		g_clear_pointer (&self->eraser_path, anno_stroke_free);
		self->erasing = FALSE;
		self->pen_down = FALSE;
	}

	if (self->pen_down && self->current_stroke != NULL)
		commit_current_draw (self);

	self->current_stroke = anno_stroke_new ();
	self->current_stroke->ink = self->pen_color;
	stroke_append_point (self->current_stroke, x, y, event_get_pressure (event));
	self->erasing = FALSE;
	self->active_kind = STYLUS_DRAW;
	self->pen_down = TRUE;
	gtk_widget_queue_draw (GTK_WIDGET (self->canvas));

input_region_sync:
	annotations_input_region_apply (self);
}

static void
on_canvas_release (GtkGestureClick *gesture,
                   gint              n_press,
                   gdouble           x,
                   gdouble           y,
                   gpointer          user_data)
{
	AnnotationsWindow *self = user_data;

	if (!self->pen_down)
		return;

	if (self->erasing && self->eraser_path != NULL)
	{
		strokes_apply_eraser (self, self->eraser_path);
		g_clear_pointer (&self->eraser_path, anno_stroke_free);
		self->erasing = FALSE;
		self->active_kind = STYLUS_NONE;
		self->pen_down = FALSE;
		gtk_widget_queue_draw (GTK_WIDGET (self->canvas));
		annotations_input_region_apply (self);
		return;
	}

	if (self->current_stroke != NULL)
	{
		if (self->current_stroke->points->len > 0)
		{
			AnnoStroke *finished;

			finished = self->current_stroke;
			self->current_stroke = NULL;
			g_ptr_array_add (self->strokes, finished);
		}
		else
			g_clear_pointer (&self->current_stroke, anno_stroke_free);
	}

	self->active_kind = STYLUS_NONE;
	self->pen_down = FALSE;
	gtk_widget_queue_draw (GTK_WIDGET (self->canvas));
	annotations_input_region_apply (self);
}

static void
annotations_window_class_init (AnnotationsWindowClass *klass)
{
	GObjectClass *object_class = G_OBJECT_CLASS (klass);
	GtkWidgetClass *widget_class = GTK_WIDGET_CLASS (klass);

	object_class->dispose = annotations_window_dispose;

	gtk_widget_class_set_template_from_resource (widget_class, "/com/github/eochis23/annotations/annotations-window.ui");
	gtk_widget_class_bind_template_child (widget_class, AnnotationsWindow, content_overlay);
	gtk_widget_class_bind_template_child (widget_class, AnnotationsWindow, toast_overlay);
	gtk_widget_class_bind_template_child (widget_class, AnnotationsWindow, main_header);
	gtk_widget_class_bind_template_child (widget_class, AnnotationsWindow, canvas);

	dock_css_register_once ();
	transparent_window_css_register_once ();
}

static void
annotations_window_init (AnnotationsWindow *self)
{
	GtkGesture *press_primary;
	GtkGesture *press_secondary;
	GtkEventController *motion;

	gtk_widget_init_template (GTK_WIDGET (self));

	gtk_window_set_focus_visible (GTK_WINDOW (self), FALSE);

	gtk_widget_set_name (GTK_WIDGET (self), "anno-main-window");
	gtk_widget_set_name (GTK_WIDGET (self->content_overlay), "anno-content-root");
	gtk_widget_set_name (GTK_WIDGET (self->canvas), "anno-canvas");

	gtk_widget_add_css_class (GTK_WIDGET (self), "anno-trans-window");
	gtk_widget_add_css_class (GTK_WIDGET (self->content_overlay), "anno-trans-layer");
	gtk_widget_add_css_class (GTK_WIDGET (self->toast_overlay), "anno-trans-layer");
	gtk_widget_add_css_class (GTK_WIDGET (self->canvas), "anno-canvas-clear");

	{
		GtkWidget *toolbar;

		toolbar = gtk_widget_get_ancestor (GTK_WIDGET (self->canvas), ADW_TYPE_TOOLBAR_VIEW);
		if (toolbar != NULL)
			gtk_widget_add_css_class (toolbar, "anno-trans-layer");
	}

	gtk_widget_set_visible (GTK_WIDGET (self->main_header), FALSE);

	/* Borderless surface over the work area; stay above normal windows where the platform allows. */
	gtk_window_set_decorated (GTK_WINDOW (self), FALSE);
	annotations_window_setup_stacking (self);

	if (!gdk_rgba_parse (&self->pen_color, pen_choices[0].hex))
		gdk_rgba_parse (&self->pen_color, "#1a1a1a");
	self->selected_swatch = NULL;

	self->strokes = g_ptr_array_new_full (64, anno_stroke_free);

	setup_floating_dock (self);

	widget_strip_rec_focus (GTK_WIDGET (self));

	g_signal_connect (self, "map", G_CALLBACK (on_window_mapped), self);
	g_signal_connect (self, "notify::is-active", G_CALLBACK (on_notify_is_active), NULL);

	gtk_drawing_area_set_draw_func (self->canvas, on_canvas_draw, self, NULL);

	press_primary = GTK_GESTURE (gtk_gesture_click_new ());
	gtk_gesture_single_set_button (GTK_GESTURE_SINGLE (press_primary), GDK_BUTTON_PRIMARY);
	g_signal_connect (press_primary, "pressed", G_CALLBACK (on_canvas_press), self);
	g_signal_connect (press_primary, "released", G_CALLBACK (on_canvas_release), self);
	gtk_widget_add_controller (GTK_WIDGET (self->canvas), GTK_EVENT_CONTROLLER (press_primary));

	press_secondary = GTK_GESTURE (gtk_gesture_click_new ());
	gtk_gesture_single_set_button (GTK_GESTURE_SINGLE (press_secondary), GDK_BUTTON_SECONDARY);
	g_signal_connect (press_secondary, "pressed", G_CALLBACK (on_canvas_press), self);
	g_signal_connect (press_secondary, "released", G_CALLBACK (on_canvas_release), self);
	gtk_widget_add_controller (GTK_WIDGET (self->canvas), GTK_EVENT_CONTROLLER (press_secondary));

	motion = GTK_EVENT_CONTROLLER (gtk_event_controller_motion_new ());
	g_signal_connect (motion, "motion", G_CALLBACK (on_canvas_motion), self);
	gtk_widget_add_controller (GTK_WIDGET (self->canvas), motion);
}
