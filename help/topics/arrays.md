---
id: arrays
title: Arrays
section: Modify
order: 30
keywords: array, ARRAYRECT, ARRAYPOLAR, ARRAYPATH, AR, rows, columns, copies, pattern
---

# Arrays

An array makes many copies of the selected objects in a regular pattern. Draw Studio has three kinds, all in the Modify group of the tool panel.

| Command | Alias | Pattern |
|---|---|---|
| ARRAYRECT | `AR` | Rows and columns |
| ARRAYPOLAR | none | Copies around a centre point |
| ARRAYPATH | none | Copies along a line, arc or other curve |

[Show me the Array rect button](#showme:tool:arrayrect)

## How it works

1. Start the command, then select the objects to copy. The prompt shows how many are selected. Press <kbd>Enter</kbd> when you have finished.
2. Give the extra input the pattern needs:
   - **ARRAYRECT** needs nothing more. The dialog opens straight away.
   - **ARRAYPOLAR** asks for the centre point of the array.
   - **ARRAYPATH** asks you to select the path curve. The path cannot be one of the objects you are arraying.
3. Fill in the dialog and confirm.

## The dialogs

- **Rectangular array:** rows, columns, row spacing, column spacing and angle. The spacings start at one and a half times the size of the selection.
- **Polar array:** total number of items, the angle to fill (360 for a full circle) and whether to rotate items as they are copied.
- **Path array:** number of items, spacing, and whether to align items to the path. Leave items blank to fill the path at the spacing you give, or leave spacing blank to divide the path evenly.

> **Note:** The result is a set of ordinary copies, not an associative array. Changing the original later does not update the others, and there is no array to edit afterwards. A path array also removes the originals and adds them again along the path.

> **Tip:** The dialogs remember your last settings, which saves time when you repeat an array. A very large array is refused (the limit is 100,000 objects), so check the numbers if you see that message.

See also [Modifying objects](#topic:modify-objects), [Grips](#topic:grips), [Blocks](#topic:blocks) and the [Command reference](#topic:command-reference).
