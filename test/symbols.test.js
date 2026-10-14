import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addBlock, addEntity, makeLine, makeCircle, makeInsert } from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { makeAttdef } from '../src/core/blocks.js';
import { bboxOf } from '../src/core/geom.js';
import { symbolsFromDxf, cleanSymbolName, thumbKey, symbolScale, insertSymbol, drawSymbolThumb, symbolPolylines } from '../src/core/symbols-lib.js';
import { builtinSymbols } from '../src/core/symbols-builtin.js';

/** a CIBSE-style symbol file: model-space geometry, AC1015, $INSBASE as given, units as given */
function modelSymbolDxf({ insbase = null, units = 4, at = { x: 0, y: 0 } } = {}) {
  const d = newDocument(); d.units = units;
  if (insbase) d.header.insbase = insbase;
  addEntity(d, makeCircle({ x: at.x, y: at.y }, 2));
  addEntity(d, makeLine({ x: at.x - 3, y: at.y }, { x: at.x + 3, y: at.y }));
  addEntity(d, makeAttdef({ x: at.x, y: at.y - 4 }, 1, 'REF', { prompt: 'Reference', default: 'X1' }));
  return writeDxf(d);
}

test('model-space symbol file: $INSBASE base point, ATTDEF kept, units for scaling', () => {
  const [s] = symbolsFromDxf(modelSymbolDxf({ insbase: { x: 10, y: 5 }, units: 6, at: { x: 10, y: 5 } }), 'Mech_Vent_AirTerminals_Ceiling_Return.dxf');
  assert.equal(s.name, 'Ceiling Return');
  assert.deepEqual(s.base, { x: 10, y: 5 });
  assert.equal(s.units, 6);
  assert.equal(s.entities.filter((e) => e.attdef).length, 1);
  assert.equal(s.entities.find((e) => e.attdef).attdef.default, 'X1');
  assert.equal(symbolScale(s, 4), 1000, 'metres -> millimetres');
  assert.equal(symbolScale(s, 6, { scale: 2 }), 2);
  assert.equal(symbolScale({ ...s, paper: true }, 6, { drawingScale: 50 }), 50, 'paper symbols follow the drawing scale');
  assert.equal(symbolScale(s, 6, { drawingScale: 50 }), 1, 'real-size symbols ignore it');
});

test('base point without $INSBASE: the origin when the geometry surrounds it, else the centre of the bounds', () => {
  assert.deepEqual(symbolsFromDxf(modelSymbolDxf(), 'a.dxf')[0].base, { x: 0, y: 0 });
  const b = symbolsFromDxf(modelSymbolDxf({ at: { x: 100, y: 50 } }), 'a.dxf')[0].base;
  assert.ok(Math.abs(b.x - 100) < 1e-9 && b.y > 46 && b.y < 50, JSON.stringify(b));
});

test('block library DXF: each top-level block is a symbol; nested blocks travel with it', () => {
  const d = newDocument(); d.units = 4;
  addBlock(d, 'BOLT', { x: 0, y: 0 }, [makeCircle({ x: 0, y: 0 }, 1)]);
  addBlock(d, 'VALVE', { x: 5, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }), makeInsert('BOLT', { x: 5, y: 0 }), makeAttdef({ x: 5, y: 2 }, 1, 'TAG', { default: 'V1' })]);
  addBlock(d, 'PUMP', { x: 0, y: 0 }, [makeCircle({ x: 0, y: 0 }, 5)]);
  const syms = symbolsFromDxf(writeDxf(d), 'lib.dxf');
  assert.deepEqual(syms.map((s) => s.name).sort(), ['PUMP', 'VALVE'], 'BOLT is only nested');
  const v = syms.find((s) => s.name === 'VALVE');
  assert.deepEqual(v.base, { x: 5, y: 0 });
  assert.deepEqual([...v.blocks.keys()], ['BOLT']);
  assert.ok(symbolPolylines(v).length >= 2, 'the line and the nested block (text is not tessellated)');
});

test('malformed and oversized files are refused with BAD_SYMBOL', () => {
  for (const src of ['', 'not a dxf at all', '0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n']) assert.throws(() => symbolsFromDxf(src, 'x.dxf'), (e) => e.code === 'BAD_SYMBOL', JSON.stringify(src));
  assert.throws(() => symbolsFromDxf(new Uint8Array(9 * 1024 * 1024), 'big.dxf'), (e) => e.code === 'BAD_SYMBOL');
});

