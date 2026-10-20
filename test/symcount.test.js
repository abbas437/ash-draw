import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addEntity, addBlock, makeLine, makeInsert } from '../src/core/model.js';
import { countSymbols, symcountCsv } from '../src/core/symcount.js';
import { parseDxf } from '../src/core/dxfRead.js';

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
  assert.deepEqual(r.rows, [{ name: 'FCU', count: 1, layers: ['0'], block: 'FCU' }, { name: 'VAV', count: 2, layers: ['0', 'M-HVAC'], block: 'VAV' }]);
  assert.equal(r.total, 3);
});

test('countSymbols: only the selection when entities are given', () => {
  const { d, a } = sample();
  assert.deepEqual(countSymbols(d, { entities: [a] }).rows, [{ name: 'VAV', count: 1, layers: ['0'], block: 'VAV' }]);
});

test('countSymbols: a layout space and MINSERT rows x cols', () => {
  const { d } = sample();
  d.layouts = [{ name: 'Layout1', entities: [makeInsert('FCU', { x: 0, y: 0 }, { rows: 2, cols: 3 })] }];
  assert.deepEqual(countSymbols(d, { space: 'Layout1' }).rows, [{ name: 'FCU', count: 6, layers: ['0'], block: 'FCU' }]);
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
  assert.equal(csv, '\uFEFFSymbol,Count,Layers\r\n"Grille, ""600""",3,A; B\r\nVAV,1,0\r\n');
});

test('countSymbols: a block named $ABC is counted, anonymous * blocks are not', () => {
  const doc = newDocument();
  addBlock(doc, '$ABC', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 })]);
  addEntity(doc, makeInsert('$ABC', { x: 0, y: 0 }));
  addEntity(doc, makeInsert('*U1', { x: 0, y: 0 }));
  assert.deepEqual(countSymbols(doc).rows.map((r) => [r.name, r.count]), [['$ABC', 1]]);
});

/** synthetic DXF: dynamic block VAV, anonymous *U1 / *U2 tagged to it (BLOCK_RECORD xdata AcDbBlockRepBTag, 1005 =
 *  VAV's record handle, written with leading zeros and in lower case to check the handle normalisation), *U3 untagged;
 *  model space: *U1 x2, *U2 x1, VAV x1, *U3 x1 */
function dynDxf() {
  const t = (...pairs) => pairs.map(String).join('\n');
  const rec = (h, name, tag) => t(0, 'BLOCK_RECORD', 5, h, 330, 1, 100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord', 2, name,
    ...(tag ? [1001, 'AcDbBlockRepBTag', 1070, 1, 1005, tag] : []));
  const blk = (name, ents = []) => t(0, 'BLOCK', 8, 0, 2, name, 70, /^\*/.test(name) ? 1 : 0, 10, 0, 20, 0, 30, 0, 3, name, 1, '', ...ents, 0, 'ENDBLK', 8, 0);
  const line = [0, 'LINE', 8, 0, 10, 0, 20, 0, 30, 0, 11, 1, 21, 1, 31, 0];
  const ins = (name, x) => t(0, 'INSERT', 8, 'M-HVAC', 2, name, 10, x, 20, 0, 30, 0);
  return t(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1032', 0, 'ENDSEC',
    0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'BLOCK_RECORD', 70, 5,
    rec('1F', '*Model_Space'), rec('A0', 'VAV'), rec('B1', '*U1', '00a0'), rec('B2', '*U2', 'A0'), rec('B3', '*U3', 'B1') /* tagged to another anonymous block: not a dynamic block name */,
    0, 'ENDTAB', 0, 'ENDSEC',
    0, 'SECTION', 2, 'BLOCKS', blk('*Model_Space'), blk('VAV', line), blk('*U1', line), blk('*U2', line), blk('*U3', line), 0, 'ENDSEC',
    0, 'SECTION', 2, 'ENTITIES', ins('*U1', 0), ins('*U1', 5), ins('*U2', 10), ins('VAV', 15), ins('*U3', 20), 0, 'ENDSEC', 0, 'EOF', '');
}

test('dxfRead: an anonymous *U block tagged AcDbBlockRepBTag gets the dynamic block name as effectiveName', () => {
  const d = parseDxf(dynDxf());
  assert.equal(d.blocks.get('*U1').effectiveName, 'VAV');
  assert.equal(d.blocks.get('*U2').effectiveName, 'VAV');
  assert.equal(d.blocks.get('*U3').effectiveName, undefined);
  assert.equal(d.blocks.get('VAV').effectiveName, undefined);
});

