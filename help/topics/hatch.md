---
id: hatch
title: Hatch a closed area
section: Draw and annotate
order: 30
keywords: hatch, pattern, solid, scale, pat file, boundary, island, hatchtoback, acad.pat
---

# Hatch a closed area

## Place a hatch

1. Set the pattern and scale in the **Hatch** group of the tool panel: the pattern list (tooltip **Hatch pattern**) and the **Hatch scale** box. Choose `SOLID` for a solid fill.
2. Choose `HATCH` (`H`).
3. Click inside the area you want to fill. The prompt reads **HATCH  pick an internal point**.

[Show me the Hatch button](#showme:tool:hatch)

The program finds the smallest closed region around your click, built from lines, arcs, polylines, circles, ellipses and splines (blocks included) that are visible in the current view. Closed shapes inside it become islands. If nothing closes around the point, a message says **No closed boundary found around that point**; close the gap, or zoom out so the whole boundary is visible, and click again. You pick an internal point; picking objects is not offered.

Each click makes one hatch and the tool stays active, so keep clicking to fill more areas. Press <kbd>Esc</kbd> or choose another tool to stop.

## Add your own patterns

Open **Format** and choose **Load patterns from .pat file…** to read an `acad.pat` or `acadiso.pat` style file. The loaded patterns appear in a **Loaded** group at the end of the pattern list. **Format ▸ Hatch patterns…** lists them, each with a Remove button. Hatches already drawn keep their pattern lines in the drawing, so removing a pattern affects only new hatches.

## Areas and draw order

- Hatch area is worked out by even-odd nesting: a loop inside an even number of other loops adds to the area, one inside an odd number is subtracted. Islands therefore do not count towards the filled area.
- `HATCHTOBACK` sends every hatch in the drawing behind the other objects, so linework stays visible over the fill. It runs at once and returns to Select.
- To change a hatch afterwards, use the [Properties panel](#topic:properties-panel); to move it, see [Modify objects](#topic:modify-objects). Hatches have no [grips](#topic:grips).

> **Tip:** If a hatch will not fill, check that the boundary really closes: zoom in on corners, and use [object snaps](#topic:object-snaps) when drawing the outline.

> **Note:** Pattern scale and the hatch pattern apply to hatches you place next; they do not change hatches already in the drawing.
