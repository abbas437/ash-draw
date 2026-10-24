---
id: troubleshooting
title: Troubleshooting
section: About
order: 20
keywords: problem, error, cannot open, slow, units, fonts, crash, recovery, settings, report, help
---

# Troubleshooting

### A DWG will not open ("Cannot open this file")

The built-in converter cannot read every DWG; files saved in AutoCAD 2018 format by some programs are a common case. Install the free ODA File Converter, and the program uses it automatically. The error box has an **Open download page** button. In **Edit ▸ Preferences…**, the DWG converter can be Automatic, ODA File Converter or Built-in. If the converter is not found, press **Browse…** to point to it. The **Converter messages** section of the box, and **Help ▸ Converter log…**, show what went wrong. See [DWG converter](#topic:dwg-converter).

### Opening a big DWG is slow

A progress message with a **Cancel** button counts the minutes while the drawing converts. Converted drawings are kept in a cache, so reopening an unchanged DWG skips the conversion. The cache size (Off to 10 GB) and a **Clear** button are in [Preferences](#topic:preferences).

### The drawing is tiny, huge, or the units look wrong

When a drawing says millimetres but its coordinates look like metres, a banner offers **Units…**. You can also choose **Format ▸ Units…** at any time. A drawing with no units asks once what a unit is before a scaled plot, a comparison or a measurement. See [Opening files and units](#topic:open-and-units).

### Xrefs or images are missing

A missing image is shown as a red frame with its file name, and the list is given when the drawing opens. Files outside the drawing's folder are loaded only if you choose **Load** in the "Files outside the drawing folder" box. See [Xrefs and images](#topic:xrefs-images).

### Fonts look different

AutoCAD SHX fonts are not supplied. Text in an SHX style is drawn with a built-in single-stroke font, and a company SHX font also uses it. Give the style a TrueType font to keep real TrueType text.

### PDF text shows question marks or is missing

Plotting draws Latin, Greek, Cyrillic and Arabic text with bundled fonts. Chinese, Japanese and Korean text cannot be drawn in this version. Characters that no font has appear as "?", and a warning lists them. See [Plot and PDF](#topic:plot-and-pdf).

### Save offers "Save as DXF"

Saving back to DWG needs the ODA File Converter, or the experimental option **Allow saving DWG** in Preferences. Otherwise save a DXF copy, which AutoCAD opens directly. See [Saving and formats](#topic:save-and-formats).

### Where are my settings kept?

In the portable version, in a folder called ASH-Draw-Studio-data beside the .exe.

### Recovering after a crash

Unsaved drawings are autosaved (the interval is in Preferences) and offered for recovery at the next start. Your open tabs are also restored. See [Tabs and sessions](#topic:tabs-and-sessions).

### Reporting a problem

Open an issue at [github.com/abbas437/ash-draw/issues](https://github.com/abbas437/ash-draw/issues) or visit [ashdesignsuite.com](https://ashdesignsuite.com). Say what you did, and attach the converter messages if a DWG was involved.

> **Tip:** Known gaps are listed in [Limitations](#topic:limitations); check there first.
