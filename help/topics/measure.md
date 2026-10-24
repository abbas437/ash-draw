---
id: measure
title: Measure distances, angles and areas
section: Inquiry
order: 10
keywords: measure, measuregeom, mea, distance, dist, di, area, aa, radius, angle, id, list, li, coordinates, perimeter
---

# Measure distances, angles and areas

The Inquiry commands report geometry without changing the drawing. Measurement marks are drawn on the view only: they are never saved and cannot be undone.

## MEASUREGEOM (MEA)

[Show me](#showme:tool:measure)

Type `MEA` (or `DI`, `DIST`) and pick a point or choose an option on the [command line](#topic:command-line):

- **Distance** (`D`): pick two points. The result gives the distance, Delta X, Delta Y and the angle in the XY plane.
- **Radius** (`R`): pick an arc or circle. The result gives the radius and diameter.
- **aNgle** (`N`): pick two lines or arcs, or press <kbd>Enter</kbd> and then **V** to specify a vertex and two end points.
- **ARea** (`AR`): measure an area (see below).
- **eXit** (`X`) ends the command.

[Object snaps](#topic:object-snaps) apply to every point you pick.

## AREA (AA)

[Show me](#showme:tool:area)

Type `AA` (or `AREA`). Pick the corners of a shape and close it with `C` or <kbd>Enter</kbd>; `U` removes the last point. Choose **Object** to select a closed polyline, circle, ellipse, hatch or closed spline, or click inside a closed shape. The result gives the area and perimeter.

To keep a running total:

1. Choose **Add area** and measure one or more shapes.
2. Choose **Subtract area** to take shapes away, for example a hole.
3. The result shows **Total area** after each shape.

> **Note:** Add and Subtract totals reset when you start a new measurement mode.

## The results panel

Results appear in a **Measure results** panel docked over the drawing. It stays until you close it with the cross, even after the command ends, and it follows a change of units. The markers on the drawing stay while the panel is open.

- **Copy** puts the results on the clipboard.
- **Show ΔX / ΔY** draws the horizontal and vertical legs of a measured distance as dotted lines. It is off by default and the choice is remembered.

Closing the drawing or switching to another one closes the panel.

> **Tip:** In a layout, measuring through a viewport reports the model distance, with the sheet distance shown alongside.

## ID

Type `ID` and click a point to see its coordinates in a message and in the command history.

## LIST (LI)

Select objects, then type `LI` (or `LS`). If objects are already selected, the dialog opens straight away. The **LIST** dialog shows the properties of each object. **Copy** puts the text on the clipboard and **Close** dismisses it.

See also: [Command reference](#topic:command-reference), [Display options](#topic:display-options).
