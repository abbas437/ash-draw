import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDxf, tokenizeDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { newDocument, makeLine, makeText, addEntity } from '../src/core/model.js';
import { transformEntity } from '../src/core/geom.js';
import { buildScene } from '../src/core/render.js';

const lines = (txt) => txt.split('\r\n');
const EXP = /^[-+]?[\d.]+[eE][-+]?\d+$/;

// #16: coordinates are written with the shortest digits that read back exactly, never in exponent form
test('numbers: shortest round-trip digits, plain decimal, re-read exactly', () => {
  const VALUES = [1.1234567890123456e16, 0.1 + 0.2, 1e-10, -0, 123.456, -2.5e-7, 1e21, -9.87654321e22, 5e-324];
  const doc = newDocument();
  for (const v of VALUES) addEntity(doc, makeLine({ x: v, y: -v }, { x: 1, y: v }));
  const txt = writeDxf(doc);
  const L = lines(txt);
  assert.equal(L.filter((s) => EXP.test(s.trim())).length, 0, 'no number is written with an exponent');
  assert.ok(L.includes('11234567890123456'), '1.1234567890123456e16 keeps all 17 significant digits');
  assert.ok(L.includes('0.30000000000000004'));
  assert.ok(L.includes('0.0000000001'));
  const back = parseDxf(txt).entities.filter((e) => e.type === 'LINE');
  assert.equal(back.length, VALUES.length);
  VALUES.forEach((v, i) => {
    // === : -0 is written 0, the same coordinate
    assert.ok(back[i].p1.x === v, `x of ${v}: ${back[i].p1.x}`);
    assert.ok(back[i].p1.y === -v, `y of ${-v}: ${back[i].p1.y}`);
    assert.ok(back[i].p2.y === v, `${v}: ${back[i].p2.y}`);
  });
  // the byte-level number reader gives the same values as parseFloat on the long plain decimals
  const tk = tokenizeDxf(new TextEncoder().encode(txt));
  for (let i = 0; i < tk.codes.length; i++) {
    const c = tk.codes[i];
    if (c >= 10 && c <= 39) assert.ok(Object.is(tk.num(i), parseFloat(tk.val(i))), tk.val(i));
  }
});

test('numbers: empty-drawing header extents (1e20) stay valid', () => {
  const txt = writeDxf(newDocument());
  const L = lines(txt);
  const at = L.indexOf('$EXTMIN');
  assert.ok(at > 0);
  assert.deepEqual(L.slice(at + 1, at + 7), ['10', '100000000000000000000', '20', '100000000000000000000', '30', '100000000000000000000']);
  const mx = L.indexOf('$EXTMAX');
  assert.equal(L[mx + 2], '-100000000000000000000');
  assert.equal(parseFloat(L[mx + 2]), -1e20);
  assert.equal(L.filter((s) => EXP.test(s.trim())).length, 0);
  parseDxf(txt); // reads back
});

// #16: text is escaped per code point; a character outside the BMP cannot be a 4-digit \U+ escape
test('text: non-BMP characters saved as ? with one note; BMP Arabic stays \\U+ escaped', () => {
  const doc = newDocument();
  addEntity(doc, makeText({ x: 0, y: 0 }, 2.5, 'A\u{1F600}B'));
  addEntity(doc, makeText({ x: 0, y: 10 }, 2.5, 'مرحبا'));
  const txt = writeDxf(doc);
  const L = lines(txt);
  assert.ok(L.includes('A?B'), 'the emoji is one ?');
  assert.ok(!/\\U\+D[89AB]/i.test(txt), 'no lone surrogate escapes');
  assert.ok(L.includes('\\U+0645\\U+0631\\U+062D\\U+0628\\U+0627'));
  const notes = doc.lastWriteReport.notes.filter((n) => /Basic Multilingual Plane/.test(n));
  assert.deepEqual(notes, ['1 character outside the Basic Multilingual Plane was saved as ?']);
  const back = parseDxf(txt).entities.filter((e) => e.type === 'TEXT').map((e) => e.text);
  assert.deepEqual(back, ['A?B', 'مرحبا']);
  writeDxf(doc);
  assert.equal(doc.lastWriteReport.notes.filter((n) => /Basic Multilingual Plane/.test(n)).length, 1, 'counted per save');
});

