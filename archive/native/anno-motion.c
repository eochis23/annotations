/* SPDX-License-Identifier: GPL-2.0-or-later
 * ROI grey8 matcher: two raw buffers (w*h uint8), integer shift search, JSON stdout.
 * Usage: anno-motion <width> <height> <prev.raw> <cur.raw>
 */
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int
read_raw (const char *path, unsigned char *buf, size_t len)
{
	FILE *f;
	size_t n;

	f = fopen (path, "rb");
	if (f == NULL)
		return -1;
	n = fread (buf, 1, len, f);
	fclose (f);
	return (n == len) ? 0 : -1;
}

/* Sum of squared differences for cur shifted by (sx,sy) relative to prev (prev fixed). */
static double
ssd_shift (const unsigned char *prev,
           const unsigned char *cur,
           int w,
           int h,
           int sx,
           int sy)
{
	double sum = 0.0;
	long count = 0;
	int x, y;

	for (y = 0; y < h; y++)
	{
		int yy = y + sy;
		if (yy < 0 || yy >= h)
			continue;
		for (x = 0; x < w; x++)
		{
			int xx = x + sx;
			if (xx < 0 || xx >= w)
				continue;
			{
				int d = (int) prev[y * w + x] - (int) cur[yy * w + xx];
				sum += (double) d * (double) d;
				count++;
			}
		}
	}
	if (count <= 0)
		return 1e30;
	return sum / (double) count;
}

int
main (int argc, char **argv)
{
	int w, h, m, sx, sy;
	unsigned char *a, *b;
	double best = 1e300, second = 1e300, err;
	int best_sx = 0, best_sy = 0;

	if (argc != 5)
	{
		fprintf (stderr, "usage: %s <width> <height> <prev.raw> <cur.raw>\n", argv[0]);
		return 2;
	}
	w = atoi (argv[1]);
	h = atoi (argv[2]);
	if (w <= 8 || h <= 8 || w > 4096 || h > 4096)
	{
		fprintf (stderr, "invalid dimensions\n");
		return 2;
	}

	a = malloc ((size_t) w * (size_t) h);
	b = malloc ((size_t) w * (size_t) h);
	if (!a || !b)
	{
		fprintf (stderr, "oom\n");
		return 1;
	}
	if (read_raw (argv[3], a, (size_t) w * (size_t) h) != 0 ||
	    read_raw (argv[4], b, (size_t) w * (size_t) h) != 0)
	{
		fprintf (stderr, "read error: %s\n", strerror (errno));
		free (a);
		free (b);
		return 1;
	}

	/* cur is prev shifted by (dx,dy) means cur(x,y)≈prev(x-dx,y-dy) → compare prev(x,y) with cur(x+dx,y+dy) */
	m = w < h ? w / 8 : h / 8;
	if (m > 48)
		m = 48;
	if (m < 4)
		m = 4;

	for (sy = -m; sy <= m; sy++)
	{
		for (sx = -m; sx <= m; sx++)
		{
			err = ssd_shift (a, b, w, h, sx, sy);
			if (err < best)
			{
				second = best;
				best = err;
				best_sx = sx;
				best_sy = sy;
			}
			else if (err < second)
				second = err;
		}
	}

	free (a);
	free (b);

	/* Confidence: separation of best from second best MSE (0..1). */
	{
		double c = 0.0;
		if (second > best * 1.0000001 && second < 1e290)
			c = 1.0 - (best / second);
		if (c < 0.0)
			c = 0.0;
		if (c > 1.0)
			c = 1.0;
		/* Penalize very flat images (near-zero signal). */
		if (best < 1e-6)
			c *= 0.25;

		printf ("{\"dx\":%d,\"dy\":%d,\"c\":%.6f,\"mse\":%.8f}\n",
		        best_sx, best_sy, c, best);
	}
	return 0;
}
