---
id: markup-review
title: Markups and the Comment Review Sheet
section: Review
order: 20
keywords: markup, MKC, MKR, MKT, review, comment, CRS, comment review sheet, status, code, renumber, reviewer
---

# Markups and the Comment Review Sheet

Use markups to mark up a drawing during review. Every markup is a dashed red shape (or a note on its own) plus a short comment written on the sheet. Revision clouds and bare reference numbers are not used.

## Place a markup

| Tool | Command | What you do |
|---|---|---|
| Markup circle ([show me](#showme:tool:mkc)) | **MKC** | Click the centre, then the radius (or type it) |
| Markup rectangle ([show me](#showme:tool:mkr)) | **MKR** | Click two opposite corners |
| Markup note ([show me](#showme:tool:mkt)) | **MKT** | Click where the comment goes |

After the shape, a **Markup comment** box asks for the text. A comment is required: if you leave it empty, nothing is added. Each markup is one undo step. On your first markup you are asked for your name or initials; change it later with **Author…**.

## The Markups panel

The panel ([show me](#showme:el:mk-panel)) lists every markup with its number, comment, author and date. Click a row to zoom to it.

- The **filter** (All / Open / In progress / Closed) shows markups by status.
- **Status** per row: *Open*, *In progress* or *Closed*. Closing a markup that has no code sets **Code A**.
- **Code** per row: A, B or C.
- **×** deletes a markup.
- **Author…** sets the reviewer name.
- **CSV** exports the list (No, Comment, Author, Date, Status).
- **Start no.…** sets the number of the next new markup (used once; later ones continue from the highest).
- **Renumber…** renumbers all markups in their present order from a number you choose (one undo step).

## Export to CRS

**Export to CRS (xlsx)…** ([show me](#showme:el:mk-crs)) saves `<drawing>-CRS.xlsx` beside the drawing. It has one row per markup, for model space and every layout, with the Comment Review Sheet columns No., Sheet / Layout, Comment, Reviewer, Date, Status and Code. The Status cell is coloured by the code (A green, B orange, C red), and Status and Code have drop-down lists.

> **Tip:** Make the comment match the code. If a point is resolved, close it (Code A) rather than leaving it at B.

## Show or hide markups

Choose **View ▸ Show markups** to toggle the markups, for example before plotting a clean copy. See also [Layers](#topic:layers) and [Compare two drawings](#topic:compare-drawings).

> **Note:** Hiding markups only changes their visibility. They stay in the drawing and in the exported sheet.
