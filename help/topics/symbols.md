---
id: symbols
title: Symbols panel and palette
section: Blocks and symbols
order: 40
keywords: symbols, symbol, SYMBOLS, SYMBOLINSERT, palette, library, folder, scale, drawing scale, recent, insert, dock, float
---

# Symbols panel and palette

Symbols are DXF or DWG files (or built-in items) that you place in a drawing as blocks. For blocks in general, see [Blocks](#topic:blocks).

## The Symbols panel

The panel ([show me](#showme:el:sym-panel)) offers:

- **Source** ([show me](#showme:el:sym-source)): the built-in set, or a folder of your own symbols. Open the **⋯** menu and choose **Add folder…** to add a folder, or **Remove folder** to drop the current one from the list. The files themselves are not deleted.
- **Category** ([show me](#showme:el:sym-cat)) narrows the list, and **Search symbols** ([show me](#showme:el:sym-search)) filters by name.
- **Layout buttons**: grid, list (best in a narrow panel) or a floating window.
- **Symbol scale**: an overall scale applied to every inserted symbol.
- **Drawing scale 1:** enlarges paper-size symbols (devices) by N, so they print at their real size on a 1:N sheet.
- **Count…** counts symbols; see [Count symbols](#topic:symbol-count).

> **Note:** Large folders show the first 500 symbols; refine the search to see others.

## Place a symbol

1. Click a symbol in the panel or in the palette. Its preview follows the cursor.
2. Click to set the insertion point.
3. Type the rotation angle, or click a second time. Press Enter for 0 degrees.
4. The same symbol stays active, so you can place it again. Press **Esc** or right-click to finish.

If a file holds several symbols, you are asked which one to use. Each placement is one undo step.

## Quick Access palette

The **Symbols ▾** button in the Quick Access row ([show me](#showme:el:sym-combo)) opens a compact palette with a source list, a search box and thumbnails. A **Recent** row holds the last eight symbols you placed from the panel or palette. Arrow keys move between thumbnails, Enter inserts and Esc closes. The palette works even when the panel is hidden.

## Where the panel lives

Choose **View ▸ Panels** and pick *Symbols panel: Dock in side panel*, *Dock left*, *Dock right*, *Float* or *Hide*. Docked columns can be resized by dragging their inner edge and folded to a strip. Type **SYMBOLS** to bring a hidden panel back.

> **Tip:** Set **Drawing scale 1:** before placing device symbols, so they are already the right size for the sheet. See also [Display options](#topic:display-options).
