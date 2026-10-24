---
id: named-views
title: Named views
section: View
order: 20
keywords: view, named view, save view, restore view, bookmark, set current, rename view
---

# Named views

A named view remembers a part of the drawing so you can return to it in one click. Views belong to the space you are in: the model, or a single layout.

## Save the current display

1. Type `VIEW` (`V`) and press <kbd>Enter</kbd>, or choose **View ▸ Named views…**
2. Click **New…**
3. Type a name. It cannot contain `< > / \ " : ; ? * | , = \``.
4. Under **Boundary**, choose **Current display**, or **Define window** and pick two corners on the drawing.
5. Click **OK**.

If the name is already used, you are asked whether to replace that view.

## Go to a view

- Choose its name from the list at the bottom of the **View** menu. The list shows up to ten views of the current space.
- Or open **Named views…**, select it and click **Set current**. Double-clicking a name does the same.

## Manage views

| Button | What it does |
|---|---|
| Set current | Shows the selected view |
| New… | Saves a new view |
| Update | Replaces the selected view with the current display |
| Rename… | Gives the view a new name |
| Delete | Removes the view |

The dialog also shows the view's centre, width and height under the list.

> **Note:** Views saved as 3D views in another program are listed as "cannot be shown". You can still rename or delete them.

> **Tip:** Named views do not work inside a viewport. Leave it first with `PSPACE`.

A view change counts as its own step for `ZOOM` Previous. See [zoom and pan](#topic:navigate-zoom-pan) and [layouts and viewports](#topic:layouts-viewports).
