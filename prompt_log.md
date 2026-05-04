# User prompts

All prompts are made to Cursor's Auto model unless otherwise specified

I did some initial exploratory code myself, but most of the project came through instructing it to take the better path when presented with options, and having it be required to give me those options and stop incrementally.

I also left some of the auto-formatted debug prompts that came from when I got the log of some chats out because I thought that was interesting.

---

## 1

The overlay now comes up, but I can't draw and it's partially obscured by the top bar

---

## 2

I don't see any errors, but nothing is drawing. Which section of the code should I look at to see how you do that?

---

## 3

Let's work on the next step in the plan. I want you to make sure that when the annotation layer is open, only the pen can interact with it and that everything else interacts with the rest of the desktop like normal

---

## 4

I don't need a legacy build mode. just make sure everything works with the best method possible

---

## 5

how do I do 1. when I can't see get it to display anything on the second partition?

---

## 6

I saw this: Success! Installed under /run/media/eric/endeavouros/usr (targets: mutter). Unmounting /run/media/eric/endeavouros... Does that mean that it'll work when I open the other partition?

---

## 7

help me clear out all partitions I'm not using

---

## 8

plan writing a version of compile_target with that does everything with chroot so it's compiled as if it's on the installation on the second partition. When running, it should commit to the git repository from this folder, push, chroot into the other partition, then pull from this branch of this repository and compile and install the versions of mutter and gnome-shell from there

---

## 9

make this project be one that has an install script that will make it run as a git repository when downloaded and installed with an install script, then have a second script that will make that happen on the second partition

---

## 10

can you have a requirements file that will help it install needed requirements like a real package?

---

## 11

I ran it and everything compiled and I got the success message, however when I opened the second partition, there was an underscore in the top left when I started it and nothing else happened. I verified that the mutter and gnome-shell versions here are the same as the originals there and that it worked before. Discuss reasons this might be happening

---

## 12

Now, let's plan the rest of this project that's an annotation shell extension for gnome where we modify mutter and clutter to make sure that any pointer input except for mouse input is directed at the annotation layer above all the content, and the mouse interacts with windows underneath like normal. The layer should have a dock with colors and a trash can button representing clearing all. It should install as part of the install script and be activated by that as well

---

## 13

Make a detailed file documenting all of the changes you made to mutter

---

## 14

