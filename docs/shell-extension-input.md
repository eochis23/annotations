# Phase 0: Shell layering and input model

Use this note while spiking behavior on your GNOME version (tag `gnome-shell` sources to match the distro).

## Layering checklist

- [ ] Locate `Main.layoutManager` groups relevant to stacking (e.g. window group vs chrome vs UI group).
- [ ] Decide z-order: overlay **above** application windows; relation to modal dialogs and OSDs.
- [ ] Multi-monitor: listen for monitor geometry changes; one actor per monitor vs one scaled stage actor.

## Input checklist

- [ ] Full-screen transparent actor: `reactive` true vs false — where do pointer events go?
- [ ] Dock-only reactive region: does **mouse** reach clients while **tablet** still hits the extension?
- [ ] If not split: document compositor limitation; consider grab-only-while-proximity or upstream discussion.
- [ ] Log `Clutter.Event` device / pressure for pen, touchpad, and mouse.

## Deliverable

Record findings and the chosen default strategy here before building the full stroke engine.
