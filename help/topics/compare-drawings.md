---
id: compare-drawings
title: Compare two drawings
section: Review
order: 10
keywords: compare, COMPARE, difference, revision, added, removed, changed, A and B, overlay, change list
---

# Compare two drawings

**File ▸ Compare…** (command **COMPARE**) shows what changed between an original drawing and a revised one. The result opens in a **new tab**, so neither source drawing is touched.

## Run a compare

1. Choose **File ▸ Compare…**, or type **COMPARE**.
2. In the **Compare drawings** dialog, pick **Original (A)** and **Revised (B)**. Each can be an open tab, or press **File…** beside the list to load a drawing from disk. The two must be different drawings.
3. Choose how to **Align A to B**: *Automatic*, *None* (compare where they are), or *Pick points* (you click a base point, and optionally a second point, in A and then in B).
4. Adjust **Tolerance** and **Group distance** if needed (both are in drawing units; the defaults suit the units of B). Use **Ignore layers…** to leave out layers of B, such as a revision table.
5. Press **Compare**. A progress message appears with a Cancel button.

> **Note:** If B has no units set, the program asks what one drawing unit means before comparing, because the tolerance and group distance depend on it. See [Open files and units](#topic:open-and-units).

## Reading the result

| Colour | Meaning |
|---|---|
| Grey | Unchanged |
| Green | Added (only in B) |
| Red | Removed (only in A) |
| Amber | Changed in shape or position |

Each group of nearby changes is framed by a **dotted rectangle**. Revision clouds are deliberately not used, so the sheet stays readable.

## The Compare panel

The side panel ([show me](#showme:el:compare-panel)) lists the counts and the change groups.

- **Previous** and **Next** zoom to each change in turn.
- **View** switches between *Differences*, *Overlay*, *A only* and *B only*.
- **Show property-only changes** draws objects that differ only in colour, linetype, lineweight or layer, as faint dashed grey on layer COMPARE-PROPS.
- **Legend on sheet** draws the legend below the drawing so it appears on the plot.
- **Copy list** and **Export CSV…** save the change list (group, change, layer, object type, X, Y, details).
- **Plot to PDF…** opens the Plot dialog for the compare drawing.

> **Tip:** The result is an ordinary drawing in its own tab. See [Layers](#topic:layers) and [Tabs and sessions](#topic:tabs-and-sessions).

> **Note:** While a compare is running, the tabs of A and B cannot be closed, and a second compare cannot start. Wait for it to finish or cancel it.
