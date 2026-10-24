---
id: find-replace
title: Find and replace text
section: Inquiry
order: 20
keywords: find, replace, search, text, mtext, attribute, dimension, block, Ctrl+F, replace all, match case, whole words
---

# Find and replace text

Press <kbd>Ctrl</kbd>+<kbd>F</kbd> or type `FIND` to open the **Find and replace** panel. It searches the whole drawing of the current tab: model space and every [layout](#topic:layouts-viewports).

## What is searched

- **TEXT** and **MTEXT** objects.
- Block **attribute** values (the ones that are shown); see [attributes](#topic:attributes).
- **Dimension** text overrides.
- Text inside **block definitions**, reported against the block reference that draws it.

> **Note:** Dimension overrides and text inside blocks are find-only. A dimension's override is not what the drawing displays, and a block definition is shared by every reference, so editing it would change them all. To change that text, edit the dimension or the block.

## Find

1. Type in **Find what**. Results appear as you type, with a count such as "3 matches".
2. Tick **Match case** or **Whole words** if needed.
3. Press <kbd>Enter</kbd> (or the down arrow button) for the next match and <kbd>Shift</kbd>+<kbd>Enter</kbd> (or the up arrow) for the previous one.

Each result shows the matching text, then the place (Model or the layout name) and the layer. Click a result to switch to its space, zoom to the object and select it. Press <kbd>Esc</kbd> to close the panel.

The list shows the first 500 results. The panel refreshes if you edit the drawing while it is open.

## Replace

Type the new text in **Replace with**, then:

- **Replace** changes the selected match and moves to the next.
- **Replace all** changes every match in the drawing, Model and layouts, and reports how many were replaced and how many find-only matches were left unchanged.

Each of these is one undo step, so <kbd>Ctrl</kbd>+<kbd>Z</kbd> reverses it.

> **Tip:** Run a search first and scan the result list before using **Replace all**. Matches in dimensions and blocks will not change, so check them separately.

See also: [Modify objects](#topic:modify-objects), [Keyboard shortcuts](#topic:keyboard-shortcuts).
