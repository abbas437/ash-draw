---
id: blocks
title: Blocks
section: Blocks and symbols
order: 10
keywords: block, insert, explode, xclip, purge, definition, reference, base point
---
# Blocks

A block is a group of objects stored once in the drawing and placed as many times as you need. Each placed copy is a block reference (an INSERT). Change the definition and every reference follows. For ready-made symbols, see [Symbols](#topic:symbols); to total references, see [Symbol count](#topic:symbol-count).

## Create a block

Choose **Create block** [Show me](#showme:tool:block) or type `BLOCK` (`B`). The **Block definition** dialog has these fields:

- **Name** - must be unique in the drawing; invalid or duplicate names are refused with a message.
- **Base point** (X, Y) - the point the block is placed by. Type it, or choose **Pick point** to click it on the drawing.
- **Objects** - uses the current selection (the dialog shows the count). Choose **Select objects** to change it, then decide what happens to the originals: **Retain**, **Convert to block** (the default, which replaces them with one reference) or **Delete**.

Press **OK** to define the block.

> **Tip:** Select the objects first, then start `BLOCK`. The dialog opens with them already counted.

## Insert a block

Choose **Insert** [Show me](#showme:tool:insert) or type `INSERT` (`I`). If the drawing has no blocks, you are told to define one first. The **Insert** dialog offers:

- a list of blocks with a small preview;
- **Scale X** and **Scale Y**, linked while **Uniform scale** is ticked;
- **Rotation**, in degrees;
- **Explode**, which places loose objects instead of a reference.

Click **OK**, then click the insertion point; a dashed preview follows the cursor. If the block has attributes, you are asked for their values. The dialog remembers your last settings.

## Explode, clip and purge

- `EXPLODE` (`X`) breaks a reference into its objects, one level at a time. Nested blocks stay as references. See [Modify objects](#topic:modify-objects).
- `XCLIP` (`XC`) hides the part of a reference outside (or inside) a boundary, which can be rectangular, polygonal or a closed polyline. Options turn the clip on or off, delete it or draw a new one. Each change is one undo step.
- `PURGE` (`PU`) lists unused blocks, with layers and styles, and removes the ones you tick. See [Quick select and purge](#topic:quick-select-purge).

## Edit a definition

Use `BEDIT` (`BE`); see [Block editor](#topic:block-editor).

> **Note:** Double-clicking a reference in Select does not open the block editor. It opens the attribute editor, and only when the block has attributes. Select the block and type `BEDIT` instead.

Other topics: [Attributes](#topic:attributes), [Command reference](#topic:command-reference).
