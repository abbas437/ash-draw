---
id: layer-states
title: Layer states
section: Layers and properties
order: 20
keywords: layer state, LAYERSTATE, LAS, LMAN, restore, save, import, export, .las, layer manager
---

# Layer states

A layer state is a named snapshot of how your layers are set: which are on, frozen, locked or plotted, and their colour, linetype, lineweight and transparency. Save a state before you change things, then restore it later. States are stored in the drawing.

## Opening the manager

Press **States...** in the [Layers panel](#topic:layers) header, or type `LAYERSTATE` (`LAS`) or `LMAN`. All three open the **Layer states** dialog. [Show me the States button](#showme:el:layer-states).

The dialog lists the saved states with their descriptions. A tick marks a state that matches your layers as they are now.

## Saving

1. Set the layers up the way you want them.
2. Choose **New...**, give the state a name and, if you like, a description, then press **OK**.

If the name already exists you are asked whether to replace it. **Update** re-saves the current layers under the selected name.

## Restoring

Select a state and press **Restore**, or double-click it. The whole restore is one undo step, so `U` brings back what you had.

Under **Restore these properties**, untick any property you want left alone, for example untick **Colour** to restore only on/off and frozen settings. Your choice is remembered between sessions.

Tick **Turn off layers not found in the state** to switch off any layer created after the state was saved. This setting lasts for the session.

> **Note:** The current layer is never frozen by a restore. If the state would freeze it, a message tells you and the layer stays thawed.

## Other buttons

- **Rename...** and **Delete** act on the selected state.
- **Export .las...** saves the selected state as an AutoCAD `.las` file named after it.
- **Import .las...** adds the states from a `.las` file. If a name clashes with one already in the drawing you are asked whether to replace it.

> **Tip:** Save a state called "Plot" with construction layers off, and "Work" with everything on. Switching between them takes two clicks.

See also [Layouts and viewports](#topic:layouts-viewports) for per-viewport freezing, which is separate from layer states.

[Show me the Layers panel](#showme:panel:layers)
