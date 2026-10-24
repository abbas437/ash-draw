---
id: tabs-and-sessions
title: Tabs, autosave and sessions
section: Getting started
order: 50
keywords: tabs, close, autosave, recovery, session, restore, recent files, backup, bak, unsaved
---

# Tabs, autosave and sessions

## Working with tabs

Each open drawing has a tab above the drawing area. [Show me](#showme:el:tabbar) the tab bar.

- A dot (●) before the name means the drawing has unsaved changes.
- Click the **×** on a tab, press <kbd>Ctrl</kbd>+<kbd>W</kbd>, or middle-click the tab to close it. You are asked first if it has unsaved changes.
- Press <kbd>Ctrl</kbd>+<kbd>Tab</kbd> to move to the next tab, and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd> for the previous one.
- Right-click a tab for **Close**, **Close other tabs**, **Close tabs to the left**, **Close tabs to the right** and **Close all tabs**. Entries that do not apply are greyed out.

## Autosave and recovery

Drawings with unsaved changes are copied to a hidden folder at a regular interval. This does not change your file.

1. Choose **Edit ▸ Preferences…**.
2. Set **Autosave unsaved drawings** to Off or Every 5, 10, 20 or 30 minutes (10 by default).
3. Click **Save**.

If the program ends without saving, the next start shows **Recover unsaved drawings**:

| Button | Result |
|---|---|
| Recover | Opens each copy as an unsaved tab |
| Discard | Deletes the copies |
| Later | Keeps them and asks again next time |

> **Note:** Autosave and recovery need the desktop app.

## Last session and recent files

When you start with no file to open, the program can offer the previous session.

1. Click **Reopen last session** to bring back the files that were open, or **Start new**.
2. Tick **Always do this** to remember your choice. The program then reopens, or starts new, without asking.

**File ▸ Recent files…** lists the last 15 files you opened. Click one to open it. Files that have moved show "Not found". **Clear list** empties it.

## Backups on save

When Save replaces an existing file, the previous version is kept first. For `Plan A.dwg` the backup is `Plan A.bak`; for `Plan A.dxf` it is `Plan A.dxf.bak`, in the same folder. An older backup is replaced.

> **Tip:** See [Save and formats](#topic:save-and-formats) for the save options, and [Preferences](#topic:preferences) for the autosave interval.
