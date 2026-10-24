---
id: limitations
title: What this program can and cannot do
section: Getting started
order: 110
keywords: limitations, supported objects, proxy, 3dsolid, ole, fonts, dimensions, dwg save
---
This summarises **Help ▸ What this program can and cannot do**. Read it before relying on the program for important work.

## Supported
- Paper-space layouts, their objects and viewports are read and saved back. Viewport clip boundaries (polygon, circle and other closed shapes) are drawn and kept.
- Objects: lines, polylines, circles, arcs, ellipses, splines, xlines and rays, text, multiline text, points, solids, 3D faces, hatches, blocks and attributes, dimensions (as drawn), leaders, multileaders, multilines, images, wipeouts and external references.

## Partly supported
- **Proxy objects** (ACAD_PROXY_ENTITY, for example Civil 3D objects) are drawn from their saved graphics and cannot be edited; Save as DXF keeps them. Other custom objects (for example AECC_ ones) are drawn the same way but are not written when you save.
- **OLE objects** are drawn from their saved preview picture (a frame when there is none it can show).
- **Dimensions** are displayed as stored; they cannot be edited as dimensions, but can be moved, copied or exploded.
- **Fonts:** text uses a system font, so widths differ slightly from the original CAD fonts.

## Not supported
3D solids (3DSOLID), BODY, REGION and custom objects without saved graphics are not shown and not written. Other unknown object types are skipped. Skipped objects are reported when you open the file, and you are told before saving what a save leaves out.

## Saving
DXF is the reliable option. With the optional ODA File Converter, DWG is saved in AutoCAD 2018 format or an older version you choose. Without it, saving as DWG is experimental and off by default. See [Saving and file formats](#topic:save-and-formats).
