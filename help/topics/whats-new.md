---
id: whats-new
title: What's new
section: About
order: 10
keywords: new, release, beta, changes, updates, version
---

# What's new

The most recent user-visible additions, newest first. For what the program still cannot do, see [Limitations](#topic:limitations).

## Beta 57

- **Rotate and mirror viewports as AutoCAD does.** Turning a viewport off-axis makes it a clipped viewport, and the view turns with the frame. A viewport and its boundary now move together. See [Layouts and viewports](#topic:layouts-viewports).
- **Coordinate entry accepts x,y,z.** Typing three values, or relative values with a third part, is accepted and the height is ignored.
- **Markups have an "In progress" status.** Closing a markup that has no review code sets it to Code A. See [Markup and review](#topic:markup-review).
- **Hatch note on saving.** You are told when a hatch is saved by its pattern name only, because the name is not known and it has no pattern lines.

## Beta 56

- **Drawings with a rotated angle base** now read and save correctly, so angles and polar entry match AutoCAD.
- **Large plots no longer run out of memory.** PDF pages are written as a stream, and Plot, Print and Publish show progress with a Cancel button. See [Plot and PDF](#topic:plot-and-pdf).
- **Feet-and-inches entry** in inch and foot drawings, and **decimal commas** (with semicolons between pairs).
- **Drawings with no units** now ask once what a unit is before a scaled plot, a comparison or a measurement.
- **Markups:** the reviewer is asked on the first markup, each markup carries a review code, you can set the start number or renumber, and you can export to a CRS spreadsheet.
- **Compare** gives a list of changes that you can copy or export to CSV. See [Compare drawings](#topic:compare-drawings).
- **Layers panel** has optional Linetype, Lineweight and Transparency columns.
- **Plot dialog:** keep greys in monochrome, plus ANSI/ARCH and custom paper sizes.
- **External references and images** outside the drawing's folder are loaded only after you agree. See [Xrefs and images](#topic:xrefs-images).

## Beta 55

- **Incomplete DXF files** are detected. You are asked before opening one, and it cannot be saved over the original.
- **Fit-point splines** are drawn.
- **Viewports** show dashes at paper scale and accept polygon clip shapes.
- **Find** searches block attributes, text inside blocks and every layout, and shows where each hit is.
- **Safer saving.** Saving retries on synced or locked folders and keeps a .bak copy only after a good save. See [Saving and formats](#topic:save-and-formats).
- **Converter clean-up.** Stuck converter processes are stopped when you cancel, time out or quit.
- **Crash protection.** The session is written about a second after each tab change, so open drawings come back. See [Tabs and sessions](#topic:tabs-and-sessions).
- Text that is backward or upside down is shown correctly.
