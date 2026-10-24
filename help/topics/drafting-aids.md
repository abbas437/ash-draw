---
id: drafting-aids
title: Ortho, polar, tracking and grid
section: Drafting aids
order: 20
keywords: ortho, polar, otrack, object snap tracking, grid, snap to grid, F7, F8, F9, F10, F11, GRID, SNAP, increment angle, tracking line
---

# Ortho, polar, tracking and grid

These status bar toggles help you place points accurately. Each one is switched with a function key or by clicking its button in the status bar.

| Aid | Key | Status bar button |
| --- | --- | --- |
| Ortho | <kbd>F8</kbd> | ORTHO |
| Polar tracking | <kbd>F10</kbd> | POLAR |
| Object snap tracking | <kbd>F11</kbd> | OTRACK |
| Grid display | <kbd>F7</kbd> | GRID |
| Snap to grid | <kbd>F9</kbd> | GSNAP |

## Ortho

[Show me](#showme:status:ortho)

With Ortho on, the point following the previous one is restricted to horizontal or vertical. Use it for orthogonal lines and straight moves.

## Polar tracking

[Show me](#showme:status:polar)

Polar tracking shows a tracking line and a tooltip when the cursor is close to an angle that is a multiple of the increment, such as 45 degrees. Right-click **POLAR** to open the Drafting settings dialog and choose the increment angle (90, 45, 30, 22.5, 18, 15, 10 or 5 degrees). You can also type **Additional angles**, for example `12.5, 80`.

> **Note:** Ortho and Polar switch each other off. Turning one on turns the other off.

## Object snap tracking

[Show me](#showme:status:otrack)

With OTRACK on, rest the cursor briefly on a snap point (an endpoint, midpoint, centre and so on) to acquire it. Then move the cursor away: tracking lines run from the acquired point, and you can pick where two tracking lines cross, or a point in line with an existing feature. Rest on an acquired point again to release it. Acquiring needs [object snaps](#topic:object-snaps) to be on.

## Typing a distance along the tracking line

While a tracking line is showing, type a distance on the [command line](#topic:command-line) and press <kbd>Enter</kbd>. The point is placed that distance along the line from its start.

## Grid

[Show me](#showme:status:grid)

<kbd>F7</kbd> shows or hides the drawing grid. The **GRID** command sets it up:

- **ON / OFF** shows or hides the grid.
- **Spacing**, or just a number, sets the grid spacing and turns the grid on.
- **Major** sets how many grid lines make one major line (1 to 100).
- **Style** chooses **Lines** or **Dots**.

In a layout the spacing is in paper millimetres, separate from the model spacing.

## Snap to grid

[Show me](#showme:status:gridSnap)

<kbd>F9</kbd> makes the cursor jump to grid intervals. The **SNAP** command (`SN`) has **ON**, **OFF** and **Spacing** options. The snap spacing is the grid spacing: changing one changes the other.

> **Note:** Grid snap is used only when no object snap or tracking point is found, so object snaps always win.

See also: [Display options](#topic:display-options), [Keyboard shortcuts](#topic:keyboard-shortcuts).
