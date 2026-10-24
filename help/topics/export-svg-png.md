---
id: export-svg-png
title: Export SVG and PNG images
section: Output
order: 20
keywords: export, SVG, PNG, image, picture, background, lineweights, raster, vector
---

# Export SVG and PNG images

Use these to put a drawing into a report or a web page. Both export the whole drawing (its extents); for a chosen area or paper size, use [Plot to PDF](#topic:plot-and-pdf).

## Export an SVG

1. Choose **File ▸ Export SVG…**.
2. Choose a name and folder, then save.

The SVG is vector graphics, so it scales without losing sharpness. It is written with a white background and in colour, with lineweights on. Its width and height are in millimetres, using the drawing's units. If any object cannot be exported (for example it has invalid coordinates), the file is still saved and a box titled **SVG exported with warnings** lists what was left out.

## Export a PNG

1. Set the options you want first, because PNG follows what you see:
   - **View ▸ Model space background: dark** gives a dark background; otherwise it is white.
   - **View ▸ Show lineweights** decides whether lineweights are drawn ([display options](#topic:display-options)).
2. Choose **File ▸ Export PNG image…**.
3. Choose a name and folder, then save.

The PNG is 3000 pixels along its longer side and fits the extents of the drawing with a small margin.

| | SVG | PNG |
|---|---|---|
| Kind | Vector | Raster |
| Background | White | White, or dark if the dark background is on |
| Lineweights | On | Follow Show lineweights |
| Size | Millimetres, from the drawing units | 3000 pixels on the longer side |

> **Note:** Neither export has a dialog, so there is nothing to choose except the file name. For monochrome output, a paper size or a scale, use **Plot to PDF…**.

> **Tip:** Files are suggested in the drawing's folder with the drawing's name and the new extension.
