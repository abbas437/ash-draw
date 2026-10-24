---
id: layouts-viewports
title: Layouts and viewports
section: View
order: 40
keywords: layout, paper space, model space, viewport, MVIEW, MV, MS, PS, VPLOCK, VPLAYER, viewport scale, page setup, rotate viewport
---

# Layouts and viewports

A layout is a sheet of paper on which you place viewports, each showing the model at a scale you choose. Model and layouts are switched with the tabs at the bottom of the drawing ([show me](#showme:el:spacebar)).

## Work with layout tabs

Click **Model** or a layout name to switch. Right-click a tab for this menu:

| Item | What it does |
|---|---|
| New layout | Asks for a name and adds a layout |
| Copy | Copies the layout under a new name |
| Rename | Renames it |
| Delete | Deletes the layout and everything on it (a drawing keeps at least one layout) |
| Move left / Move right | Changes the tab order |
| Page setup… | Paper size, orientation, plot scale or fit, and plot area |

The Model tab cannot be copied, renamed, deleted or given a page setup. The `LAYOUT` (`LO`) command offers the same actions as a dialog (New, Copy, Delete, Rename, Set, ?), and `PAGESETUP` opens the page setup of the layout you are on.

## Add a viewport

1. Open a layout tab.
2. Enter `MVIEW` (`MV`).
3. Click the first corner, then the opposite corner. The viewport is fitted to the model extents.

`MVIEW` works on a layout tab only.

## Work inside a viewport

- Double-click inside a viewport, or enter `MS` (`MSPACE`), to work in model space through it. Double-click the paper outside any viewport, or enter `PS` (`PSPACE`), to return to the sheet.
- Select one viewport, or enter it with `MS`, and the scale list in the status bar shows its scale ([show me](#showme:el:vpscale)). Pick a standard scale or **Custom…**. The Properties panel shows the same value as **Scale**, typed as `1:N` ([Properties](#topic:properties-panel)).
- `VPLOCK` locks the display of the active viewport, or of the selected viewports, so zoom and pan cannot change its scale. A locked viewport refuses scale changes.

Right-click the border of a viewport on the sheet for a menu with one item, **Display locked**, ticked when the lock is on.

## Rotate or mirror a viewport

Rotating or mirroring a viewport moves its boundary and its view together. A turn by a multiple of 90 degrees keeps a rectangular viewport; any other angle turns it into a clipped viewport. A mirror moves the frame only; the view inside is not mirrored.

> **Note:** Model space cannot be entered through a twisted (rotated) viewport in this version.

## Freeze a layer in one viewport

1. Select a viewport on the sheet, or enter it with `MS`.
2. In the Layers panel, click the freeze button in the **VP** column of the layer ([show me](#showme:panel:layers)). Click again to thaw.

The `VPLAYER` command does the same by name: Freeze, Thaw or Reset, a layer list (comma separated, `*` and `?` wildcards), then Current, All or Select viewports.

> **Tip:** See [Layers](#topic:layers) for the other layer columns, and [Plot to PDF](#topic:plot-and-pdf) to print a layout.
