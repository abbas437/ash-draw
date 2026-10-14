import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePat } from '../src/core/patfile.js';
import { setLoadedPatterns, patternLines, linesOfDef, unknownPatterns } from '../src/core/patterns.js';
import { newDocument, makeHatch, addEntity } from '../src/core/model.js';
import { buildScene } from '../src/core/render.js';
import { hatchFamilies } from '../src/core/exportSvg.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { readDxf } from '../src/core/dxfRead.js';

const SAMPLE = [
  ';;  acadiso.pat style sample',
  ';%UNITS=MM',
  '*MYCROSS, Crossed lines with dashes',
  ';%TYPE=MODEL',
  '0, 0,0, 0,2.5, 2,-1   ; trailing comment',
  '90, 0,0, 0,2.5, 2,-1',
  '',
  '*BRICKISH,Brick-like',
  '  0,  0,0,  0,6.35  ',
  '90, 0,0, 6.35,6.35, 6.35,-6.35',
  '*DOTS, dots',
  '0, 0,0, 1.5875,1.5875, 0,-1.5875',
].join('\r\n');

test('parsePat: several patterns, dashes, comments, directives, CRLF and whitespace', () => {
  const { patterns, errors } = parsePat(SAMPLE);
  assert.deepEqual(errors, []);
  assert.deepEqual(patterns.map((p) => p.name), ['MYCROSS', 'BRICKISH', 'DOTS']);
  const [c, b, d] = patterns;
  assert.equal(c.description, 'Crossed lines with dashes');
  assert.equal(c.units, 'MM'); assert.equal(c.type, 'MODEL');
  assert.deepEqual(c.lines, [
    { angle: 0, base: [0, 0], delta: [0, 2.5], dashes: [2, -1] },
    { angle: 90, base: [0, 0], delta: [0, 2.5], dashes: [2, -1] },
  ]);
  assert.deepEqual(b.lines[0], { angle: 0, base: [0, 0], delta: [0, 6.35], dashes: [] });
  assert.deepEqual(b.lines[1].dashes, [6.35, -6.35]);
  assert.deepEqual(d.lines[0].dashes, [0, -1.5875]);
});

test('parsePat: malformed lines are reported with their line numbers and skipped', () => {
  const text = ['0,0,0,0,1', '*A, a', '45, 0, 0, 0', '45, 0, x, 0, 3', '45, 0, 0, 0, 0', '45, 0, 0, 0, 3', '*, nameless', '*EMPTY', '*A, again', '0,0,0,0,1'].join('\n');
  const { patterns, errors } = parsePat(text);
  assert.deepEqual(patterns.map((p) => p.name), ['A']);
  assert.equal(patterns[0].lines.length, 1);
  assert.deepEqual(errors.map((e) => e.line), [1, 3, 4, 5, 7, 8, 9]);
  assert.match(errors[2].message, /field 3/);
});

test('parsePat: caps on patterns, lines per pattern, dashes and size', () => {
  const many = Array.from({ length: 20 }, (_, i) => `*P${i}\n0,0,0,0,1`).join('\n');
  const r1 = parsePat(many, { maxPatterns: 5 });
  assert.equal(r1.patterns.length, 5); assert.equal(r1.errors.length, 1);
  const long = `*L\n${'0,0,0,0,1\n'.repeat(50)}`;
  const r2 = parsePat(long, { maxLinesPerPattern: 10 });
  assert.equal(r2.patterns[0].lines.length, 10); assert.equal(r2.errors.length, 1);
  const r3 = parsePat(`*D\n0,0,0,0,1,${Array(70).fill('1').join(',')}`);
  assert.equal(r3.patterns.length, 0); assert.match(r3.errors[0].message, /dash/);
  const r4 = parsePat('*S\n0,0,0,0,1\n*T\n0,0,0,0,1', { maxChars: 12 });
  assert.equal(r4.patterns.length, 1); assert.equal(r4.errors[0].line, 0);
});

const square = () => [{ pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], closed: true }];