test('countSymbols: dynamic block instances (*U with an effective name) count under the dynamic block', () => {
  const d = parseDxf(dynDxf());
  const r = countSymbols(d);
  assert.deepEqual(r.rows, [{ name: 'VAV', count: 4, layers: ['M-HVAC'], block: 'VAV' }]);
  assert.equal(r.total, 4);
});

test('countSymbols: without the dynamic block definition the row is pictured by the first *U instance', () => {
  const d = newDocument();
  addBlock(d, '*U7', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 })]).effectiveName = 'Damper';
  addBlock(d, '*U8', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 2, y: 0 })]).effectiveName = 'DAMPER';
  addEntity(d, makeInsert('*U7', { x: 0, y: 0 }));
  addEntity(d, makeInsert('*U8', { x: 0, y: 0 }));
  assert.deepEqual(countSymbols(d).rows, [{ name: 'Damper', count: 2, layers: ['0'], block: '*U7' }]);
});

test('countSymbols nested: the inserts inside a *U dynamic instance are counted too', () => {
  const d = newDocument();
  addBlock(d, 'GRILLE', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 })]);
  addBlock(d, 'AHU', { x: 0, y: 0 }, [makeInsert('GRILLE', { x: 0, y: 0 })]);
  addBlock(d, '*U3', { x: 0, y: 0 }, [makeInsert('GRILLE', { x: 0, y: 0 }), makeInsert('GRILLE', { x: 1, y: 0 })]).effectiveName = 'AHU';
  addEntity(d, makeInsert('*U3', { x: 0, y: 0 }));
  addEntity(d, makeInsert('AHU', { x: 0, y: 0 }));
  assert.deepEqual(countSymbols(d, { nested: true }).rows.map((r) => [r.name, r.count, r.block]), [['AHU', 2, 'AHU'], ['GRILLE', 3, 'GRILLE']]);
});

test('scheduleEntities: the picture is drawn from the row block, not looked up by the row name', async () => {
  globalThis.window ??= { api: {} }; // renderer/clipboard-ui.js reads window.api when loaded
  const { scheduleEntities } = await import('../renderer/symcount-ui.js');
  const d = newDocument();
  addBlock(d, '*U7', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 1 })]).effectiveName = 'Damper';
  addEntity(d, makeInsert('*U7', { x: 0, y: 0 }));
  const { rows, total } = countSymbols(d);
  const ins = scheduleEntities(d, rows, total, { x: 0, y: 0 }, 1).filter((e) => e.type === 'INSERT');
  assert.deepEqual(ins.map((e) => e.block), ['*U7']);
});

test('scheduleEntities: columns are as wide as the drawn text (SHX STANDARD style), so names and counts never overlap', async () => {
  globalThis.window ??= { api: {} };
  const { scheduleEntities } = await import('../renderer/symcount-ui.js');
  const { textFrame } = await import('../src/core/textMetrics.js');
  const d = newDocument();
  d.textStyles.set('STANDARD', { name: 'STANDARD', font: 'romans.shx', fontFile: 'romans.shx' }); // stroke font: wider than 0.6 h per character
  const long = 'M_Supply Diffuser - Rectangular Face Rectangular Neck - 300x300 - 150x150-V3-GF_L _0_60_ Copy 1';
  for (const n of [long, 'WWWWWWWWWWWWWWWWWWWW', 'RCD']) addBlock(d, n, { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 1 })]);
  for (let i = 0; i < 12345; i++) addEntity(d, makeInsert('RCD', { x: i, y: 0 }));
  addEntity(d, makeInsert(long, { x: 0, y: 5 })); addEntity(d, makeInsert('WWWWWWWWWWWWWWWWWWWW', { x: 0, y: 6 }));
  const { rows, total } = countSymbols(d);
  const ents = scheduleEntities(d, rows, total, { x: 0, y: 0 }, 2.5);
  const right = Math.max(...ents.filter((e) => e.type === 'LINE').map((e) => Math.max(e.p1.x, e.p2.x)));
  const vx = [...new Set(ents.filter((e) => e.type === 'LINE' && e.p1.x === e.p2.x).map((e) => e.p1.x))].sort((a, b) => a - b); // column lines
  for (const t of ents.filter((e) => e.type === 'TEXT')) {
    const f = textFrame(t, d), x0 = f.o.x, x1 = x0 + f.w;
    const colEnd = t.text === 'SYMBOL SCHEDULE' ? right : vx.find((x) => x > x0 + 1e-9) ?? right; // the title row has no column lines
    assert.ok(x1 <= colEnd + 1e-9, `"${t.text}" ends at ${x1.toFixed(2)}, past its column edge ${colEnd.toFixed(2)}`);
  }
});
