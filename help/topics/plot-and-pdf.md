---
id: plot-and-pdf
title: Print, plot to PDF and publish
section: Output
order: 10
keywords: print, plot, PDF, PUBLISH, scale, paper, lineweights, monochrome, layout, window, fit to paper, plot style, CTB, pen table, plot style table, screening
---

# Print, plot to PDF and publish

All three produce vector output. **File ▸ Print…** (`PLOT`, `PRINT`, Ctrl+P) sends it to the system print dialog, **File ▸ Plot to PDF…** (`PDF`) saves a file, and **File ▸ Publish to PDF…** (`PUBLISH`) puts several sheets in one PDF.

## Plot the model

1. Choose **Print…** or **Plot to PDF…** on the Model tab.
2. Set the fields below.
3. Click **Print** or **Save**.

| Field | Choices |
|---|---|
| Page size | Fit to drawing, standard sizes, or Custom (10 to 5000 mm each way) |
| Orientation | Automatic, Landscape, Portrait |
| What to print | Extents, Current view, Window, Named view |
| Fit to paper | Scales the plot to the page |
| Scale (paper : drawing) | `1 :` N, used when Fit to paper is off |
| Centre the plot | Centres it on the page |
| Plot style table | None, `acad.ctb`, `monochrome.ctb`, `grayscale.ctb`, the tables you loaded, or **Load .ctb…** (see Plot style tables (CTB) below) |
| Monochrome | Prints in black; **Keep greys** leaves grey linework grey. Not available while a plot style table is chosen |
| Use lineweights | Prints the layer and object lineweights |
| Plot transparency | Honours transparency |

**Pick window…** asks for two corners on the drawing. Choose Window and no window is stored yet, and you are asked for one.

## Plot a layout

On a layout tab the dialog is titled with the layout name. It offers Plot area (Layout, Extents, Window), Paper (the layout's own paper or a standard size), Fit to paper, Scale (paper : layout), the plot style table and the same colour options. The sheet on its own paper is always 1:1. A line under the fields shows the resulting scale.

## Publish

1. Choose **Publish to PDF…**.
2. Tick the sheets (every open drawing's Model tab and layouts), one page each in list order.
3. Choose paper, Fit to paper, the plot area of model sheets (Extents or Current view) and the colour options, then click **Publish**.

## Plot style tables (CTB)

A colour-dependent plot style table (`.ctb`, a "pen table") decides how each of the 255 AutoCAD colours plots: the pen colour, screening (a lighter tint, in percent), greyscale, lineweight and linetype. Contractors plot their sheets with their own table, so the same table makes your PDF look like their print.

- **Built-in tables:** `acad.ctb` (everything as drawn), `monochrome.ctb` (every colour black) and `grayscale.ctb` (each colour as its grey).
- **The contractor's table:** in the **Plot style table** list choose **Load .ctb…** and pick the `.ctb` file. It is added to the list and remembered: up to five tables totalling about 60 KB (the oldest is dropped first). A table too large to remember, or one that could not be saved, is listed and used until the program is closed, and the dialog says so. A file that is not a plot style table gives a message and is not added.
- **The last choice is remembered** for the next plot. While a table is chosen, Monochrome and Keep greys are off and the dialog says "The plot style table sets the colours".
- **A layout's own table:** the page setup of a layout can name a table (AutoCAD layouts usually do). When that table is built in or loaded, plotting the layout starts with it; otherwise the dialog says "This layout uses '<name>'" with **Load…**. Publish plots each layout with its own table when it is available, and the other sheets with the table chosen in the dialog. Choose or change a layout's table in **Page setup…** (right-click the layout tab); it is saved in the DXF.
- **Comparison drawings keep their colours:** a comparison tab (and its sheet in Publish) always plots without a table, so its changed, added and removed colours stay as compared.
- **True colours are not changed:** a table maps only the 255 index colours, so an object with a true (RGB) colour plots in its own colour.
- **`monochrome.ctb` or the Monochrome box:** both plot the colours black, but `monochrome.ctb` also plots greys black and leaves true colours in colour; the Monochrome box makes true colours black too, and with **Keep greys** keeps grey linework grey.
- **Named plot style tables (`.stb`) are not supported yet.**

The screen, PNG export and SVG export are not affected by plot style tables.

## Things to know

- A layer set to **Not plotted** in the Layers panel is shown but left out of every plot ([Layers](#topic:layers)).
- If the plot is larger than the paper at the chosen scale, a warning says the edges are cut off.
- A 1 : N plot of a drawing with no units asks once what one drawing unit is (millimetre, metre, inch or foot). The answer is not saved in the file, but the program remembers it for that file (by its full path; in the browser build by file name and size) for the last 200 drawings, and preselects it the next time with "(remembered)" in the prompt. Choose another unit to change it.
- Latin, Greek, Cyrillic and Arabic text is drawn with bundled fonts. Chinese, Japanese and Korean text cannot be drawn in this version ([Limitations](#topic:limitations)).

> **Tip:** Use [layouts and viewports](#topic:layouts-viewports) to set the scale visually, then plot the layout.
