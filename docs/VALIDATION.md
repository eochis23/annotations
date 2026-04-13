# Validation matrix (mutter + shell fork)

Run these **after** installing your rebuilt **mutter** and **gnome-shell** packages (or equivalent). Touch policy for this fork baseline: **unchanged** (only pointer-like capabilities go through the new `wl_pointer` hook; touch still uses the touch path in `default_focus`).

## Wayland session

| Step | Action | Expected |
|------|--------|----------|
| W1 | Log into **Wayland** GNOME session | Session starts normally. |
| W2 | Open a **native Wayland** terminal or editor | Window receives clicks. |
| W3 | With annotations overlay **off**, click client | Normal. |
| W4 | With overlay **on** and passthrough **FALSE** (default) | Same as today (extension behavior). |
| W5 | With passthrough **TRUE** and overlay **on** | `org.gnome.shell annotation-pointer-passthrough` is true; Mutter re-picks `wl_pointer` under Shell chrome. |
| W6 | Same as W5 over a **native Wayland** client | Clicks reach the client; pen/tablet still draws on the overlay. |

## Xwayland

| Step | Action | Expected |
|------|--------|----------|
| X1 | Run an **X11** app (e.g. `GDK_BACKEND=x11`) | Starts under Xwayland. |
| X2 | Repeat pointer checks under overlay | No crash if `wayland_compositor` null-guarded. |

## Tablet / stylus

| Step | Action | Expected |
|------|--------|----------|
| T1 | Proximity in/out, pressure, tilt | Unchanged vs stock (tablet branch not modified). |
| T2 | Eraser / barrel if supported | Same. |
| T3 | **Multi-monitor** | Geometry matches extension union rect; no off-by-one between monitors. |

## Shell chrome / edge cases

| Step | Action | Expected |
|------|--------|----------|
| E1 | **Overview** (Super) | No stuck grabs; leaving overview restores input. |
| E2 | **Modal dialog** (e.g. logout confirm) | Modals still receive clicks; no click-through to obscured clients. |
| E3 | **Pointer lock** (game) | Document failure if any; may need extra grab checks in resolver. |
| E4 | **Screen shield / lock** | Session lock still exclusive. |

Record failures with `journalctl --user -b /usr/bin/gnome-shell` (or distro equivalent) and revert to distro packages if the session is unusable.
