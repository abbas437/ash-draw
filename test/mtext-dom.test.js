// MTEXT editor: DOM <-> model and selection points <-> cell positions, on a minimal DOM-like tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readEditor, pointAt } from '../renderer/mtext-dom.js';
import { parseMText, serializeMText, DEFAULT_PROPS, formatMText } from '../src/core/mtext.js';

// tiny DOM: elements carry tagName / attributes / childNodes, text nodes carry data; parentNode and nextSibling are wired up
const txt = (data) => ({ nodeType: 3, data });
function el(tag, attrs = {}, ...kids) {
  const n = { nodeType: 1, tagName: tag.toUpperCase(), attrs, childNodes: [], getAttribute: (k) => (k in attrs ? attrs[k] : null) };
  for (const k of kids) { const c = typeof k === 'string' ? txt(k) : k; c.parentNode = n; n.childNodes.push(c); }
  n.childNodes.forEach((c, i) => { c.nextSibling = n.childNodes[i + 1] ?? null; });
  return n;
}
const H = { height: 2 };
const base = { ...DEFAULT_PROPS, h: 2 };
const P = (patch = {}) => ({ 'data-p': JSON.stringify({ ...base, ...patch }) });

test('the editor tree reads back to the model, a real \\~ span stays a non-breaking space, typed U+00A0 is a space', () => {
  const root = el('div', {},
    el('div', {}, el('span', P(), 'A', el('span', { 'data-nbsp': '' }, ' '), 'B one two'), el('span', { 'data-raw': '\\Xzz;' }, '\\Xzz;')),
    el('div', {}, el('span', P({ bold: true }), 'x')));
  const { paras } = readEditor(root, base);
  assert.equal(serializeMText({ paras }, H), 'A\\~B one two\\Xzz;\\P{\\fArial|b1|i0;x}');
});

test('selection points map to the cell positions of the mtext.js helpers and back', () => {
  const t1 = txt('one two'), nb = el('span', { 'data-nbsp': '' }, ' '), t2 = txt('x');
  const run = el('span', P(), t1, nb, t2), stack = el('span', { 'data-stack': JSON.stringify({ stack: { a: '1', b: '2', type: '/' }, props: base }) }, '1/2');
  const p2 = el('div', {}, el('span', P(), 'end'));
  const root = el('div', {}, el('div', {}, run, stack), p2);
  // cells: o n e _ t w o (0..6), nbsp 7, x 8, stack 9, break 10, e n d 11..13
  const pts = [{ node: t1, offset: 4 }, { node: t1, offset: 7 }, { node: t2, offset: 1 }, { node: p2.childNodes[0].childNodes[0], offset: 3 }, { node: stack.childNodes[0], offset: 1 }, { node: run, offset: 2 }];
  const { paras, at } = readEditor(root, base, pts);
  assert.deepEqual(at, [4, 7, 9, 14, 9, 8]);
  const r = formatMText({ paras }, at[0], at[1], { bold: true });
  assert.equal(serializeMText(r.model, H), 'one {\\fArial|b1|i0;two}\\~x\\S1/2;\\Pend');
  assert.deepEqual(pointAt(root, 4), { node: t1, offset: 4 });
  assert.deepEqual(pointAt(root, 7), { node: t1, offset: 7 }, 'end of a word stays in its text node');
  assert.deepEqual(pointAt(root, 8), { node: t2, offset: 0 });
  assert.deepEqual(pointAt(root, 9), { node: t2, offset: 1 });
  assert.deepEqual(pointAt(root, 10), { node: root.childNodes[0], offset: 2 }, 'after the stack, at the paragraph end');
  assert.deepEqual(pointAt(root, 14), { node: p2.childNodes[0].childNodes[0], offset: 3 });
  for (let pos = 0; pos <= 14; pos++) {
    if (pos === 10) continue;   // the paragraph end and the start of the next paragraph are the same caret place
    const q = pointAt(root, pos);
    assert.equal(readEditor(root, base, [q]).at[0], pos, `round trip at ${pos}`);
  }
});

test('an empty paragraph (a lone <br>) counts only its break', () => {
  const root = el('div', {}, el('div', {}, el('span', P(), 'a')), el('div', {}, el('br')), el('div', {}, el('span', P(), 'b')));
  const { paras } = readEditor(root, base);
  assert.equal(serializeMText({ paras }, H), 'a\\P\\Pb');
  assert.deepEqual(pointAt(root, 2), { node: root.childNodes[1], offset: 0 });
  assert.deepEqual(pointAt(root, 3).node.data, 'b');
  assert.deepEqual(parseMText('a\\P\\Pb', H).paras.length, paras.length);
});
