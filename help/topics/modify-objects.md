---
id: modify-objects
title: Modify objects
section: Modify
order: 10
keywords: modify, move, copy, rotate, scale, align, mirror, offset, trim, extend, erase, explode, fillet, chamfer, break, join, lengthen, stretch, pedit, reverse, draworder, matchprop, select
---

# Modify objects

Every modify command works the same way: choose the objects, press <kbd>Enter</kbd>, then answer the prompts on the command line. If objects are already selected when you start the command, it skips the selection step.

## Selecting objects

- Click an object to add it to the selection.
- Drag a window left to right to select objects inside it. Drag right to left for a crossing window, which also takes objects it touches.
- Hold <kbd>Shift</kbd> while you click or drag to remove objects.
- <kbd>Ctrl</kbd>+<kbd>A</kbd> selects everything. <kbd>Esc</kbd> clears the selection.

## Commands

Try one: [Show me MOVE](#showme:tool:move).

| Command | Alias | What it does | Notes |
|---|---|---|---|
| `MOVE` | `M` | Base point, then second point | You can type `@dx,dy` |
| `COPY` | `CO` | As MOVE, but keeps the originals | Repeats until <kbd>Enter</kbd> |
| `ROTATE` | `RO` | Base point, then angle | Click or type degrees |
| `SCALE` | `SC` | Base point, then a factor | Or click a reference length, then the new length |
| `ALIGN` | `AL` | Moves and rotates from source to destination points | Second pair optional; then **Scale objects based on alignment points? [Yes/No]** |
| `MIRROR` | `MI` | Two points define the mirror line | Type `D` to toggle deleting the source |
| `OFFSET` | `O` | Distance, pick an object, pick a side | Lines, circles, arcs and straight polylines only |
| `TRIM` | `TR` | Click the part to remove | Every other object is a cutting edge |
| `EXTEND` | `EX` | Click near the end to extend | Every other object is a boundary |
| `ERASE` | `E` | Deletes the selection | Also <kbd>Del</kbd> in Select |
| `EXPLODE` | `X` | Breaks into simpler objects | Blocks, dimensions and polylines only |
| `FILLET` | `F` | Rounds a corner | Options Radius, Trim, Polyline, Multiple |
| `CHAMFER` | `CHA` | Bevels a corner | Options Distance, Angle, Trim, Polyline, Multiple |
| `BREAK` | `BR` | Removes a gap | Pick point is the first break point; `F` re-picks it; `@` breaks at one point |
| `BREAKATPOINT` | none | Splits at one point, no gap | |
| `JOIN` | `J` | Merges touching objects | Select, then <kbd>Enter</kbd> |
| `LENGTHEN` | `LEN` | Changes length | DElta, Percent, Total, DYnamic |
| `STRETCH` | `STR` | Moves what a crossing window catches | Window, base point, second point |
| `PEDIT` | `PE` | Edits a polyline | Close/Open, Join, Width, Fit, Spline, Decurve, Reverse, Undo |
| `REVERSE` | none | Flips direction | Lines, arcs, polylines, splines |
| `DRAWORDER` | `DR` | Changes stacking | Above objects, Under objects, Front, Back; default Back |
| `TEXTTOFRONT` | none | Brings text to the front | Runs at once |
| `MATCHPROP` | `MA` | Copies properties from a source object | `S` opens **Property Settings** |

> **Note:** `PEDIT` offers Edit vertex for a single polyline only. It is not available after the Multiple option.

> **Tip:** Press <kbd>Esc</kbd> to cancel a command or step back to object selection. Typing a command name works at any time; see [keyboard shortcuts](#topic:keyboard-shortcuts).

Related: [grips](#topic:grips), [arrays](#topic:arrays), [object snaps](#topic:object-snaps).
