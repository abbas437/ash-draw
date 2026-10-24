---
id: object-snaps
title: Object snaps
section: Drafting aids
order: 10
keywords: osnap, snap, endpoint, midpoint, intersection, centre, quadrant, node, insertion, perpendicular, tangent, nearest, F3, DSETTINGS, drafting settings
---

# Object snaps

Object snaps (running snaps) pull the cursor onto exact points of existing geometry, such as the end of a line or the centre of a circle. While a snap is found, a coloured marker shows its kind and the point you click is the snap point, not the raw cursor position.

## Turn snapping on and off

Press <kbd>F3</kbd> or click **SNAP** in the status bar. [Show me](#showme:status:snap)

The setting is remembered between sessions. Object snaps work in every command that asks for a point, including [drawing](#topic:draw-lines-shapes) and [modify](#topic:modify-objects) commands.

## Running snap modes

These modes are available in the Drafting settings dialog:

- **Endpoint** and **Midpoint** of lines, arcs and polyline segments.
- **Centre** of circles and arcs, and **Geometric centre** of closed polylines.
- **Node** (point objects).
- **Quadrant** points of circles and arcs.
- **Intersection** of two objects.
- **Extension**: rest the cursor on the end of a line or arc to acquire it, then move along its extension.
- **Insertion** point of blocks.
- **Perpendicular** and **Tangent**, measured from the previous point.
- **Nearest** point on an object.
- **Parallel** tracking, parallel to an existing line.

**Apparent intersection** is listed but greyed out and marked "not yet": it is not available.

## Drafting settings dialog

Open it by typing `OSNAP` (`OS`) or `DSETTINGS` (`DS`) on the [command line](#topic:command-line), or by right-clicking **SNAP** or **POLAR** in the status bar. [Show me](#showme:status:snap)

1. Tick **Object Snap On (F3)** to enable snapping.
2. Tick the modes you want running. **Select All** and **Clear All** change every mode at once.
3. Under **Polar Tracking**, set the on/off state, the increment angle and any additional angles (see [Drafting aids](#topic:drafting-aids)).
4. Click **OK**. **Cancel** discards the changes.

> **Tip:** Each mode shows its own marker in the dialog, and the same marker appears on the drawing, so you can learn the shapes there.

## Snap markers

When the cursor is near a snap point, a marker appears. Its shape tells you which mode was found. Clicking accepts that point. If two modes are close together, move the cursor slightly until the one you want is shown.

Hovering over a snap point briefly can also acquire it for object snap tracking (see [Drafting aids](#topic:drafting-aids)).

> **Note:** Too many running modes can make the cursor jump to unwanted points. Keep only the modes you use most switched on, and switch snapping off with <kbd>F3</kbd> when you need to pick free points.

See also: [Keyboard shortcuts](#topic:keyboard-shortcuts), [Command reference](#topic:command-reference).
