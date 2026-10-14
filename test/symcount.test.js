import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addEntity, addBlock, makeLine, makeInsert } from '../src/core/model.js';
import { countSymbols, symcountCsv } from '../src/core/symcount.js';

/** synthetic drawing: VAV x2 (one on layer M-HVAC), FCU x1, a *D dimension block, an *X hatch block and an xref */
function sample() {
  const d = newDocument();
  addBlock(d, 'VAV', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 })]);
  addBlock(d, 'FCU', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 1 })]);
  addBlock(d, '*D1', { x: 0, y: 0 }, []);
  addBlock(d, '*X2', { x: 0, y: 0 }, []);
  addBlock(d, 'ARCH', { x: 0, y: 0 }, []).xref = { path: 'arch.dxf', status: 'loaded' };
  addBlock(d, 'ARCH|DOOR', { x: 0, y: 0 }, []).xrefDep = 'ARCH';
  const a = addEntity(d, makeInsert('VAV', { x: 0, y: 0 }));
  addEntity(d, makeInsert('VAV', { x: 5, y: 0 }, { layer: 'M-HVAC' }));
  addEntity(d, makeInsert('FCU', { x: 9, y: 0 }));
  for (const n of ['*D1', '*X2', 'ARCH', 'ARCH|DOOR']) addEntity(d, makeInsert(n, { x: 0, y: 0 }));
  addEntity(d, makeLine({ x: 0, y: 0 }, { x: 1, y: 1 }));
  return { d, a };
}

test('countSymbols: model space, sorted by name, layers listed, anonymous and xref blocks skipped', () => {
  const { d } = sample();
  const r = countSymbols(d);
  assert.deepEqual(r.rows, [{ name: 'FCU', count: 1, layers: ['0'] }, { name: 'VAV', count: 2, layers: ['0', 'M-HVAC'] }]);
  assert.equal(r.total, 3);
});

test('countSymbols: only the selection when entities are given', () => {
  const { d, a } = sample();
  assert.deepEqual(countSymbols(d, { entities: [a] }).rows, [{ name: 'VAV', count: 1, layers: ['0'] }]);
});

test('countSymbols: a layout space and MINSERT rows x cols', () => {
  const { d } = sample();
  d.layouts = [{ name: 'Layout1', entities: [makeInsert('FCU', { x: 0, y: 0 }, { rows: 2, cols: 3 })] }];
  assert.deepEqual(countSymbols(d, { space: 'Layout1' }).rows, [{ name: 'FCU', count: 6, layers: ['0'] }]);
  assert.equal(countSymbols(d, { space: 'Model' }).total, 3);
});

test('countSymbols: nested inserts multiplied by the parent count; off by default', () => {
  const d = newDocument();
  addBlock(d, 'GRILLE', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 })]);
  addBlock(d, 'ROOM', { x: 0, y: 0 }, [makeInsert('GRILLE', { x: 0, y: 0 }), makeInsert('GRILLE', { x: 2, y: 0 }, { layer: 'G' }), makeInsert('*D9', { x: 0, y: 0 })]);
  addBlock(d, 'FLOOR', { x: 0, y: 0 }, [makeInsert('ROOM', { x: 0, y: 0 }, { rows: 1, cols: 2 })]);
  addEntity(d, makeInsert('FLOOR', { x: 0, y: 0 }));
  addEntity(d, makeInsert('FLOOR', { x: 0, y: 9 }));
  assert.deepEqual(countSymbols(d).rows.map((r) => [r.name, r.count]), [['FLOOR', 2]]);
  const r = countSymbols(d, { nested: true });
  assert.deepEqual(r.rows.map((x) => [x.name, x.count]), [['FLOOR', 2], ['GRILLE', 8], ['ROOM', 4]]);
  assert.deepEqual(r.rows.find((x) => x.name === 'GRILLE').layers, ['0', 'G']);
});

test('countSymbols: a block that contains itself (directly or via another) does not loop', () => {
  const d = newDocument();
  addBlock(d, 'A', { x: 0, y: 0 }, [makeInsert('B', { x: 0, y: 0 }), makeInsert('A', { x: 1, y: 0 })]);
  addBlock(d, 'B', { x: 0, y: 0 }, [makeInsert('A', { x: 0, y: 0 })]);
  addEntity(d, makeInsert('A', { x: 0, y: 0 }));
  const r = countSymbols(d, { nested: true });
  assert.deepEqual(r.rows.map((x) => [x.name, x.count]), [['A', 3], ['B', 1]]);
});

test('countSymbols: block names match case-insensitively and report the definition name', () => {
  const d = newDocument();
  addBlock(d, 'Smoke Detector', { x: 0, y: 0 }, []);
  addEntity(d, makeInsert('SMOKE DETECTOR', { x: 0, y: 0 }));
  addEntity(d, makeInsert('Smoke Detector', { x: 1, y: 0 }));
  assert.deepEqual(countSymbols(d).rows.map((x) => [x.name, x.count]), [['Smoke Detector', 2]]);
});

test('symcountCsv: header, CRLF, RFC 4180 quoting', () => {
  const csv = symcountCsv([{ name: 'Grille, "600"', count: 3, layers: ['A', 'B'] }, { name: 'VAV', count: 1, layers: ['0'] }]);
  assert.equal(csv, 'Symbol,Count,Layers\r\n"Grille, ""600""",3,A; B\r\nVAV,1,0\r\n');
});

test('countSymbols: a block named $ABC is counted, anonymous * blocks are not', () => {
  const doc = newDocument();
  addBlock(doc, '$ABC', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 })]);
  addEntity(doc, makeInsert('$ABC', { x: 0, y: 0 }));
  addEntity(doc, makeInsert('*U1', { x: 0, y: 0 }));
  assert.deepEqual(countSymbols(doc).rows.map((r) => [r.name, r.count]), [['$ABC', 1]]);
});
