---
id: markup-review
title: Markups and the Comment Review Sheet
section: Review
order: 20
keywords: markup, MKC, MKR, MKT, MKIMPORT, import, round, follow-up, Rev, review, comment, CRS, comment review sheet, status, code, renumber, reviewer
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
- **Status** per row: *Open*, *In progress* or *Closed*. Closing a markup that has no code sets **Code A**; setting it back to Open or In progress clears Code A.
- **Code** per row: A, B or C. Choosing **Code A** closes the markup, so the code and the status always agree.
- **×** deletes a markup.
- **Author…** sets the reviewer name.
- **CSV** exports the list (No, Rev., Comment, Author, Date, Status, Follow-ups). Status is the latest round's, and Follow-ups holds one `Rev.xx: text` line per follow-up in the same cell.
- **Start no.…** sets the number of the next new markup (used once; later ones continue from the highest).
- **Renumber…** renumbers all markups in their present order from a number you choose (one undo step).

## Review rounds and follow-ups

When a contractor resubmits a drawing, review it again in a new round and answer each earlier comment under the original.

- **Round:** field in the panel shows the review round (for example Rev.01). Every new markup and follow-up gets this round. The round is remembered for the drawing once you use it, so reopening the drawing keeps it; type a new label when the next resubmission arrives. Importing markups from the previous revision moves it on to the next round for you.
- **Follow-up…** opens the follow-up dialog; double-click a row to open it too. Enter the comment, the code and the status; the round is the one in the panel's **Round** field. There is one follow-up per round: if the markup already has one for that round, the dialog edits it. Removing a follow-up takes effect when you click **Save**; **Cancel** leaves everything as it was.
- **Code A closes the item.** For leftover minor points, add a new markup instead of leaving the item at B.
- On the sheet, each follow-up appears under the original comment as a blue `Rev.xx:` line. The status and code of the markup are the latest round's.

## Import markups from the previous revision

Bring the markups of the previous revision into the new one so you can check each in turn.

1. Click **Import…** in the Markups panel, or type **MKIMPORT**.
2. Pick the previous revision's DXF or DWG.
3. Choose **Bring all** or **only open** (not closed and not Code A; markups without a code are included).
4. The drawings are aligned automatically as in [Compare two drawings](#topic:compare-drawings), and the alignment quality is shown as a percentage. Choose **Aligned to the content** (offered when the alignment worked) or **Place at same coordinates**. If the new revision could not be aligned, the markups go at the same coordinates; move them afterwards if needed.

Markups already in the drawing are skipped as duplicates. If a number is already taken, the clash is reported and the markup is not renumbered. One undo removes everything the import added. If you switch to another drawing while the import is aligning, it is cancelled ("Import cancelled: the drawing was switched") and nothing is added.

## Export to CRS

**Export to CRS (xlsx)…** ([show me](#showme:el:mk-crs)) saves `<drawing>-CRS.xlsx` beside the drawing. It has one row per markup, for model space and every layout, with the Comment Review Sheet columns:

| Column | Content |
|---|---|
| No. | The markup number |
| Rev. | The round the markup was made in |
| Sheet / Layout | Model or the layout name |
| Comment | The original comment, then the follow-ups as blue `Rev.xx:` lines |
| Reviewer | The author |
| Date | The date |
| Status | The latest round's status, coloured by its code: A green, B orange, C red |
| Code | The latest round's code |

Status and Code have drop-down lists.

> **Tip:** Make the comment match the code. If a point is resolved, close it (Code A) rather than leaving it at B.

## Show or hide markups

Choose **View ▸ Show markups** to toggle the markups, for example before plotting a clean copy. See also [Layers](#topic:layers) and [Compare two drawings](#topic:compare-drawings).

> **Note:** Hiding markups only changes their visibility. They stay in the drawing and in the exported sheet.
