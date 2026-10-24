---
id: xrefs-images
title: External references and images
section: View
order: 50
keywords: xref, external reference, XREF, XATTACH, XCLIP, image, raster, missing file, red frame, outside folder, Load, Don't load
---

# External references and images

An external reference (xref) shows another drawing inside this one without copying it. Raster images in a drawing are loaded from their files in the same way.

## Open the External References panel

Choose **View ▸ External references…**, or enter `XREF` (`XR`).

| Column or button | Meaning |
|---|---|
| Name, Status, Path, Inserts | The reference, whether it loaded, the saved path, and how many times it is inserted |
| Reload | Reads the file again |
| Unload | Drops the loaded content but keeps the reference |
| Browse… | Points the reference at another file |
| Attach… | Starts `XATTACH` |

Status shows **Not found**, **Unreadable** or **Circular reference** when a file cannot be used.

## Attach a drawing

1. Enter `XATTACH` (`XA`), or click **Attach…** in the panel.
2. Choose a DXF or DWG file.
3. Click the insertion point.

The path is saved relative to the current drawing when both are on the same drive, so keep the files together when you move them.

## Clip a reference

Enter `XCLIP` (`XC`), select the reference, and choose a rectangular, polygonal or polyline boundary. Options also turn the clip on or off, delete it, or invert it.

## Missing images and references

An image whose file cannot be found is drawn as a **red frame with the file name** inside it. Put the file next to the drawing, then reopen the drawing. A reference that cannot be found shows **Not found** in the panel; use **Browse…** or **Reload**.

## Files outside the drawing's folder

Only files in the drawing's folder, or below it, are read automatically. If a drawing refers to anything else, a prompt titled **Files outside the drawing folder** lists the paths.

- **Load** reads them.
- **Don't load** leaves them out; they appear as missing.

> **Important:** Choose **Load** only for drawings you trust, because it lets the file read other places on your computer.

> **Note:** See [Opening files and units](#topic:open-and-units) for how paths are resolved, and [Troubleshooting](#topic:troubleshooting) if a reference still will not load.
