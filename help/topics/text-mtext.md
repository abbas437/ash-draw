---
id: text-mtext
title: Add and edit text
section: Draw and annotate
order: 20
keywords: text, mtext, multiline text, font, bold, italic, stack, fraction, symbol, justification, edit text, ddedit
---

# Add and edit text

## Single-line text

Choose `TEXT` (`T`) and click the insertion point. A dialog asks for **Text (Enter = new line)** and **Text height (drawing units)**. Press **OK** to place it. The height you used becomes the default for the next text, multiline text and multileaders. If you type more than one line, the result is multiline text.

[Show me the Text button](#showme:tool:text)

## Multiline text

`MTEXT` (`MT`) is a command-line tool: type `MT`, click one corner of the text box and then the opposite corner. The width of the box sets the wrap width, and an editor opens in place on the drawing.

The toolbar above the editor offers, from left to right:

- **Font** and **Height** of the selected text
- **B**, **I**, **U** and **O** (bold, italic, underline, overline); <kbd>Ctrl</kbd>+<kbd>B</kbd>, <kbd>Ctrl</kbd>+<kbd>I</kbd> and <kbd>Ctrl</kbd>+<kbd>U</kbd> work too
- **Colour** of the selection
- **a/b** to stack a selected `a/b`, `a#b` or `a^b` as a fraction, and **a b** to unstack
- Bulleted and numbered lists
- **Symbol**, to insert characters such as degree, plus-minus and diameter
- **Justification** (the attachment point of the box)
- **Width factor** and **Oblique angle** of the selection
- Paragraph alignment: left, centre, right
- **OK**

Press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> or **OK** to commit. <kbd>Esc</kbd> closes the editor without saving.

## Edit existing text

- **Multiline text:** double-click it with the Select tool to reopen the editor.
- **Single-line or multiline text:** select it and change the **Text** box in the [Properties panel](#topic:properties-panel). Lines are separated by new lines.
- **Dimensions:** `ED`, `DDEDIT` and `TEXTEDIT` edit the text override of a dimension (see [Dimensions](#topic:dimensions)); double-clicking a dimension does the same.
- To move or copy text, use [Modify objects](#topic:modify-objects) or [grips](#topic:grips).

> **Tip:** Press <kbd>Enter</kbd> inside the editor for a new paragraph. The editor ignores drawing shortcuts while you type.

> **Note:** Formatting codes the editor does not understand are kept as they are and shown in a different style; they are not lost when you commit.
