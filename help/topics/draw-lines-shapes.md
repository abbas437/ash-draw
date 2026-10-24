---
id: draw-lines-shapes
title: Draw lines and shapes
section: Draw and annotate
order: 10
keywords: line, polyline, rectangle, polygon, circle, arc, ellipse, spline, donut, construction line, xline, ray, point, divide, measure
---

# Draw lines and shapes

Start a drawing command from the **Draw** group of the tool panel, or type its name or alias in the command line. The prompt line always shows the next step. Every command below takes points by clicking (with [object snaps](#topic:object-snaps) and [drafting aids](#topic:drafting-aids)) or by typing coordinates, then <kbd>Enter</kbd>.

[Show me the Line button](#showme:tool:line)

| Command | Alias | How to use |
|---|---|---|
| `LINE` | `L` | Click the first point, then each next point. Type `U` to undo the last segment, `C` to close back to the first point (after two segments). <kbd>Enter</kbd> or <kbd>Esc</kbd> ends the chain. |
| `PLINE` | `PL` | Click points. Type `U` to undo a point, `C` to close (three or more points). <kbd>Enter</kbd> finishes the polyline; <kbd>Esc</kbd> discards the points you have picked. Straight segments only. |
| `RECTANG` | `REC` | Click the first corner, then the opposite corner, or type `@width,height`. |
| `POLYGON` | `POL` | Type the number of sides (3 to 1024; <kbd>Enter</kbd> keeps the default), pick the centre or type `E` for Edge, then `I` (inscribed) or `C` (circumscribed), then the radius. With Edge, click the two ends of one side. |
| `CIRCLE` | `C` | Click the centre, then click or type the radius. Centre and radius only. |
| `ARC` | `A` | Click the start point, a second point on the arc, then the end point. |
| `ELLIPSE` | `EL` | Click the centre, the end of the first axis, then a point whose distance from that axis sets the other half-axis. |
| `SPLINE` | `SPL` | Click fit points. `U` undoes a point, `C` closes (three or more points), <kbd>Enter</kbd> finishes, <kbd>Esc</kbd> discards. |
| `DONUT` | `DO` | Type the inside diameter, then the outside diameter (<kbd>Enter</kbd> keeps each default), then click centres. <kbd>Enter</kbd> or <kbd>Esc</kbd> exits; all donuts of one run undo together. |
| `XLINE` | `XL` | Click a point, then a through point. Options: `H`, `V`, `A` (angle), `B` (bisect: vertex, start, end) and `O` (offset: distance or `T` for Through, then a line and a side). |
| `RAY` | `RAY` | Click the start point, then through points. <kbd>Enter</kbd> exits. |
| `POINT` | `PO` | Click to place a point. |
| `DIVIDE` | `DIV` | Select a line, arc, circle, ellipse, polyline or spline, then type the number of segments (2 or more) or `B` to place a block (you are asked whether to align it). |
| `MEASUREPOINTS` | `ME` | The same, but you type a segment length (greater than 0). A length longer than the object places nothing. |

## Good to know

- The tool stays active after each object, so you can draw another. Press <kbd>Esc</kbd> with nothing started, or choose another tool, to go back to Select. `XLINE`, `RAY` and `DONUT` stay active until you press <kbd>Enter</kbd> or <kbd>Esc</kbd>.
- New objects take the current layer; see [Layers](#topic:layers). To change what you drew, use [Modify objects](#topic:modify-objects) or the [Properties panel](#topic:properties-panel).

> **Tip:** Type a number at the `CIRCLE` radius prompt for an exact size. [Command line](#topic:command-line) lists the entry syntax.

> **Note:** `MEASURE` (alias `MEA`) is the distance and area inquiry tool here, not the point-placing command. Use `MEASUREPOINTS` (`ME`) to mark lengths along an object.
