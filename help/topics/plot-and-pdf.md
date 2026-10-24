---
id: plot-and-pdf
title: Print, plot to PDF and publish
section: Output
order: 10
keywords: print, plot, PDF, PUBLISH, scale, paper, lineweights, monochrome, layout, window, fit to paper, plot style
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
| Monochrome | Prints in black; **Keep greys** leaves grey linework grey |
| Use lineweights | Prints the layer and object lineweights |
| Plot transparency | Honours transparency |

**Pick window…** asks for two corners on the drawing. Choose Window and no window is stored yet, and you are asked for one.

## Plot a layout

On a layout tab the dialog is titled with the layout name. It offers Plot area (Layout, Extents, Window), Paper (the layout's own paper or a standard size), Fit to paper, Scale (paper : layout) and the same colour options. The sheet on its own paper is always 1:1. A line under the fields shows the resulting scale.

## Publish

1. Choose **Publish to PDF…**.
2. Tick the sheets (every open drawing's Model tab and layouts), one page each in list order.
3. Choose paper, Fit to paper, the plot area of model sheets (Extents or Current view) and the colour options, then click **Publish**.

## Things to know

- A layer set to **Not plotted** in the Layers panel is shown but left out of every plot ([Layers](#topic:layers)).
- If the plot is larger than the paper at the chosen scale, a warning says the edges are cut off.
- A 1 : N plot of a drawing with no units asks once what one drawing unit is (millimetre, metre, inch or foot). The answer is not saved in the file.
- Latin, Greek, Cyrillic and Arabic text is drawn with bundled fonts. Chinese, Japanese and Korean text cannot be drawn in this version ([Limitations](#topic:limitations)).

> **Tip:** Use [layouts and viewports](#topic:layouts-viewports) to set the scale visually, then plot the layout.