// #35: a pattern the program does not know is kept from the hatch's own line table, through a move / rotate
const BRSTD = [{ angle: 0, base: [0, 0], offset: [0, 2.667], dashes: [] }, { angle: 90, base: [0, 0], offset: [2.667, 4], dashes: [2.667, -2.667] }];
function brstdDxf() {
  const t = ['0', 'SECTION', '2', 'ENTITIES', '0', 'HATCH', '5', 'A1', '8', '0', '100', 'AcDbEntity', '100', 'AcDbHatch',
    '10', '0', '20', '0', '30', '0', '210', '0', '220', '0', '230', '1', '2', 'AR-BRSTD', '70', '0', '71', '0', '91', '1',
    '92', '7', '72', '0', '73', '1', '93', '4', '10', '0', '20', '0', '10', '100', '20', '0', '10', '100', '20', '50', '10', '0', '20', '50',
    '97', '0', '75', '0', '76', '1', '52', '0', '41', '1', '77', '0', '78', String(BRSTD.length),
    ...BRSTD.flatMap((l) => ['53', String(l.angle), '43', String(l.base[0]), '44', String(l.base[1]), '45', String(l.offset[0]), '46', String(l.offset[1]),
      '79', String(l.dashes.length), ...l.dashes.flatMap((d) => ['49', String(d)])]),
    '98', '0', '0', 'ENDSEC', '0', 'EOF'];
  return t.join('\n') + '\n';
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
function sameLines(got, want, msg) {
  assert.equal(got.length, want.length, msg);
  got.forEach((g, i) => {
    const w = want[i];
    assert.ok(near(((g.angle - w.angle) % 360 + 360) % 360 % 360, 0) || near(Math.abs(g.angle - w.angle), 360), `${msg} angle ${g.angle} vs ${w.angle}`);
    for (const k of ['base', 'offset']) assert.ok(near(g[k].x, w[k].x) && near(g[k].y, w[k].y), `${msg} ${k} ${JSON.stringify(g[k])} vs ${JSON.stringify(w[k])}`);
    assert.equal(g.dashes.length, w.dashes.length, msg);
    g.dashes.forEach((d, j) => assert.ok(near(d, w.dashes[j]), `${msg} dash`));
  });
}

test('hatch AR-BRSTD with stored lines: moved and rotated, saved with its own lines (not SOLID), drawn from them', () => {
  const doc = parseDxf(brstdDxf());
  const h = doc.entities.find((e) => e.type === 'HATCH');
  assert.equal(h.pattern, 'AR-BRSTD');
  assert.equal(h.patLines.length, 2);
  // move by (10, 5), then rotate 90 degrees about the origin
  const moved = transformEntity(h, [1, 0, 0, 1, 10, 5]);
  const turned = transformEntity(moved, [0, 1, -1, 0, 0, 0]);
  doc.entities[doc.entities.indexOf(h)] = turned;
  const want = BRSTD.map((l) => ({ angle: l.angle + 90, base: { x: -(l.base[1] + 5), y: l.base[0] + 10 }, offset: { x: -l.offset[1], y: l.offset[0] }, dashes: l.dashes }));
  sameLines(turned.patLines, want, 'transformed');
  const txt = writeDxf(doc);
  assert.ok(!doc.lastWriteReport.notes.some((n) => /unknown/.test(n)), doc.lastWriteReport.notes.join('; '));
  const back = parseDxf(txt).entities.find((e) => e.type === 'HATCH');
  assert.equal(back.pattern, 'AR-BRSTD');
  assert.equal(back.solid, false);
  sameLines(back.patLines, want, 're-read');
  const item = buildScene({ ...doc, entities: [back] }).items.find((it) => it.kind === 'hatch');
  assert.ok(item && !item.solid);
  sameLines(item.lines, want, 'drawn');
});
