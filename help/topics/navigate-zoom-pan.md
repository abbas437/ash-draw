---
id: navigate-zoom-pan
title: Zoom and pan
section: View
order: 10
keywords: zoom, pan, wheel, fit, extents, window, previous, regen, zoomfactor, scale, navigate
---

# Zoom and pan

## With the mouse

- **Wheel:** scroll to zoom in or out around the pointer.
- **Middle button:** drag to pan. Double-click it to zoom to the extents.
- **Space and drag:** hold <kbd>Space</kbd> with the pointer over the drawing, then drag with the left button to pan.
- **Zoom bar:** the **+**, **−** and **Fit** buttons at the corner of the drawing zoom in, zoom out and fit everything ([show me](#showme:el:z-fit)). **View ▸ Zoom to fit** does the same.

## The ZOOM command

1. Type `ZOOM` (`Z`) and press <kbd>Enter</kbd>.
2. Type an option letter, or click two corners for a window.

| Option | Result |
|---|---|
| All / Extents (`A` / `E`) | Fits the whole drawing |
| Window (`W`) | Zooms to the two corners you pick; this is the default |
| Previous (`P`) | Goes back to the last view |
| Object (`O`) | Zooms to the selected objects |
| `2X` | Scales the view by a factor of 2 |
| `0.5XP` | Sets the scale relative to paper (layouts) |

> **Tip:** `ZE` fits the drawing straight away, without a prompt.

## PAN

Type `PAN` (`P`) and drag to move the view. Press <kbd>Esc</kbd> or <kbd>Enter</kbd> to return to Select.

## Wheel speed: ZOOMFACTOR

1. Type `ZOOMFACTOR` and press <kbd>Enter</kbd>.
2. Enter a whole number from 3 to 100. Higher numbers zoom faster.

You can also set it in **Edit ▸ Preferences…** ([preferences](#topic:preferences)).

## REGEN

If the display looks out of date, type `REGEN` (`RE`) to rebuild it.

> **Note:** Each zoom is its own step for **Previous**, so you can step back through the views you used.

Related: [named views](#topic:named-views), [display options](#topic:display-options), [layouts and viewports](#topic:layouts-viewports).
