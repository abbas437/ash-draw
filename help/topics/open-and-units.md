---
id: open-and-units
title: Opening drawings, tabs and units
section: Getting started
order: 20
keywords: open, dwg, dxf, drag, drop, recent, convert, oda, incomplete, xref, image, units, unitless, millimetres, metres
---
## Open a drawing
- **File ▸ Open…** (<kbd>Ctrl</kbd>+<kbd>O</kbd>, or `OPEN`): choose one or more DWG or DXF files. Each opens in its own tab.
- **Drag and drop:** drop a DWG or DXF file on the drawing area. Only the first dropped file is opened.
- **File ▸ Recent files…**: the drawings you opened recently. See [Tabs and sessions](#topic:tabs-and-sessions).
- Double-click a file in Windows Explorer, or use **Open with**.

If the file is already open, its tab is brought to the front. A blank, untouched *Untitled* tab is replaced by the drawing you open.

## DWG conversion and progress
A DWG is converted before it is shown. The message at the bottom shows **Converting DWG…** with the elapsed time; after 30 seconds it adds *(large drawings can take a few minutes)*. Click **Cancel** in the message to stop.

If the file needs the ODA File Converter, **Cannot open this file** explains why; **Open download page** takes you to it. See [DWG converter](#topic:dwg-converter).

## Messages you may see
| Dialog | What it means |
|---|---|
| **Incomplete DXF file** | The file ends early. **Open anyway** shows what was read; Save then writes a new file and never overwrites the original. |
| **Opened with limitations** | Lists what could not be shown (for example skipped object types or missing images). **Converter messages** shows the converter's own output. |

The drawing opens on the layout it was saved on, as in AutoCAD.

## External references and images
Xrefs and raster images are loaded with the drawing. If they are outside the drawing's folder you are asked first whether to load them. Images that cannot be found are shown as a red frame with the file name. See [External references and images](#topic:xrefs-images).

## Units
The status bar shows the drawing units ([Show me](#showme:el:units)). Click it, or use **Format ▸ Units…** (`UNITS`, `UN`), to open **Drawing units**:

| Option | Effect |
|---|---|
| Drawing units | The unit lengths are labelled in. |
| Precision | Decimal places shown. |
| Unitless: 1 unit is (this session) | Shown for drawings without units: what one unit stands for, for this session only. |

> **Important:** Changing units changes how lengths are labelled; it does not scale the drawing. The change is one undo step.

If a drawing says millimetres but its coordinates look like a map or survey grid in metres, a note appears over the drawing with a **Units…** button. Nothing changes unless you choose so.
