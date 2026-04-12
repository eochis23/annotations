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

#include <gdk/gdk.h>
#include <gtk/gtk.h>

#include "annotations-window.h"

typedef struct
{
	gdouble x;
	gdouble y;
	gdouble pressure; /* 0..1 from tablet; 1 if unknown */
} AnnoPoint;

typedef struct
{
	GArray *points; /* AnnoPoint */
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
	AdwToastOverlay     *toast_overlay;
	GtkDrawingArea       *canvas;

	GPtrArray            *strokes;       /* AnnoStroke owned */
	AnnoStroke           *current_stroke;
	AnnoStroke           *eraser_path;
	gboolean              pen_down;
	gboolean              erasing;
	StylusKind            active_kind;
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
	return device != NULL && gdk_device_get_source (device) == GDK_SOURCE_PEN;
}

static StylusKind
event_stylus_kind (GdkEvent *event, GtkGesture *gesture)
{
	GdkDeviceTool *tool;
	guint button;

	if (event == NULL || !event_is_stylus_device (event))
		return STYLUS_NONE;

	button = gtk_gesture_single_get_current_button (GTK_GESTURE_SINGLE (gesture));

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

	if (button == GDK_BUTTON_PRIMARY)
		return STYLUS_DRAW;

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
	GdkRGBA bg, fg;

	if (adw_style_manager_get_dark (adw_style_manager_get_default ()))
		gdk_rgba_parse (&bg, "#242424");
	else
		gdk_rgba_parse (&bg, "#fafafa");

	gtk_widget_get_color (GTK_WIDGET (area), &fg);

	gdk_cairo_set_source_rgba (cr, &bg);
	cairo_paint (cr);

	gdk_cairo_set_source_rgba (cr, &fg);

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
			return;
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
		return;
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
	stroke_append_point (self->current_stroke, x, y, event_get_pressure (event));
	self->erasing = FALSE;
	self->active_kind = STYLUS_DRAW;
	self->pen_down = TRUE;
	gtk_widget_queue_draw (GTK_WIDGET (self->canvas));
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
}

static void
annotations_window_class_init (AnnotationsWindowClass *klass)
{
	GObjectClass *object_class = G_OBJECT_CLASS (klass);
	GtkWidgetClass *widget_class = GTK_WIDGET_CLASS (klass);

	object_class->dispose = annotations_window_dispose;

	gtk_widget_class_set_template_from_resource (widget_class, "/com/github/eochis23/annotations/annotations-window.ui");
	gtk_widget_class_bind_template_child (widget_class, AnnotationsWindow, toast_overlay);
	gtk_widget_class_bind_template_child (widget_class, AnnotationsWindow, canvas);
}

static void
annotations_window_init (AnnotationsWindow *self)
{
	GtkGesture *press_primary;
	GtkGesture *press_secondary;
	GtkEventController *motion;

	gtk_widget_init_template (GTK_WIDGET (self));

	self->strokes = g_ptr_array_new_full (64, anno_stroke_free);

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
