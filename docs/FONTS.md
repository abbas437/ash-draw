# Fonts: SHX substitution

AutoCAD SHX shape fonts are Autodesk files and are not shipped. Text whose style uses an SHX font is drawn
with a bundled single-stroke font instead, so it looks and measures like AutoCAD's stroke text:

| Style font (file) | Drawn with |
|---|---|
| `romans`, `simplex`, `txt`, `monotxt`, `isocp`/`isocp2`/`isocp3`, `isoct*`, `romand`, `romanc`, `romant`, `complex`, `italic*`, `scripts`/`scriptc` | Hershey Roman Simplex stroke font |
| any other `*.shx` (company fonts) | Hershey Roman Simplex (as AutoCAD's `FONTALT = simplex.shx`) |
| `gdt.shx`, `amgdt.shx` | canvas path with the letters mapped to GD&T symbols (see GD&T below) |
| `sy*.shx`, `greek*`, `gothic*`, `cyril*` (symbol / non-Latin letter fonts) | canvas TrueType path, as before (no substitute yet) |
| TrueType / OpenType (`arial.ttf`, `isocpeur.ttf`, ...) | the installed font, unchanged |

- Height: the TEXT height is the cap height (AutoCAD SHX rule); a 2.5 TEXT has 2.5-high capitals. Advances
  come from the glyph data (Roman Simplex is the font AutoCAD's `simplex`/`romans` derive from). Width factor
  and oblique angle apply.
  `txt` and `isocp` are approximated with the same glyphs (slightly different widths from AutoCAD).
- `%%c`, `%%d`, `%%p` draw as diameter (Ø), degree (°) and plus-minus (±) strokes.
- The strokes are ordinary drawing paths: screen, PDF and SVG export draw the same lines, in the entity
  lineweight and always continuous (text ignores the linetype, as in AutoCAD).
- Fallback: a TEXT with a character outside the stroke font (e.g. Arabic, CJK from a big font) is drawn
  with the canvas TrueType path as before. gdt.shx GD&T letters are mapped to Unicode symbols (see below).
- MTEXT: runs in an SHX font (the style font, or a `\F`/`\f` run font) are stroked the same way (cap height, `\W`, `\Q`,
  `\T`, `\C` colours, underline / overline / strike and stacks as strokes). Mixed MTEXT is laid out once in core
  (stroke advances for SHX runs, the canvas measure for TrueType runs, wrap width with the same measure); the TrueType
  runs keep that fixed layout on screen and in PDF / SVG. A run with a character the stroke font lacks stays on canvas.
  The first line's baseline is one cap height below the top for SHX runs (0.9 h for TrueType).
- To keep real TrueType text, give the style a TrueType font (e.g. `arial.ttf`); only SHX styles are
  substituted. Saving keeps the style's `.shx` file name, so AutoCAD uses its own SHX on reopen.

## TEXT justification and width (src/core/textMetrics.js)

- All 15 AutoCAD justifications (DXF 72 / 73): Left, Center, Right, Middle, the nine TL..BR combinations,
  Aligned and Fit. Every justification except Left/baseline is placed at the alignment point (group 11).
  Aligned and Fit keep both points (10 and 11) and run the text from 10 to 11: Aligned scales the height and keeps
  the width factor, Fit keeps the height and computes the width factor. Saving writes 11 as read and 10 as the
  baseline start computed from the text width (as AutoCAD stores it).
- Text width for pick boxes, justification and group 10 is measured: SHX styles from the stroke glyph advances,
  TrueType styles with the canvas font (measure registered by the viewport, cached per font and string);
  without a canvas (headless) 0.6 x height per character. Vertical metrics: SHX cap height h with descenders
  7/21 h; canvas text 0.8 h above and 0.2 h below the baseline (the offsets the canvas renderer uses).

Glyph data: Hershey Fonts, `futural.jhf` (public-domain font; distribution notice in THIRD-PARTY-NOTICES.md).

## GD&T fonts (src/core/gdt.js)

`gdt.shx` / `amgdt.shx` draw GD&T symbols for plain lowercase letters. For display only (the stored text, DXF and
DWG keep the letters) a TEXT, MTEXT or dimension text in a style with such a font, or an MTEXT run `\fgdt;`, shows:

| a | b | c | d | e | f | g | h | i | j | k | l | m | n | p | r | s | t | u |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ∠ | ⟂ | ▱ | ⌓ | ○ | ∥ | ⌭ | ↗ | ⌯ | ⌖ | ⌒ | Ⓛ | Ⓜ | ⌀ | Ⓟ | ◎ | Ⓢ | ⌰ | ⏤ |

Source: ARKANCE/CADforum tip 6266, https://www.cadforum.cz/cz/qaID.asp?tip=6266 (letters and the symbol each draws:
u straightness, c flatness, e circularity, g cylindricity, k line profile, d surface profile, a angularity,
b perpendicularity, f parallelism, j position, r concentricity, h circular runout, i symmetry, t total runout,
n diameter, m MMC, l LMC, s RFS, p P-in-circle). Only these 19 letters are mapped; others (q, o, v-z, uppercase) stay
letters. The Unicode choice per symbol is ours (Unicode Miscellaneous Technical / Geometric Shapes). Only one
source gave the full table (other pages searched had images or no table); it matches the earlier provisional table
letter for letter, so nothing disagreed. The page labels `p` "position" but describes it as P in a circle, which is
the projected tolerance zone symbol; we followed the glyph description (Ⓟ). TOLERANCE entities are not rendered by
the app, so there is nothing to map there.
