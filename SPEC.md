The goal is to have a complete annotating application / surface that is toggelable and intercepts all pen input when it is on while having all other input interact with the windows below the surface as if the surface did not exist. The supported implementation path is a **forked Mutter + GNOME Shell** (see repository root `patches/`, `scripts/`, `docs/`) plus the **in-tree GNOME Shell extension** at the repository root (`extension.js`, `lib/`, …).

The following should be included:

- A dock that the user can use to clear all input, undo strokes, and change pen colors. This dock should:
    - be relatively minimal
    - be able to be dragged around
    - decrease in size when not interacted with for 5 seconds
- The ability to erase when the button on the pen is held down as the pen is drawing. Erasing should erase strokes rather than pixels / spots of pen
- The ability to toggle on and off with the keyboard shortcut **Super+Alt+A** (default in extension schema; recompile schemas after changes)
    - When the annotation layer is toggled off, the computer should work exactly the same as if the layer does not exist
    - When the annotation layer is on, pen input should not interact with anything but the annotation layer and all other input should work exactly the same as if the annotation layer did not exist.
- Separate canvases for each window. When the annotation layer is on, then it should appear as if the windows are being annotated rather than the desktop as a whole. There should only be one dock, and that dock should remain in place as windows are changed.
- Scroll detection (advanced feature: implement after all else works)
    - The annotation layer for each window should have the ability to detect when that window scrolls with an algorithm (discuss options) and scroll with the window