(On Opus 4.7, in cursor's debug mode) I'm trying to build an annotation shell extension with a modified version of mutter. The goal is for it to have anything but mouse (usb, touchpad) input interact with the computer like normal, but for everything else, they should interact with an annotation layer and dock that are always visible above the other windows. Right now, the pen I'm using is moving the mouse cursor, so please fix that

---

## 15

I realized I can see a mouse cursor following the pen when I draw with it. Please have that not show. You should do this by tracing through to where the sprite is drawn and stop that directly while . Don't try and stop the cursor image from moving, just don't draw it in whatever function would normally draw it while you can verify that the pen is causing the input.

---

## 16

Right now, the pen and touch can't interact with the dock. How hard would it be to make this actually happen by allowing them to click it?

---

## 17

How about just knowing where the dock is and doing the things that would happen if it was clicked when non-mouse input just hits the screen in those coordinates

---

## 18

what if the dock was just part of the annotation layer and the mouse couldn't interact with it?

---

## 19

(On Opus 4.7) Compare and contrast the above options. Make a plan for the one that would be easier to implement

---

## 20

(On Opus 4.7) Discuss all of the difficulties with making it appear like the annotations are following windows around and are attached to those windows. Include scaling moving, and detecting when drawings are and aren't above windows in your discussion

---

## 21 — Window-following MVP (same Cursor thread; digest)

- How hard is this to implement?
- What if we just got window information and did everything within the single annotation layer?
- Draft a plan for single-layer, getting to MVP with annotations not drawn during overview and nothing for animations yet
- Also add to the plan the taking into account of pen pressure and tilt → revised to pressure only
- Build the plan
- Write a description of the changes to `window-following-changes.md` in this parent folder
- What happens when a window resizes?
- Implement tilt, and triple-tap (non-mouse) on a window within 0.5s clears that window’s annotations; four taps within 0.75s clears all
- Also, don’t draw on top of the dock
- Make the pen barrel button erase by stroke when held down
- For erasing: in erase mode, touching a stroke deletes the whole stroke (not partial erase); make tilt 25% more obvious

---

## 22 — Kate + AT-SPI scroll direction

- How hard would it be to implement scroll detection for an app I know to have static content?
- How hard would it be for you to do option B?
- User pasted a long **Option B: AT-SPI2** description (walk accessibility tree, subscribe to bounds/value events, map scrollbar value to pixels; pros/cons; hand-tune per editor).
- How about doing it the easy way for some specific code editor that would be the nicest for this
- Will GNOME Builder work for non-gnome related projects?
- how about sublime?
- Create a plan for making scrolling annotations work with **Kate**, separating the **terminal** from the **code editing** portion; then implement the plan; then do thorough checks

---

## 23 — QoL pass, defaults, packaged Kate

- commit, then make a list of small quality-of-life improvements for this annotation layer; make a plan to implement them, and implement them
- is black the default color
- change the default color in mutter to be black as well
- Should we include a version of kate to install with this to make sure compatibility works?

---

## 24 — Kate scroll bug + workflow

- Annotations don't scroll in Kate
- Host copy of debug log failed: `cp "$MOUNT_POINT/tmp/debug-da8410.log" ...` → `cannot stat '/tmp/debug-da8410.log'`
- Is it necessary to open the dock after kate is open?
- isn't step 1 done in install_second_partition?
- Is scrolling with the touchpad fine?
- I don't have a mouse wheel


---

## 25 — Scroll-follow still imperfect

- That's much better! Annotations move with the scrolling most of the time, but sometimes they don't
- Scrolling with the keyboard works fine now, but the scroll bar on the side doesn't

---

## 26 — Extension layout, install scripts, mutter pointer fork, self-service work (digest)

**Two `extension.js` files — which one runs?**



**What `install_second_partition.sh` installs (extensions)**


**Is `annotations-shell-extension/` unused?**



**Ideas for relatively simple self-service contributions**

- Expose existing gsettings **`dock-x` / `dock-y`** in **`prefs.js`** (schema already exists; **`lib/overlaySession.js`** reads them); optionally **`changed::dock-x` / `dock-y`** + **`queue_relayout`** for live updates.
- Hide **“Run synthetic motion test”** behind a boolean gsettings + prefs switch.
- **`install.sh` / `install_second_partition.sh`**: `--help` / `--dry-run` style UX.

**Where Mutter was modified for pointer (fork vs exploration)**

- **Current fork (patch):** **`patches/0001-mutter-annotation-fork-pointer-hook.patch`** — optional **`wl_pointer`** focus rewrite in **`src/wayland/meta-wayland-seat.c`** inside **`default_focus`** (pointer-like branch → **`fork_annotation_resolve_pointer_surface`** then **`meta_wayland_pointer_focus_surface`**); public API **`meta_fork_annotation_set_pointer_passthrough`** on compositor/seat; **`docs/input-trace.md`** documents the choke point. **Separate** from tablet path.
- **Distinct:** **`mutter/src/core/meta-annotation-input.c`** + seat backend hooks = **which Clutter streams** hit the annotation overlay vs clients (not the same as **`wl_pointer.enter`** rewriting).

**`mutter_exploration` branch (early work, merged via `172755a`)**

- **`77cdbaa` (“annotations first draft iteration 3”)** added compositor annotation layer, D-Bus, **`meta_annotation_event_targets_overlay()`**, and **`meta_compositor_route_annotation_event()`** from **`meta_display_handle_event`** **before** **`meta_wayland_compositor_handle_event`** so overlay-classified input could **`CLUTTER_EVENT_STOP`** and not reach Wayland clients; plain mouse (pointer without tablet-tool capability) stayed for normal clicks; **`meta-annotation-layer.c`** had **`pointer_has_draw_button`** for mouse-draw with button held.
- That era did **not** yet use the **Wayland seat `default_focus` / `wl_pointer` repick** patch (that is **`0001`**).

**Walk-through: “number one” (dock position in Preferences)**

- Intended steps: add **`dock-x` / `dock-y`** controls to **`prefs.js`** (e.g. spin rows bound to settings); in **`OverlaySession`**, after initial read from gsettings, connect **`changed::dock-x`** / **`changed::dock-y`**, update **`_dockPos`**, call **`this._root.queue_relayout()`**; disconnect those handlers in **`destroy()`**. Re-run **`make schemas`** / pack as usual.

