---
id: save-and-formats
title: Saving and file formats
section: Getting started
order: 30
keywords: save, save as, dxf, dwg, bak, backup, version, libredwg, oda, overwrite, experimental
---
## Save (Ctrl+S)
**File ▸ Save** (<kbd>Ctrl</kbd>+<kbd>S</kbd>, `SAVE`) depends on where the drawing came from:

| Drawing | What Save does |
|---|---|
| Opened from DXF | Overwrites the DXF. |
| Opened from DWG, ODA File Converter installed | Writes back to the same DWG in its own version, keeping the previous file as a `.bak` copy. |
| Opened from DWG, no ODA | Tells you once (**Save as DXF**), then saves a DXF copy. |
| New drawing | Asks for a file name (DXF). |

If the file holds objects this program cannot keep, **Overwrite the original file?** offers **Save as new file…**, **Overwrite original** or **Cancel**. A drawing opened from an incomplete DXF is never saved over the original.

## Save as DXF
**File ▸ Save as DXF…** (`SAVEAS`) always writes DXF. DXF keeps everything this program supports and is the reliable option.

## Save as DWG
The menu item appears only when DWG can be written:
- **With the ODA File Converter:** **Save as DWG…** asks for the **DWG version** (AutoCAD 2018 by default; your last choice is remembered). Choose an older version for older programs.
- **Without it:** **Save as DWG… (experimental)** uses LibreDWG and is off by default. Turn it on in **Edit ▸ Preferences…** ([Preferences](#topic:preferences)). AutoCAD and DWG TrueView may not open such a file, layouts and viewports may appear empty, and text rotation and some hatch details can be lost.

After a DWG save the program re-reads the file. If it differs, **The DWG does not match your drawing** lets you save anyway or cancel; the drawing then stays marked as unsaved so you can still save a DXF.

> **Tip:** Dialogs about DWG offer **Get ODA File Converter**, which opens its download page.

## Other formats
**Plot to PDF…**, **Publish to PDF…**, **Export SVG…** and **Export PNG image…** are on the File menu. See [Plot and PDF](#topic:plot-and-pdf) and [Export SVG and PNG](#topic:export-svg-png).
