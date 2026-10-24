---
id: block-editor
title: Block editor
section: Blocks and symbols
order: 20
keywords: bedit, block editor, bsave, bclose, base point, edit block definition
---
# Block editor

The block editor lets you change a block definition using the ordinary drawing and modify tools. Every reference in the drawing follows once you save. For the basics, see [Blocks](#topic:blocks).

## Open the editor

Type `BEDIT` (`BE`).

- If you have exactly one block reference selected, its definition opens straight away.
- Otherwise the **Edit block definition** dialog lists the drawing's editable blocks. Pick one and press **OK**, or double-click the name.

If the drawing has no editable blocks, you see a message instead. You can edit only one block at a time.

> **Note:** The editor works on a copy of the definition. The drawing itself does not change until you save.

While the editor is open, a bar above the drawing shows **Block editor: name** with three buttons, **Save block**, **Set base point** and **Close**. The Model and layout tabs are hidden, and the view fits the block. Draw, modify and undo work as usual, on the copy.

## Save, base point and close

- `BSAVE` writes the copy back to the drawing as one undo step and keeps the editor open. References that carry attributes are updated to match.
- `BASE` sets the block's base point. Click the new point; a marker shows the current one.
- `BCLOSE` leaves the editor. With no unsaved changes it closes at once. Otherwise the **Block editor** dialog asks "Save changes to name?" with **Save**, **Discard** and **Cancel**. Save writes the copy then closes; Discard throws the changes away; Cancel keeps you in the editor.

The same question appears if you save the drawing, close the tab or quit while edits are pending.

> **Tip:** Save as you go with `BSAVE`; you can still discard later edits with `BCLOSE`.

## Blocked commands

Some commands change other blocks or the whole drawing, so they are refused while the editor is open, with the message "Close the block editor first (BCLOSE)". They are `BLOCK`, `BEDIT`, `ATTSYNC`, `PURGE`, `UNITS`, `LAYOUT` and `PAGESETUP`.

Outside the editor, `BSAVE`, `BCLOSE` and `BASE` only show a hint to use `BEDIT` first.

See also [Attributes](#topic:attributes) and [Command reference](#topic:command-reference).
