---
id: preferences
title: Preferences
section: Getting started
order: 60
keywords: preferences, settings, zoomfactor, autosave, dwg save, converter, cache, portable, options
---

# Preferences

Choose **Edit ▸ Preferences…** to open the dialog, change what you need, then click **Save**. **Cancel** discards your changes.

## Fields

| Field | What it does |
|---|---|
| Mouse wheel zoom speed (`ZOOMFACTOR`) | How far each wheel notch zooms. A whole number from 3 to 100 |
| Allow saving DWG (experimental) | Turns on the built-in DWG writer. Layouts may not display correctly in AutoCAD |
| Autosave unsaved drawings | Off, or every 5, 10, 20 or 30 minutes (10 by default) |
| DWG converter | Automatic, ODA File Converter or Built-in (LibreDWG) |
| ODA File Converter path | Full path of `ODAFileConverter.exe`; leave empty to detect it. **Browse…** picks the file |
| Status line | Shows the converter in use and whether ODA was found |
| Get ODA File Converter | Opens the download page; shown only when ODA is not found |
| Keep converted DWG drawings | Cache limit: Off, 1, 2, 5 or 10 GB |
| Clear converted-drawing cache | Empties the cache at once |

The converter, ODA and cache fields appear in the desktop app only. For their effect, see [DWG converter](#topic:dwg-converter). For autosave, see [Tabs, autosave and sessions](#topic:tabs-and-sessions).

## Change the zoom speed

1. Open **Edit ▸ Preferences…**.
2. Type a whole number from 3 to 100 in the zoom speed field.
3. Click **Save**.

If the value is not a whole number in that range, the speed is not changed and a message says why. You can also use the `ZOOMFACTOR` command.

## Where settings are kept

Settings are stored in a `settings.json` file in the program's user data folder (on Windows, under `%APPDATA%`), so they survive updates and apply to every drawing.

The **Portable** build keeps its settings next to the `.exe`, in a folder called `ASH-Draw-Studio-data`. Move that folder with the `.exe` to take your settings with you.

> **Note:** Window layout choices such as the tool panel position, tool labels and the side panel mode are saved automatically as you change them. They are not in the Preferences dialog. See [Customise toolbars](#topic:customize-toolbars).

> **Tip:** The "start new or reopen last session" choice is remembered when you tick **Always do this** on the start-up offer.
