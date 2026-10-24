---
id: symbol-count
title: Count symbols and place a schedule
section: Blocks and symbols
order: 50
keywords: symcount, bcount, count, schedule, quantity, symbol schedule, export, excel, csv, takeoff
---

# Count symbols and place a schedule

**SYMCOUNT** (alias **BCOUNT**) counts how many times each symbol (block) is inserted, shows the result in a table, exports it, and can place a symbol schedule in the drawing.

## Open the count

- Type **SYMCOUNT** or **BCOUNT**, or
- press **Count…** in the Symbols panel ([show me](#showme:el:sym-count)).

If objects are selected, only those are counted. Otherwise the current space is counted: model space, or the active layout.

## The Symbol count dialog

The first line says what is being counted. The table lists each **Symbol**, its **Count** and the **Layers** it is on, with a total below.

- **Include nested blocks** also counts symbols that sit inside other symbols.
- **Excel (.xlsx)…** saves `<drawing>-symbol-count.xlsx`.
- **CSV…** saves `<drawing>-symbol-count.csv`.
- **Schedule text height** is the text size of the schedule, in drawing units. The default is 2.5 mm on paper at the current **Drawing scale 1:** (see [Symbols panel and palette](#topic:symbols)).

> **Note:** When no symbols are found, nothing is exported or placed; a message says so.

## Place the schedule

Press **Place in drawing**, then click the top-left corner of the schedule. The program draws a table with a picture of each symbol, its description and quantity, and a total row. Everything goes on the layer **SYMBOL-SCHEDULE**, which is created if needed, and the whole schedule is one undo step. The new objects are selected afterwards, so you can move them at once.

> **Tip:** The schedule is ordinary lines, text and block insertions, so you can edit it like any other objects. See [Layers](#topic:layers) and [Blocks](#topic:blocks).

Press **Close** to leave without placing anything.