test('cleanSymbolName and thumbKey', () => {
  assert.equal(cleanSymbolName('C:\\lib\\Mech_Vent_AirTerminals_Ceiling_Return.dxf'), 'Ceiling Return');
  assert.equal(cleanSymbolName('FireDamper.DWG'), 'Fire Damper');
  assert.equal(cleanSymbolName('gate_valve.dxf'), 'gate valve');
  const k = thumbKey('C:/a/b.dxf', 1000, 20);
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(k, thumbKey('c:/a/B.dxf', 1000, 20), 'case-insensitive path');
  assert.notEqual(k, thumbKey('C:/a/b.dxf', 1001, 20), 'mtime changes the key');
  assert.notEqual(k, thumbKey('C:/a/b.dxf', 1000, 21), 'size changes the key');
});

test('built-in set: ~30 symbols, each with a non-empty bounding box and a thumbnail', () => {
  const syms = builtinSymbols();
  assert.ok(syms.length >= 30, `${syms.length}`);
  assert.equal(new Set(syms.map((s) => s.name)).size, syms.length, 'unique names');
  const calls = { stroke: 0 };
  const ctx = { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { calls.stroke++; } };
  for (const s of syms) {
    const doc = newDocument();
    let b = null;
    for (const e of s.entities) { const x = bboxOf(e, doc); if (x) b = b ? { minx: Math.min(b.minx, x.minx), maxx: Math.max(b.maxx, x.maxx), miny: Math.min(b.miny, x.miny), maxy: Math.max(b.maxy, x.maxy) } : x; }
    assert.ok(b && b.maxx - b.minx > 0 && b.maxy - b.miny > 0, `${s.name} has a bounding box`);
    assert.equal(drawSymbolThumb(ctx, s, 64, 64), true, s.name);
  }
  assert.ok(calls.stroke >= syms.length);
});

test('insert: one undo step adds the block and one INSERT; undo removes both; identical definition reused, a different one suffixed', () => {
  const d = newDocument(); d.units = 4;
  const s = new Session(d);
  const [vav] = builtinSymbols().filter((x) => x.name === 'VAV Box');
  const n0 = d.entities.length;
  const r = insertSymbol(s, vav, { x: 100, y: 200 }, { rot: 90, scale: 2, values: { TAG: 'VAV-07' } });
  assert.equal(r.block, 'VAV Box');
  assert.equal(d.entities.length, n0 + 1);
  const ins = d.entities.at(-1);
  assert.equal(ins.type, 'INSERT'); assert.equal(ins.block, 'VAV Box'); assert.equal(ins.rot, 90); assert.equal(ins.sx, 2);
  assert.equal(ins.attribs[0].text, 'VAV-07');
  assert.ok(d.blocks.has('VAV Box'));
  s.undo();
  assert.equal(d.entities.length, n0);
  assert.ok(!d.blocks.has('VAV Box'), 'undo removes the block definition too');
  s.redo();
  insertSymbol(s, vav, { x: 0, y: 0 });
  assert.equal([...d.blocks.keys()].filter((k) => k.startsWith('VAV Box')).length, 1, 'identical definition reused');
  const other = { ...vav, entities: [makeCircle({ x: 0, y: 0 }, 9)] };
  assert.equal(insertSymbol(s, other, { x: 0, y: 0 }).block, 'VAV Box (2)');
});

test('insert of a library symbol defines its nested blocks', () => {
  const d0 = newDocument();
  addBlock(d0, 'BOLT', { x: 0, y: 0 }, [makeCircle({ x: 0, y: 0 }, 1)]);
  addBlock(d0, 'VALVE', { x: 0, y: 0 }, [makeInsert('BOLT', { x: 5, y: 0 })]);
  const [v] = symbolsFromDxf(writeDxf(d0), 'lib.dxf');
  const d = newDocument(); addBlock(d, 'BOLT', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 1 })]);
  const s = new Session(d);
  insertSymbol(s, v, { x: 0, y: 0 });
  assert.equal(d.blocks.get('VALVE').entities[0].block, 'BOLT (2)', 'clashing nested block renamed and referenced');
  s.undo();
  assert.ok(!d.blocks.has('VALVE') && !d.blocks.has('BOLT (2)') && d.blocks.has('BOLT'));
});
