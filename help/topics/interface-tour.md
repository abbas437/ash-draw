---
id: interface-tour
title: Interface tour
section: Getting started
order: 10
keywords: interface, menus, tool panel, quick access, command line, side panel, status bar, layout tabs, toolbar
---

# Interface tour

ASH Draw Studio is laid out like AutoCAD, so most things are where you expect them. This tour goes from the top of the window to the bottom.

## Menu bar and Quick Access

[Show me](#showme:el:menubar) the menu bar. It has **File, Edit, View, Format, Dimension** and **Help**. Use the arrow keys to move through a menu and <kbd>Esc</kbd> to close it.

Under the menus, the **Quick Access** row (`#qat`) holds one-click buttons: New, Open, Save, Undo, Redo, Select, Pan, Zoom extents, a few draw and modify tools, Dimension, Measure, the markup tools and the Layers panel. It also contains the layer list and the **Symbols** palette. [Show me](#showme:el:qat) the row, or [Show me](#showme:cmd:save) the Save button. To change what it holds, see [Customise toolbars](#topic:customize-toolbars).

## Tool panel

[Show me](#showme:panel:tools) the tool panel (`#tools`). Its groups are **Select, Draw, Modify, Block, Dimension, Inquiry** and **Markup**.

1. Hover over a button to see its name and command alias, for example `LINE` (`L`).
2. Click a group heading to fold or unfold it.
3. Use **View ▸ Toolbars** to move the panel (Left, Right, Top, Hidden), switch between Full, Compact rail and Floating layouts, or show tool labels.

> **Tip:** Tools you hide still run from the command line.

## Command line

The command line (`#cmd`) sits at the bottom. [Show me](#showme:el:cmd) it. Type a command or alias (`L`, `PL`, `C`, `M`, `CO`, `RO`, `TR`) and press <kbd>Enter</kbd>, or type coordinates such as `10,20`, `@5,0` or `d<45`. The text to its left (`#prompt`) tells you what the active tool wants next. [Show me](#showme:el:prompt) the prompt.

<kbd>↑</kbd> and <kbd>↓</kbd> recall earlier input, and <kbd>F2</kbd> opens the command history. See [Command line](#topic:command-line).

## Side panel

[Show me](#showme:panel:side) the side panel (`#side`). It holds Layers, Markups, Symbols and Properties. Press <kbd>Ctrl</kbd>+<kbd>3</kbd> to expand it, or use **View ▸ Panels ▸ Side panel** for Expanded, Collapsed or Hidden.

## Model and layout tabs

[Show me](#showme:el:spacebar) the space tabs (`#spacebar`). Click **Model** or a layout name to switch. See [Layouts and viewports](#topic:layouts-viewports).

## Status bar

[Show me](#showme:el:status) the status bar. From the left:

| Item | What it does |
|---|---|
| Coordinates (`#coord`) | Cursor X and Y |
| SNAP, ORTHO, POLAR, OTRACK | Object snap <kbd>F3</kbd>, ortho <kbd>F8</kbd>, polar <kbd>F10</kbd>, tracking <kbd>F11</kbd> |
| GRID, GSNAP | Grid display <kbd>F7</kbd>, snap to grid <kbd>F9</kbd> |
| LWT, TPY | Show lineweights, show transparency |
| Converter (`#conv`) | Shown for drawings converted from DWG; click for the log |
| Selection (`#sel`) | "N selected", or the object count |
| Units (`#units`) | Click to open the Units dialog |
| DARK (`#theme-btn`) | Switches the dark theme |

> **Note:** Ortho and Polar cannot both be on. Right-click SNAP or POLAR to open the drafting settings. See [Drafting aids](#topic:drafting-aids).
