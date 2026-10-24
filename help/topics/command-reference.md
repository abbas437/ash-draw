---
id: command-reference
title: Command reference
section: Getting started
order: 90
keywords: commands, aliases, shortcuts, command line, abbreviations, list of commands, L, PL, C, M, CO, TR
---

# Command reference

Every command and alias that the command line accepts. Type the name or any alias, then press <kbd>Enter</kbd>. Names are not case-sensitive. For how to type commands, options and coordinates, see [Command line](#topic:command-line).

> **Tip:** The command line is the last box in the window. Press any letter key with the drawing focused and the text goes straight into it. [Show me](#showme:el:cmd)

Where a command works on existing objects, select them first or pick them when the prompt asks. Related topics: [Drawing lines and shapes](#topic:draw-lines-shapes), [Modifying objects](#topic:modify-objects), [Dimensions](#topic:dimensions), [Blocks](#topic:blocks), [Layers](#topic:layers), [Layouts and viewports](#topic:layouts-viewports).

## Draw

| Command | Aliases | What it does |
|---|---|---|
| `LINE` | `L` | Draws straight line segments. |
| `PLINE` | `PL`, `POLYLINE` | Draws a polyline of connected line and arc segments. |
| `RECT` | `REC`, `RECTANGLE` | Draws a rectangle from two opposite corners. |
| `POLYGON` | `POL` | Draws a regular polygon. |
| `SPLINE` | `SPL` | Draws a smooth spline through points. |
| `DONUT` | `DO` | Draws a filled ring. |
| `XLINE` | `XL` | Draws a construction line that runs to infinity both ways. |
| `RAY` | | Draws a construction line that runs to infinity one way. |
| `CIRCLE` | `C` | Draws a circle. |
| `ARC` | `A` | Draws an arc. |
| `ELLIPSE` | `EL` | Draws an ellipse. |
| `POINT` | `PO` | Places point objects. |
| `TEXT` | `T` | Places a single line of text. |
| `MTEXT` | `MT` | Places multi-line text. |
| `HATCH` | `H` | Fills a closed area with a hatch pattern. |
| `DIVIDE` | `DIV` | Places points or blocks that divide an object into equal parts. |
| `MEASUREPOINTS` | `ME` | Places points or blocks at set lengths along an object. |

## Modify

| Command | Aliases | What it does |
|---|---|---|
| `SELECT` | `S` | Goes back to the Select tool. |
| `SELECTSIMILAR` | | Selects every object like the one selected. |
| `QSELECT` | | Opens the quick select dialog to select by type, layer or property. |
| `ALL` | | Selects every object in the drawing. |
| `ERASE` | `E` | Deletes the selected objects. |
| `MOVE` | `M` | Moves objects. |
| `COPY` | `CO`, `CP` | Copies objects. |
| `ROTATE` | `RO` | Rotates objects about a base point. |
| `SCALE` | `SC` | Scales objects about a base point. |
| `ALIGN` | `AL` | Moves, rotates and scales objects to match source and destination points. |
| `MIRROR` | `MI` | Mirrors objects about a line. |
| `OFFSET` | `O` | Creates a parallel copy at a distance. |
| `TRIM` | `TR` | Trims objects at a cutting edge. |
| `EXTEND` | `EX` | Extends objects to a boundary. |
| `EXPLODE` | `X` | Breaks a polyline, block or similar object into simpler parts. |
| `FILLET` | `F` | Rounds the corner between two objects. |
| `CHAMFER` | `CHA` | Bevels the corner between two objects. |
| `BREAK` | `BR` | Removes part of an object between two points. |
| `BREAKATPOINT` | | Splits an object in two at one point. |
| `JOIN` | `J` | Joins objects end to end into one. |
| `LENGTHEN` | `LEN` | Changes the length of an open object. |
| `STRETCH` | `STR` | Stretches the part of a drawing that a window crosses. |
| `ARRAYRECT` | `AR` | Makes a rectangular array (rows and columns set in a dialog). |
| `ARRAYPOLAR` | | Makes a polar array around a centre point. |
| `ARRAYPATH` | | Makes an array along a path curve. |
| `PEDIT` | `PE` | Edits a polyline (join, width, and so on). |
| `REVERSE` | | Reverses the direction of a line, polyline, spline or arc. |
| `DRAWORDER` | `DR` | Changes which objects draw in front of others. |
| `TEXTTOFRONT` | | Brings all text to the front of the draw order. |
| `HATCHTOBACK` | | Sends all hatches to the back of the draw order. |
| `MATCHPROP` | `MA`, `PAINTER` | Copies the properties of one object to others. |
| `UNDO` | `U` | Undoes the last action. |
| `REDO` | | Redoes the last undone action. |

## Annotate and dimension

| Command | Aliases | What it does |
|---|---|---|
| `DIMLINEAR` | `DLI` | Horizontal or vertical dimension. |
| `DIMALIGNED` | `DAL` | Dimension parallel to the measured points. |
| `DIMANGULAR` | `DAN` | Angle dimension. |
| `DIMARC` | `DAR` | Arc length dimension. |
| `DIMRADIUS` | `DRA` | Radius dimension. |
| `DIMJOGGED` | `DJO` | Jogged radius dimension. |
| `DIMDIAMETER` | `DDI` | Diameter dimension. |
| `DIMORDINATE` | `DOR` | Ordinate (X or Y datum) dimension. |
| `DIMCONTINUE` | `DCO` | Continues a chain of dimensions from the last one. |
| `DIMBASELINE` | `DBA` | Adds dimensions from the same baseline. |
| `DIMCENTER` | `DCE` | Centre mark for a circle or arc. |
| `CENTERMARK` | `CM` | Centre mark for a circle or arc. |
| `CENTERLINE` | | Centre line between two lines. |
| `MLEADER` | `MLD` | Leader with text. |
| `TEXTEDIT` | `ED`, `DDEDIT` | Edits the text override of a dimension. |
| `DIMSTYLE` | `D`, `DDIM` | Opens the dimension style manager. |

## Blocks

| Command | Aliases | What it does |
|---|---|---|
| `BLOCK` | `B`, `BMAKE` | Creates a block from objects. |
| `INSERT` | `I`, `DDINSERT` | Inserts a block. |
| `ATTDEF` | `ATT` | Defines a block attribute. |
| `EATTEDIT` | `ATE`, `ATTEDIT`, `DDATTE` | Edits the attribute values of a block reference. |
| `ATTSYNC` | `BATTMAN` | Updates block references after attribute definitions change. |
| `BEDIT` | `BE` | Opens a block in the block editor. |
| `BSAVE` | | Saves the block being edited (block editor only). |
| `BCLOSE` | | Closes the block editor, asking to save changes. |
| `BASE` | | Sets the base point of the block being edited (block editor only). |
| `XATTACH` | `XA` | Attaches an external reference drawing. |
| `XREF` | `XR` | Opens the external references panel. |
| `XCLIP` | `XC` | Clips block references to a boundary. |
| `SYMBOLS` | | Shows the symbols panel. |
| `SYMCOUNT` | `BCOUNT` | Counts symbols or blocks in the drawing. |
| `PURGE` | `PU` | Removes unused blocks, layers and other definitions. |

See [Blocks](#topic:blocks) and [Block editor](#topic:block-editor).

## Inquiry and measure

| Command | Aliases | What it does |
|---|---|---|
| `MEASURE` | `MEA`, `MEASUREGEOM`, `DI`, `DIST` | Measures distance, radius, angle or area. |
| `AREA` | `AA` | Measures an area, with add and subtract modes. |
| `ID` | | Shows the coordinates of a point. |
| `LIST` | `LI`, `LS` | Lists the properties of the selected objects in a dialog and the command history. |
| `FIND` | | Opens the Find panel. |
| `COMPARE` | | Compares two drawings and shows the differences in a new tab. |

> **Note:** `ME` is `MEASUREPOINTS` (Draw), not `MEASURE`. Use `MEA` or `DI` to measure. See [Measure](#topic:measure).

## View

| Command | Aliases | What it does |
|---|---|---|
| `ZOOM` | `Z` | Zooms (All, Extents, Window, Previous, Object, or a scale such as `2X`). |
| `ZE` | | Zooms to the extents of the drawing. |
| `PAN` | `P` | Pans the view by dragging. |
| `VIEW` | `V` | Opens the named views manager. |
| `ZOOMFACTOR` | | Sets the mouse wheel zoom speed (3 to 100). |
| `REGEN` | `RE`, `REGENALL`, `REDRAW`, `R` | Rebuilds the display. |
| `PROPERTIES` | `PR`, `CH`, `MO` | Shows the Properties panel. |

## Layers

| Command | Aliases | What it does |
|---|---|---|
| `LAYER` | `LA` | Shows the Layers panel. |
| `LAYISO` | | Isolates the layers of the selected objects. |
| `LAYUNISO` | | Restores the layers that `LAYISO` hid. |
| `LAYFRZ` | | Freezes the layers of the selected objects. |
| `LAYMCUR` | | Makes the layer of the selected object current. |
| `LAYON` | | Turns every layer on. |
| `LAYTHW` | | Thaws every layer. |
| `LAYERSTATE` | `LAS`, `LMAN` | Opens the layer states dialog. |

See [Layers](#topic:layers).

## Layouts

| Command | Aliases | What it does |
|---|---|---|
| `LAYOUT` | `LO` | New, Copy, Delete, Rename or Set a layout. |
| `PAGESETUP` | | Opens page setup for the current layout. |
| `MVIEW` | `MV` | Creates a viewport on a layout by two corners. |
| `VPLOCK` | | Locks or unlocks the viewport scale. |
| `VPLAYER` | | Freezes, thaws or resets layers in chosen viewports. |
| `MSPACE` | `MS` | Enters the model inside a viewport. |
| `PSPACE` | `PS` | Returns to paper space. |

See [Layouts and viewports](#topic:layouts-viewports).

## Files and output

| Command | Aliases | What it does |
|---|---|---|
| `NEW` | | Starts a new drawing. |
| `OPEN` | | Opens a drawing. |
| `SAVE` | | Saves the drawing. |
| `SAVEAS` | | Saves the drawing under a new name as DXF. |
| `PDF` | | Opens the plot dialog set up to save a PDF. |
| `PLOT` | `PRINT` | Opens the plot dialog to print. |
| `PUBLISH` | | Combines the sheets of all open drawings into one PDF. |

See [Plot and PDF](#topic:plot-and-pdf).

## Clipboard

| Command | Aliases | What it does |
|---|---|---|
| `COPYCLIP` | | Copies the selection to the clipboard. |
| `COPYBASE` | | Copies the selection with a base point you pick. |
| `PASTECLIP` | | Pastes the clipboard. |
| `PASTEBLOCK` | | Pastes the clipboard as a block. |
| `PASTEORIG` | | Pastes at the original coordinates. |

## Settings

| Command | Aliases | What it does |
|---|---|---|
| `UNITS` | `UN`, `DDUNITS` | Opens the drawing units dialog. |
| `OSNAP` | `OS`, `DSETTINGS`, `DS` | Opens the drafting settings (object snaps and other drafting aids). |
| `GRID` | | Sets grid on or off, spacing, major lines and style. |
| `SNAP` | `SN`, `GSNAP` | Sets grid snap on or off and its spacing. |
| `LTSCALE` | `LTS` | Sets the linetype scale. |

See [Drafting aids](#topic:drafting-aids) and [Object snaps](#topic:object-snaps).

## Markup

| Command | Aliases | What it does |
|---|---|---|
| `MKC` | | Marks an item with a dashed circle and a comment. |
| `MKR` | | Marks an item with a dashed rectangle and a comment. |
| `MKT` | | Places a note with a comment and no shape. |

See [Markup and review](#topic:markup-review).
