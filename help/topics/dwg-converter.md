---
id: dwg-converter
title: DWG converter
section: Getting started
order: 40
keywords: dwg, converter, oda, odafileconverter, libredwg, cache, converter log, save as dwg
---

# DWG converter

ASH Draw Studio reads DXF directly. A DWG file is converted first, by one of two converters:

- **LibreDWG**, which is built in.
- The **ODA File Converter**, a free, optional program you install yourself. It opens drawings the built-in converter cannot read, and it lets you save back to DWG (AutoCAD 2000 to 2018).

## Choose a converter

1. Choose **Edit ▸ Preferences…**.
2. Pick an option under **DWG converter**:

| Option | Behaviour |
|---|---|
| Automatic | Uses LibreDWG, and the ODA File Converter when LibreDWG cannot read the file |
| ODA File Converter | Always uses ODA |
| Built-in (LibreDWG) | Always uses LibreDWG |

3. Click **Save**.

## Point the program at ODA

The ODA File Converter is normally detected automatically in `C:\Program Files\ODA`. If you installed it elsewhere:

1. Open **Edit ▸ Preferences…**.
2. Click **Browse…** beside the ODA field and select `ODAFileConverter.exe`, or type the full path. Leave the field empty to detect it automatically.
3. Click **Save**.

The line under the field reports which converter is in use and whether ODA was found. If ODA is missing, click **Get ODA File Converter** to open the download page.

## Converted-drawing cache

Reopening an unchanged DWG skips the conversion. In Preferences, choose how much disk space to keep for this (Off, 1, 2, 5 or 10 GB; the default is 2 GB). Click **Clear converted-drawing cache** to empty it.

## Check what the converter did

A drawing converted from DWG shows a converter item in the status bar. [Show me](#showme:el:conv) it. Click it, or choose **Help ▸ Converter log…**, to see the converter used, the objects read, object types not shown and the converter's messages. A drawing opened from DXF has no log.

> **Note:** A large DWG can take a few minutes to convert. A "Converting DWG…" message with a timer is shown while it runs.

> **Important:** Without ODA, saving as DWG is experimental and off by default (tick it in Preferences). Layouts may appear empty in AutoCAD, so use **File ▸ Save as DXF…** to exchange drawings. See [Save and formats](#topic:save-and-formats) and [Preferences](#topic:preferences).
