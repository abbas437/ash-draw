---
id: properties-panel
title: Properties panel
section: Layers and properties
order: 30
keywords: properties, PROPERTIES, PR, CH, MO, MATCHPROP, MA, painter, colour, ACI, linetype, lineweight, transparency, vertex, radius, change
---

# Properties panel

The **Properties** panel shows and edits the settings of the selected objects. Open it with `PROPERTIES` (`PR`), `CH` or `MO`, or [show me the panel](#showme:panel:props).

## The header

- **N selected - TYPE** - for example "1 selected - CIRCLE". When more than one object is selected only the count is shown.
- **Defaults for new objects** - with nothing selected the panel edits the settings that new objects will receive.

## Common fields

These appear for every selection:

- **Layer** - move the objects to another layer.
- **Colour** - an AutoCAD colour index (ACI) value, **ByLayer** or **ByBlock**.
- **Linetype** - **ByLayer** or any linetype loaded in the drawing.
- **Lineweight** - **ByLayer**, **Default** or a width.
- **Transparency** - 0 to 90 %, or ByLayer/ByBlock.

When the selected objects differ, the field shows **varies** until you choose a value, which is then applied to all of them.

## Geometry fields

With exactly one object selected, its geometry is editable. Type a number and press <kbd>Enter</kbd> or move to another field. A value that is not valid is put back.

- **Line** - Start X/Y, End X/Y.
- **Circle** - Center X/Y, Radius, Diameter.
- **Arc** - Center X/Y, Radius, Start angle, End angle.
- **Ellipse** - Center X/Y, Major radius, Ratio.
- **Block insert** - Position X/Y, Scale X, Scale Y, Rotation.
- **Text and MText** - Height, Rotation and the text itself.
- **Dimension** - Text override, with the measurement shown read-only.
- **Viewport** - the viewport scale (see [Layouts and viewports](#topic:layouts-viewports)).

### Polylines

A polyline shows one vertex at a time, for example "3 / 8". Use the **<** and **>** buttons to step to the previous or next vertex; stepping wraps round at the ends. The X and Y fields edit the vertex shown.

> **Note:** Every change made in the panel is a single undo step.

## Copying properties

`MATCHPROP` (`MA`) copies settings from one object to others. Pick the source object, then click or window the destinations, and press <kbd>Enter</kbd> to finish. Type `S` after picking the source to open **Property Settings** and choose which properties are copied. Your choice is remembered for the session.

Related topics: [Layers panel](#topic:layers), [Modify objects](#topic:modify-objects), [Quick select and purge](#topic:quick-select-purge).

[Show me the Properties panel](#showme:panel:props)
