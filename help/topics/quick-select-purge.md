---
id: quick-select-purge
title: Quick select, select similar and purge
section: Layers and properties
order: 40
keywords: QSELECT, quick select, SELECTSIMILAR, select all, Ctrl+A, PURGE, PU, unused, clean up, zero-length, filter
---

# Quick select, select similar and purge

These commands help you pick the right objects and tidy the drawing.

## Select all

Press <kbd>Ctrl</kbd>+<kbd>A</kbd>, choose **Edit > Select all**, or type `ALL`. Every object in the current space is selected, whatever its layer. Use `QSELECT` when you want only some of them.

## Quick Select - QSELECT

Choose **Edit > Quick Select...** or type `QSELECT`. The **Quick Select** dialog builds a filter:

1. **Apply to** - the entire drawing, or the current selection (offered only when something is selected).
2. **Object type** - **Multiple** for any type, or one of the types present.
3. **Properties** - the property to test, such as Layer or Colour. The list depends on the type.
4. **Operator** - **= Equals**, **<> Not equal**, **> Greater than**, **< Less than** or **\* Wildcard match**. Only operators that make sense for the property are offered.
5. **Value** - picked from the values in the drawing, or typed for a wildcard.

Under **How to apply**, choose **Include in new selection set** to select the matches, or **Exclude from new selection set** to select everything else. Tick **Append to current selection set** to add to what is already selected. The status line reports how many objects were selected.

> **Note:** Colour compares the stored value. An object set to ByLayer on a red layer is not "Red".

## Select similar - SELECTSIMILAR

Select one or more objects and run `SELECTSIMILAR` (or choose it from the Edit menu). Every object that matches them is selected. If nothing is selected yet, select objects and press <kbd>Enter</kbd>.

## Purge - PURGE (PU)

`PURGE` removes unused items from the drawing to keep it small. Choose **Format > Purge...** or type `PU`. The **Purge** dialog lists, with counts, the unused:

- Blocks
- Layers
- Linetypes
- Text styles
- Dimension styles

Untick anything you want to keep, then press **Purge checked**, or **Purge all** for everything listed. **Purge nested items** also removes items that only become unused once others are gone. Tick **Purge zero-length geometry and empty text objects** to delete degenerate objects as well; the count is shown.

The current layer, layer 0 and the current linetype are never purged. The whole purge is one undo step, so `U` restores everything.

> **Tip:** Run `PURGE` before sending a drawing out, then check the result in the [Layers panel](#topic:layers).

See also [Properties panel](#topic:properties-panel) and [Command reference](#topic:command-reference).