/** dash pieces of the family segments inside the square [0,10]^2 (axis-parallel families only) */
function piecesInSquare(fam) {
  const out = [];
  for (const [x0, y0, x1, y1] of fam.segs) {
    const len = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    let t = 0, k = 0;
    while (t < len) {
      const d = fam.dashes[k % fam.dashes.length], t1 = Math.min(t + d, len);
      if (k % 2 === 0) {
        const a = [x0 + ux * t, y0 + uy * t], b = [x0 + ux * t1, y0 + uy * t1];
        const lo = (v) => Math.max(0, Math.min(10, v));
        if (a[0] >= -1e-9 && a[0] <= 10 + 1e-9 && a[1] >= -1e-9 && a[1] <= 10 + 1e-9 || b[0] >= -1e-9 && b[0] <= 10 + 1e-9 && b[1] >= -1e-9 && b[1] <= 10 + 1e-9) {
          const p = [lo(a[0]), lo(a[1]), lo(b[0]), lo(b[1])].map((v) => +v.toFixed(6));
          if (p[0] !== p[2] || p[1] !== p[3]) if (Math.abs(ux) > 0.5 ? p[1] === +(y0).toFixed(6) : p[0] === +(x0).toFixed(6)) out.push(p);
        }
      }
      t = t1; k++;
    }
  }
  return out;
}

test('render: a HATCH with an embedded 2-family dashed pattern gives the expected segments in a square', () => {
  const def = parsePat(SAMPLE).patterns[0].lines;
  const doc = newDocument();
  const h = makeHatch(square(), { solid: false, pattern: 'MYCROSS' });
  h.patLines = linesOfDef(def, 1, 0);
  addEntity(doc, h);
  const it = buildScene(doc).items.find((i) => i.kind === 'hatch');
  assert.equal(it.lines.length, 2);
  const fams = hatchFamilies(it);
  assert.deepEqual(fams.map((f) => f.dashes), [[2, 1], [2, 1]]);
  // horizontal family: dashes [0,2] [3,5] [6,8] [9,10] on y = 0, 2.5, 5, 7.5, 10
  const ys = [0, 2.5, 5, 7.5, 10];
  const hz = piecesInSquare(fams[0]).filter((p) => p[1] === p[3] && ys.includes(p[1]));
  for (const y of ys) assert.deepEqual(hz.filter((p) => p[1] === y).map((p) => [p[0], p[2]]).sort((a, b) => a[0] - b[0]), [[0, 2], [3, 5], [6, 8], [9, 10]], `y=${y}`);
  const vt = piecesInSquare(fams[1]).filter((p) => p[0] === p[2]);
  assert.deepEqual([...new Set(vt.map((p) => p[0]))].sort((a, b) => a - b), [0, 2.5, 5, 7.5, 10]);
  for (const x of [0, 5]) assert.deepEqual(vt.filter((p) => p[0] === x).map((p) => [p[1], p[3]]).sort((a, b) => a[0] - b[0]), [[0, 2], [3, 5], [6, 8], [9, 10]], `x=${x}`);
});

test('a loaded pattern is found by name, written with its definition lines to DXF and read back', () => {
  const { patterns } = parsePat(SAMPLE);
  setLoadedPatterns(patterns);
  try {
    const doc = newDocument();
    addEntity(doc, makeHatch(square(), { solid: false, pattern: 'BRICKISH', scale: 2 }));
    addEntity(doc, makeHatch(square(), { solid: false, pattern: 'NOSUCH' }));
    assert.deepEqual(unknownPatterns(doc), ['NOSUCH']);
    const back = readDxf(Buffer.from(writeDxf(doc)));
    const h = back.entities.find((e) => e.type === 'HATCH' && e.pattern === 'BRICKISH');
    assert.equal(h.solid, false);
    const want = patternLines('BRICKISH', 2, 0);
    assert.equal(h.patLines.length, 2);
    h.patLines.forEach((L, i) => {
      assert.ok(Math.abs(L.angle - want[i].angle) < 1e-9);
      assert.ok(Math.abs(L.offset.x - want[i].offset.x) < 1e-9 && Math.abs(L.offset.y - want[i].offset.y) < 1e-9);
      assert.deepEqual(L.dashes, want[i].dashes);
    });
    assert.deepEqual(h.patLines[1].dashes, [12.7, -12.7]);
    // with the patterns unloaded the read-back hatch still draws its own definition; an unknown one falls back to ANSI31
    setLoadedPatterns([]);
    const sc = buildScene(back).items.filter((i) => i.kind === 'hatch');
    assert.equal(sc[0].lines.length, 2);
  } finally { setLoadedPatterns([]); }
  const doc2 = newDocument();
  addEntity(doc2, makeHatch(square(), { solid: false, pattern: 'NOSUCH' }));
  const it = buildScene(doc2).items.find((i) => i.kind === 'hatch');
  assert.equal(it.lines.length, 1); assert.equal(it.lines[0].angle, 45);
});
