// shared MTEXT line reordering (screen and PDF): right-to-left lines go in visual order
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMText, layoutMText } from '../src/core/mtext.js';
import { reorderLines } from '../src/core/bidiText.js';

const order = (text) => {
  const lay = layoutMText(parseMText(text, { height: 1 }));
  const out = reorderLines(lay.glyphs, (t, level, g) => t.length * g.h * 0.6);
  return { lay, out };
};
const textsOf = (glyphs, li) => glyphs.filter((g) => g.li === li && g.text.trim()).sort((a, b) => a.x - b.x).map((g) => g.text);

test('two-line MTEXT: digits sit left of the Arabic word on each line', () => {
  const { out } = order('غرفة 12\\Pمطبخ 345');
  assert.deepEqual(textsOf(out, 0), ['12', 'غرفة']);
  assert.deepEqual(textsOf(out, 1), ['345', 'مطبخ']);
  assert.ok(out.filter((g) => g.li === 0).every((g) => g.level != null));
});

test('a three-word Arabic line reads right to left', () => {
  const { out } = order('واحد اثنان ثلاثة');
  assert.deepEqual(textsOf(out, 0), ['ثلاثة', 'اثنان', 'واحد']);
  assert.equal(out.filter((g) => g.text.trim()).every((g) => g.level === 1), true);
});

test('pieces are laid from the line start without gaps, and keep the line width', () => {
  const { lay, out } = order('AHU-1 غرفة 123');
  const g = out.filter((p) => p.li === 0).sort((a, b) => a.x - b.x);
  let x = g[0].x;
  for (const p of g) { assert.ok(Math.abs(p.x - x) < 1e-9); x += p.w; }
  assert.ok(Math.abs(x - g[0].x - lay.lines[0].w) < 1e-9);
});

test('a left-to-right line is returned untouched', () => {
  const lay = layoutMText(parseMText('PUMP P-101', { height: 1 }));
  assert.equal(reorderLines(lay.glyphs, () => 1), lay.glyphs);
});
