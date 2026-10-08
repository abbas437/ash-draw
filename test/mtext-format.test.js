// MTEXT editor toolbar: the pure helpers on the parsed runs, and the space / non-breaking space round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMText, serializeMText, formatMText, toggleMText, insertMText, stackMText, unstackMText } from '../src/core/mtext.js';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { newDocument, addEntity, makeMText } from '../src/core/model.js';

const H = { height: 2 };
const ser = (r) => serializeMText(r.model, H);
const m = (raw) => parseMText(raw, H);

test('an ordinary space stays a space; only U+00A0 is written as \\~', () => {
  assert.equal(serializeMText(m('A B'), H), 'A B');
  assert.equal(serializeMText({ paras: [{ align: null, runs: [{ text: 'A\u00A0B', props: m('x').paras[0].runs[0].props }] }] }, H), 'A\\~B');
  for (const raw of ['A B', 'A\\~B', 'A \\~ B']) assert.equal(serializeMText(m(raw), H), raw, raw);
  for (const t of ['A B', 'A\u00A0B']) {
    const model = insertMText(m(''), 0, 0, t).model;
    assert.deepEqual(parseMText(serializeMText(model, H), H), model, JSON.stringify(t));
  }
  const d = newDocument(); addEntity(d, makeMText({ x: 0, y: 0 }, 2, 'A B'));
  const dxf = writeDxf(d);
  assert.match(dxf, /\n\s*1\r?\nA B\r?\n/, 'DXF group 1 holds "A B"');
  assert.doesNotMatch(dxf, /A\\~B/);
  assert.equal(readDxf(Buffer.from(dxf)).entities[0].text, 'A B');
});

test('toolbar actions on a selection write the inline codes', () => {
  const t = m('one two three');   // "two" = cells 4..7
  assert.equal(ser(toggleMText(t, 4, 7, 'bold')), 'one {\\fArial|b1|i0;two} three');
  assert.equal(ser(toggleMText(toggleMText(t, 4, 7, 'bold').model, 4, 7, 'bold')), 'one two three', 'toggle twice = off');
  assert.equal(ser(toggleMText(t, 4, 7, 'italic')), 'one {\\fArial|b0|i1;two} three');
  assert.equal(ser(toggleMText(t, 4, 7, 'u')), 'one {\\Ltwo} three');
  assert.equal(ser(toggleMText(t, 4, 7, 'o')), 'one {\\Otwo} three');
  assert.equal(ser(formatMText(t, 4, 7, { font: 'Times New Roman' })), 'one {\\fTimes New Roman|b0|i0;two} three');
  assert.equal(ser(formatMText(t, 4, 7, { h: 3.5 })), 'one {\\H3.5;two} three');
  assert.equal(ser(formatMText(t, 4, 7, { color: { aci: 1 } })), 'one {\\C1;two} three');
  assert.equal(ser(formatMText(t, 4, 7, { oblique: 15 })), 'one {\\Q15;two} three');
  assert.equal(ser(formatMText(t, 4, 7, { wf: 0.8 })), 'one {\\W0.8;two} three');
  const r = formatMText(toggleMText(t, 4, 7, 'bold').model, 4, 7, { color: { aci: 1 } });
  assert.equal(ser(r), 'one {\\fArial|b1|i0;\\C1;two} three', 'patches combine');
  assert.deepEqual([r.a, r.b], [4, 7]);
});

test('nothing selected: the action applies to the whole text, across paragraphs', () => {
  const r = formatMText(m('ab\\Pcd'), 2, 2, { color: { aci: 3 } });
  assert.deepEqual([r.a, r.b], [0, 5]);
  assert.equal(ser(r), '{\\C3;ab}\\P{\\C3;cd}');
});

test('symbols insert at the caret or replace the selection, in the surrounding properties', () => {
  const t = m('{\\C1;red} x');
  assert.equal(ser(insertMText(t, 3, 3, '°')), '{\\C1;red°} x');
  for (const s of ['°', '±', 'Ø', '≈', '∠', '℄', 'Δ', '≠', 'Ω', '²', '³']) {
    const r = insertMText(m('a b'), 1, 2, s);
    assert.equal(ser(r), `a${s}b`, s);
    assert.deepEqual(parseMText(ser(r), H), r.model, `${s} round trip`);
    assert.deepEqual([r.a, r.b], [2, 2]);
  }
  assert.equal(ser(insertMText(m('a b'), 1, 2, '\u00A0')), 'a\\~b', 'non-breaking space symbol');
});

test('stack and unstack round trip for / # ^', () => {
  for (const [type, code] of [['/', '\\S1/2;'], ['#', '\\S1#2;'], ['^', '\\S1^ 2;']]) {
    const t = m(`x 1${type}2 y`);
    const st = stackMText(t, 2, 5);
    assert.equal(ser(st), `x ${code} y`, type);
    assert.deepEqual(st.model.paras[0].runs[1].stack, { a: '1', b: '2', type });
    assert.deepEqual(parseMText(ser(st), H), st.model, `${type} parse(serialize)`);
    const un = unstackMText(st.model, st.a, st.b);
    assert.equal(ser(un), `x 1${type}2 y`, `${type} unstack`);
    assert.deepEqual([un.a, un.b], [2, 5]);
  }
  assert.equal(stackMText(m('no slash'), 0, 8), null, 'not stackable');
  assert.equal(ser(unstackMText(m('\\S1/2; and \\S3/4;'), 0, 0)), '1/2 and 3/4', 'nothing selected: all stacks');
});
