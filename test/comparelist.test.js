import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addEntity, makeLine, makeCircle, makeText } from '../src/core/model.js';
import { compareDocs } from '../src/core/compare.js';
import { compareChangeRows, compareChangeTsv, compareChangeCsv, compareChangeFileName, CHANGE_LIST_HEADER } from '../src/core/comparelist.js';

const docOf = (ents) => { const d = newDocument(); d.units = 4; for (const e of ents) addEntity(d, structuredClone(e)); return d; };
// frame circles far apart: the drawing is big enough for moves of 100 to count as moves, and they match as unchanged
const frame = () => [makeCircle({ x: 0, y: 0 }, 5), makeCircle({ x: 3000, y: 0 }, 5), makeCircle({ x: 0, y: 3000 }, 5), makeCircle({ x: 3000, y: 3000 }, 5)];

test('change list: removed line, moved circle, changed text -> rows with change, layer, type, centre and details', () => {
  const a = docOf([...frame(), makeLine({ x: 100, y: 100 }, { x: 140, y: 100 }, { layer: 'WALLS' }), makeCircle({ x: 500, y: 500 }, 20, { layer: 'EQUIP' }), makeText({ x: 800, y: 800 }, 10, 'AHU-1', { layer: 'TXT' })]);
  const b = docOf([...frame(), makeCircle({ x: 510, y: 500 }, 20, { layer: 'EQUIP' }), makeText({ x: 800, y: 800 }, 10, 'AHU-2', { layer: 'TXT' })]);
  const r = compareDocs(a, b, { align: 'none', tol: 1 });
  assert.equal(r.removed.length, 1); assert.equal(r.added.length, 0); assert.equal(r.changed.length, 2);
  const rows = compareChangeRows(a, b, r);
  assert.equal(rows.length, 3);
  const by = (t) => rows.find((x) => x[3] === t);
  assert.deepEqual(by('LINE'), [by('LINE')[0], 'removed', 'WALLS', 'LINE', 120, 100, '']);
  assert.deepEqual(by('CIRCLE').slice(1), ['changed', 'EQUIP', 'CIRCLE', 510, 500, 'moved 10, 0']);
  const t = by('TEXT');
  assert.equal(t[1], 'changed'); assert.equal(t[2], 'TXT'); assert.match(t[6], /text "AHU-1" → "AHU-2"/);
  assert.ok(rows.every((x) => Number.isInteger(x[0]) && x[0] >= 1 && x[0] <= r.clusters.length));
  const tsv = compareChangeTsv(rows).split('\n');
  assert.equal(tsv[0], CHANGE_LIST_HEADER.join('\t'));
  assert.equal(tsv.length, 5); // header, 3 rows, trailing newline
  assert.equal(tsv[1].split('\t').length, 7);
  const csv = compareChangeCsv(rows);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(csv.slice(1).split('\r\n')[0], CHANGE_LIST_HEADER.join(','));
});

test('change list: negative coordinates stay numbers in the CSV, formula-looking text is guarded; added object listed', () => {
  const a = docOf(frame());
  const b = docOf([...frame(), makeText({ x: -50.5, y: -20 }, 10, '=1+1', { layer: 'TXT' })]);
  const rows = compareChangeRows(a, b, compareDocs(a, b, { align: 'none', tol: 1 }));
  assert.equal(rows.length, 1); assert.equal(rows[0][1], 'added');
  const line = compareChangeCsv(rows).split('\r\n')[1];
  assert.match(line, /^1,added,TXT,TEXT,-\d+(\.\d+)?,-\d+(\.\d+)?,/); // numbers, no leading apostrophe
});

test('change list: file name <A>-vs-<B>-changes.csv', () => {
  assert.equal(compareChangeFileName('HVAC-Rev00.dxf', 'HVAC-Rev01.dwg'), 'HVAC-Rev00-vs-HVAC-Rev01-changes.csv');
  assert.equal(compareChangeFileName('a:b.dxf', 'c.dxf'), 'a_b-vs-c-changes.csv');
});

test('shape key bins: a twin whose rounded length sits at a bin boundary is matched as moved, not removed + added', () => {
  // tol 0.25 -> bin 1: lengths 10.4999 and 10.5001 round to 10 and 11 although they differ by 0.0002 (within tol)
  const a = docOf([...frame(), makeLine({ x: 100, y: 100 }, { x: 110.4999, y: 100 })]);
  const b = docOf([...frame(), makeLine({ x: 300, y: 100 }, { x: 310.5001, y: 100 })]);
  const r = compareDocs(a, b, { align: 'none', tol: 0.25, moveRadius: 500 });
  assert.equal(r.removed.length, 0); assert.equal(r.added.length, 0);
  assert.equal(r.changed.length, 1); assert.equal(r.changed[0].a.type, 'LINE');
  assert.equal(r.same.length, 4);
});
