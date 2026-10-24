---
id: grips
title: Edit with grips
section: Modify
order: 20
keywords: grips, grip, stretch, hot grip, base point, multiple grips, edit without command
---

# Edit with grips

Grips let you reshape an object without starting a command. Select an object while no command is running and small squares appear on it.

## Where the grips are

| Object | Grips |
|---|---|
| Line | Both ends and the midpoint (the midpoint moves the whole line) |
| Polyline | Each vertex and the middle of each segment |
| Circle | Centre and four quadrant points (a quadrant point changes the radius) |
| Arc | Both ends, the midpoint and the centre |
| Ellipse | Centre and the four axis ends |
| Text, multiline text, block, point | Insertion point |
| Dimension | Its definition points and the text position |
| Leader | Each vertex |
| Construction line, ray | Base point and direction grips |

Hatches, splines and solids have no grips. Grips are not shown when more than 300 objects are selected.

## Drag a grip

1. Select the object.
2. Click a grip, or press on it and drag. It becomes hot and the command line shows `** STRETCH **`.
3. Move the cursor and click, or release the drag, to place the point. You can also type coordinates.

The whole edit is one undo step.

## Grip modes

With a grip hot, press <kbd>Space</kbd> or <kbd>Enter</kbd> to cycle through `STRETCH`, `MOVE`, `ROTATE`, `SCALE` and `MIRROR`. Right-click for a menu of the same modes. Move, rotate, scale and mirror act on the whole selection about the hot grip.

| Option | Type | Effect |
|---|---|---|
| Base point | `B` | Pick a new base point instead of the hot grip |
| Copy | `C` | Keeps the originals; each pick adds a copy until you press <kbd>Enter</kbd> |
| Exit | `X` | Ends the grip command |

In `ROTATE` and `SCALE` you can type degrees or a factor instead of clicking.

## Several grips at once

Hold <kbd>Shift</kbd> and click grips to make several hot, then click one of them and move. All the hot grips move by the same amount in `STRETCH`.

## Leaving grip editing

<kbd>Esc</kbd> ends the grip command and keeps the selection. Press <kbd>Esc</kbd> again to clear the selection.

> **Tip:** A grip edit changes only that object. To change a group of objects precisely, use the commands in [Modify objects](#topic:modify-objects).
