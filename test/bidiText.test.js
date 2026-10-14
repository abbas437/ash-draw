// shared MTEXT line reordering (screen and PDF): right-to-left lines go in visual order
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMText, layoutMText } from '../src/core/mtext.js';
import { reorderLines, reorderRules } from '../src/core/bidiText.js';

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

test('an underline follows its Arabic word to the word\'s new x-range', () => {
  const lay = layoutMText(parseMText('\\Lغرفة\\l 12', { height: 1 }));
  const out = reorderLines(lay.glyphs, (t, level, g) => t.length * g.h * 0.6);
  const word = out.find((g) => g.text === 'غرفة');
  assert.ok(lay.rules[0].x1 < word.x, 'the logical underline is not under the moved word');
  const rules = reorderRules(lay.rules, out);
  assert.equal(rules.length, 1);
  assert.ok(Math.abs(rules[0].x1 - word.x) < 1e-9 && Math.abs(rules[0].x2 - (word.x + word.w)) < 1e-9);
});

test('a rule covering two pieces becomes one rule per piece, each moved with its piece', () => {
  const lay = layoutMText(parseMText('\\Lواحد اثنان\\l', { height: 1 }));
  const rules0 = lay.rules.length;
  const out = reorderLines(lay.glyphs, (t, level, g) => t.length * g.h * 0.6);
  const wide = [{ ...lay.rules[0], x1: Math.min(...lay.rules.map((r) => r.x1)), x2: Math.max(...lay.rules.map((r) => r.x2)) }];
  const rules = reorderRules(wide, out);
  assert.ok(rules0 >= 2);
  assert.equal(rules.length, out.length, 'one rule per piece (the two words and the space between them)');
  for (const w of out) assert.ok(rules.some((r) => Math.abs(r.x1 - w.x) < 1e-9 && Math.abs(r.x2 - (w.x + w.w)) < 1e-9), `a rule under ${w.text}`);
});

test('a line holding SHX stroke glyphs is not reordered', () => {
  const lay = layoutMText(parseMText('غرفة 12', { height: 1 }));
  const glyphs = lay.glyphs.map((g, i) => (i === 0 ? { ...g, stroke: true } : g));
  assert.equal(reorderLines(glyphs, () => 1), glyphs);
});
