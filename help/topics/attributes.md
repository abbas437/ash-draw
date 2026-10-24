---
id: attributes
title: Attributes
section: Blocks and symbols
order: 30
keywords: attribute, attdef, att, eattedit, ate, attedit, attsync, battman, tag, find, replace
---
# Attributes

Attributes are text fields stored in a block, such as a tag number or description. You define them in the block, and each reference carries its own values. See [Blocks](#topic:blocks) first.

## Define an attribute

Choose **Attribute** [Show me](#showme:tool:attdef) or type `ATTDEF` (`ATT`). The **Attribute definition** dialog has:

- **Tag** - required, with no spaces.
- **Prompt** - the label shown when values are requested.
- **Default** - the starting value.
- **Text height** - must be above 0.
- **Mode** - **Invisible**, **Constant**, **Verify** and **Preset**.

Press **OK**, then click where the text goes. Include the attribute definitions when you create the block with `BLOCK`.

> **Note:** Constant and preset attributes are not asked for when you insert the block.

## Edit values

Choose **Edit attributes** [Show me](#showme:tool:eattedit) or type `EATTEDIT` (`ATE`, also `ATTEDIT` and `DDATTE`), then pick a reference. If it has no attributes you are told so. A dialog lists each attribute by prompt; change the values and press **OK**. The edit is one undo step.

> **Tip:** With the Select tool, double-click a reference that has attributes to open the same dialog.

## Update references with ATTSYNC

After you change attribute definitions in the [block editor](#topic:block-editor), `ATTSYNC` (`BATTMAN`) rebuilds the attributes of existing references from the definition. Pick a reference or type the block name; type `?` to list blocks that have attributes. A message reports how many blocks were updated. Saving with `BSAVE` also updates references automatically.

> **Note:** `ATTSYNC` is refused while the block editor is open.

## Find and replace

Find and replace searches the text of attributes as well as ordinary text, and replace works on attributes. Invisible attributes are not drawn, so they are not found. See [Find and replace](#topic:find-replace).

For counting blocks and symbols, see [Symbol count](#topic:symbol-count). All commands: [Command reference](#topic:command-reference).
