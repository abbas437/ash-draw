---
id: dimensions
title: Dimension a drawing
section: Draw and annotate
order: 40
keywords: dimension, linear, aligned, angular, radius, diameter, jogged, ordinate, baseline, continue, multileader, center mark, centerline, dimension style
---

# Dimension a drawing

Use the **Dimension** menu or the **Dimension** group of the tool panel. Each command shows its next step in the prompt line.

| Command | Alias | How to use |
|---|---|---|
| `DIMLINEAR` | `DLI` | Click two extension line origins (or <kbd>Enter</kbd> to select an object), then the dimension line location. Type `R` for Rotated and enter an angle. |
| `DIMALIGNED` | `DAL` | Same, parallel to the measured points. |
| `DIMANGULAR` | `DAN` | Select an arc, a circle or two lines, or specify a vertex and two endpoints, then the location. |
| `DIMARC` | `DAR` | Select an arc or polyline arc segment, then the location. |
| `DIMRADIUS` | `DRA` | Select an arc or circle, then the dimension line location. |
| `DIMDIAMETER` | `DDI` | The same for a diameter. |
| `DIMJOGGED` | `DJO` | Select an arc or circle, then the centre override, dimension line and jog locations. |
| `DIMORDINATE` | `DOR` | Command only. Click the feature, then the leader end; its direction picks the X or Y datum (or type `X` or `Y`). |
| `DIMCENTER` | `DCE` | Select arcs or circles; <kbd>Enter</kbd> places the marks. `CENTERMARK` (`CM`) is the same with extension lines. |
| `CENTERLINE` | none | Command only. Select two lines; a centreline is drawn between them. |
| `MLEADER` | `MLD` | Click the arrowhead, then the landing point; a dialog asks for the **Multileader text**. |
| `DIMCONTINUE` | `DCO` | Select a linear, aligned or angular dimension, then click each next extension line origin. <kbd>Enter</kbd> finishes. |
| `DIMBASELINE` | `DBA` | The same, but each new dimension stacks from the first extension line. |

[Show me the Linear dimension button](#showme:tool:dimlinear)

## Dimension styles

The **Dimension** group has a style list; choose the style to use for new dimensions.

[Show me the style list](#showme:el:dimstyle)

Click **Dim styles…** (or use `DIMSTYLE`, `D`) to open the Dimension Style Manager, where you can **Set current**, create a style with **New…** (a copy of the selected one) or **Modify…** it. The style dialog has: Text height, Text gap, Text placement (above the line or centred), Arrowhead, Arrow size, Extension line offset, Extend beyond dimension line, Units, Decimal places, Decimal separator, Suppress trailing zeros, Prefix, Suffix, Overall scale and Linear scale factor.

## Edit a dimension

Select a dimension and open the [Properties panel](#topic:properties-panel). **Text override** replaces the text (`<>` stands for the measured value; empty restores it). **Measurement** is read-only. `ED` and double-click open the same override. Dimensions can be moved and copied with [Modify objects](#topic:modify-objects) and take [grips](#topic:grips) that regenerate them. `EXPLODE` turns one into plain lines and text; after that it is no longer a dimension.

> **Tip:** Turn on [object snaps](#topic:object-snaps) before dimensioning so the extension lines land exactly on the geometry.

> **Note:** Changing a style's values rebuilds the dimensions that use it.
