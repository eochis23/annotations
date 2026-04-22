# Improvements log (reversible)

Session: 2026-04-20. Each entry lists **what** changed, **why**, and **how to undo** (restore prior behavior).

---

## 1. `annotations-shell-extension/extension.js`

| Change | Why | Undo |
|--------|-----|------|
| **Overview:** connect `Main.overview` `showing` / `hidden` to hide/show the dock; if `Main.overview.visible` at enable, start hidden | Keeps the activities overview uncluttered; correct state if extension loads while overview is open | Remove those connects, the `visible` check after `add_child`, and related `disconnect` / fields in `disable()` |
| **Separator:** `St.Widget` with `annotation-dock-separator` between swatches and trash | Clear visual grouping | Remove the `separator` block and `this._dock.add_child(separator)` before trash |
| **`accessible_name`** on color buttons and trash | Screen reader / keyboard discoverability | Remove `accessible_name` from each `St.Button` / trash props |
| **Allocation debounce:** `notify::allocation` schedules a single idle to call `_positionDock` | Fewer layout passes when allocation churns | Remove `_allocDebounceId`, replace `_allocId` handler with direct `this._positionDock()` |
| **Re-stack after overview:** `set_child_above_sibling` in `hidden` handler | Dock stays above other `uiGroup` children after overview | Remove that line from the `hidden` callback |

---

## 2. `annotations-shell-extension/stylesheet.css`

| Change | Why | Undo |
|--------|-----|------|
| Dock: `box-shadow`, border | Depth and legibility on varied wallpapers | Delete `box-shadow` / `border` lines on `.annotation-dock` |
| Buttons: `:hover` border, `:focus` ring | Feedback for pointer and keyboard | Remove `.annotation-color-button:hover` / `:focus` and `.annotation-trash-button` variants |
| **`.annotation-dock-separator`** | Styles the new divider | Remove the whole rule |

---

## 3. `annotations-shell-extension/metadata.json`

| Change | Why | Undo |
|--------|-----|------|
| `"version": 3` (was 2) | Marks this UI/behavior drop | Set `"version"` back to `2` |

---

## Git

To revert everything in one step (if committed separately):

```bash
git checkout -- annotations-shell-extension/extension.js annotations-shell-extension/stylesheet.css annotations-shell-extension/metadata.json IMPROVEMENTS_LOG.md
```

Or revert the commit that introduced these files.
