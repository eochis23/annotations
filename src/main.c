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
#include <gdk/gdk.h>

#include "annotations-application.h"

int
main (int   argc,
      char *argv[])
{
	g_autoptr(AnnotationsApplication) app = NULL;
	int ret;

	bindtextdomain (GETTEXT_PACKAGE, LOCALEDIR);
	bind_textdomain_codeset (GETTEXT_PACKAGE, "UTF-8");
	textdomain (GETTEXT_PACKAGE);

	/* Optional: ANNOTATIONS_PREFER_X11=1 tries X11 (XWayland) first so _NET_WM_STATE_ABOVE
	 * can stick on some setups; it often breaks Gdk input-shape pass-through to native
	 * Wayland clients, so it is not the default. Set GDK_BACKEND explicitly if needed. */
#if defined(GDK_WINDOWING_X11)
	if (g_getenv ("GDK_BACKEND") == NULL && g_getenv ("ANNOTATIONS_PREFER_X11") != NULL)
		gdk_set_allowed_backends ("x11,wayland,*");
#endif

	app = annotations_application_new ("com.github.eochis23.annotations", G_APPLICATION_DEFAULT_FLAGS);
	ret = g_application_run (G_APPLICATION (app), argc, argv);

	return ret;
}
