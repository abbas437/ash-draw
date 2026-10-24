---
id: clipboard
title: Copy and paste
section: Modify
order: 40
keywords: clipboard, copy, paste, COPYBASE, PASTECLIP, PASTEBLOCK, PASTEORIG, base point, DXF
---

# Copy and paste

Select objects, then copy them to the clipboard and paste them into the same drawing, another tab or another Draw Studio window.

| Action | Keys | Command |
|---|---|---|
| Copy | <kbd>Ctrl</kbd>+<kbd>C</kbd> | COPYCLIP |
| Copy with Base Point | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> | COPYBASE |
| Paste | <kbd>Ctrl</kbd>+<kbd>V</kbd> | PASTECLIP |
| Paste as Block | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> | PASTEBLOCK |
| Paste to Original Coordinates | menu or command only | PASTEORIG |

## Choosing the points

- **COPYBASE** asks "Specify base point:". The base point is the point that lands on your insertion point when you paste.
- **PASTECLIP** asks "Specify insertion point:" and places the objects there.
- **PASTEBLOCK** asks for an insertion point in the same way, but inserts everything as one new block named `A$C…`. See [Blocks](#topic:blocks).
- **PASTEORIG** asks for no point. The objects go back exactly where they were copied from.

## What happens on paste

- Units are converted, so objects keep their real size in the target drawing.
- If a pasted block has the same name as one already in the drawing, it is renamed `<name>$0` and the existing block is left alone.
- Existing layers and styles are kept. Pasted objects use the target drawing's definitions.

A message confirms how many objects were pasted and mentions any scaling or renaming.

## Working with AutoCAD

The clipboard carries plain-text DXF. That is why copy and paste works between tabs and windows. It is not AutoCAD's own clipboard format, so pasting into AutoCAD will not create objects.

> **Tip:** To move a drawing into AutoCAD, save it as DXF instead. See [Save and file formats](#topic:save-and-formats).

> **Note:** If the clipboard holds no drawing objects, you will see "Nothing to paste". Copy objects first.

See also [Modifying objects](#topic:modify-objects) and the [Command reference](#topic:command-reference).
