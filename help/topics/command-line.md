---
id: command-line
title: Command line
section: Getting started
order: 80
keywords: command line, type commands, aliases, prompt, options, coordinates, relative, polar, feet and inches, decimal comma, history, F2, repeat, Enter, Esc, unknown command
---

# Command line

The command line is the strip at the bottom of the window. Use it to start tools by name, answer a tool's prompts, and enter exact coordinates. For the full list of commands, see the [Command reference](#topic:command-reference).

## Typing a command

Press any printable key while the drawing has focus and the command line takes it, so you can simply start typing. Type a command name or its short alias (for example `L` for `LINE`, `C` for `CIRCLE`, `TR` for `TRIM`) and press <kbd>Enter</kbd>. Names are not case-sensitive. [Show me](#showme:el:cmd)

If the text is neither a command nor a coordinate, the program shows `Unknown command "..."` as a message and records it in the command history.

> **Tip:** If you type while a menu, dialog or other text box has focus, the key goes there instead. Click the drawing first.

## The prompt

The prompt to the left of the input box says what the active tool wants next, for example `LINE  specify first point`. When no tool is running it is blank and the history shows it as `Command:`. [Show me](#showme:el:prompt)

Some prompts list option keywords in square brackets, such as `[Distance/Radius/aNgle/ARea/eXit]`. Type the keyword or its capital letters and press <kbd>Enter</kbd>. A prompt can also show a default in angle brackets, such as `<Window>`, which is what you get if you just press <kbd>Enter</kbd>. Typed text goes to the active tool first, so inside a tool a word such as `U` or `C` is read as that tool's option, not as a command.

## Finishing, repeating and cancelling

| Key | What it does |
|---|---|
| <kbd>Enter</kbd> | Finishes the current tool or step (ends a selection, finishes a polyline). |
| Right-click | The same as <kbd>Enter</kbd> in a running tool. A few tools use it to cancel or to place. |
| <kbd>Space</kbd> | The same as <kbd>Enter</kbd> only where a tool takes it, such as grip editing and symbol placement. In other places it types a space. |
| <kbd>Enter</kbd> on an empty line, with no tool running | Repeats the last tool you used. |
| <kbd>Esc</kbd> | Cancels the running tool and clears the input box. |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Recalls earlier inputs (see below). |

> **Note:** Selecting is not a tool run, so repeating skips it: <kbd>Enter</kbd> repeats the last drawing or modify tool, not Select.

## Recalling earlier inputs

With an empty input box, press <kbd>↑</kbd> to bring back the previous thing you typed and keep pressing it to go further back. <kbd>↓</kbd> goes forward again and, past the newest input, leaves the box empty. Repeated identical entries are stored once.

## Entering coordinates

When a tool asks for a point, you can type it instead of clicking. Use `.` for decimals.

| Type | Meaning |
|---|---|
| `x,y` | Absolute point, for example `100,50`. |
| `x,y,z` | The third number is checked and then ignored, because drawing is 2D. |
| `@dx,dy` | Relative to the last point, for example `@10,0`. |
| `distance<angle` | Polar from the origin, angle in degrees. |
| `@distance<angle` | Polar from the last point, for example `@25<45`. |
| `distance` | A bare number goes that far from the last point in the direction of the cursor. |

Angles follow the drawing's angle base and direction settings (the `ANGBASE` and `ANGDIR` header values), so 0 may not point along +X in every drawing.

### Distance along the tracking line

When object snap tracking or polar tracking shows a tracking line and the cursor is on it, a bare number is measured along that line from the tracking point, not from the last point. Type `1250` and press <kbd>Enter</kbd> to land exactly 1250 units along the line. See [Drafting aids](#topic:drafting-aids) and [Object snaps](#topic:object-snaps).

### Feet and inches

In a drawing whose units are inches or feet, you can type lengths such as `12'`, `12'6"`, `12'-6"`, `6-1/2"` or `1/2"` in any position where a length is expected, including inside a coordinate pair (`@12',6"`). Inch drawings give the result in inches and foot drawings in feet. In other units these forms are not accepted.

### Decimal comma

If the text contains a semicolon, the semicolon separates the two numbers and a comma becomes a decimal comma. So `1,5;2` means x = 1.5, y = 2. Without a semicolon, the comma separates x from y.

> **Tip:** You can mix typing and clicking in the same command, for example click the first point of a line and type `@100<0` for the second.

## Command history

Everything you type, with the prompt it answered, and messages such as `ID` and `LIST` results and errors, are kept in the command history. The last three lines float over the bottom of the drawing; clicks and the mouse wheel pass through them to the drawing.

To see more, press <kbd>F2</kbd> or choose **View ▸ Panels ▸ Command history**. The history opens upward to about twelve lines. You can select text in it, and **Copy** copies the whole history to the clipboard. Press <kbd>F2</kbd> or <kbd>Esc</kbd>, or click the close button, to collapse it and return the keyboard to the drawing. The window keeps the latest 500 lines, shared by all open drawings.
