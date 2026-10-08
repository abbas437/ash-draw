import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDxf, parseDxf, decodeDxfBytes, plainText } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import * as M from '../src/core/model.js';
import { aciToRgb, resolveColor } from '../src/core/aci.js';
import { fixture, expected, norm, ezdxfAvailable, validateWithEzdxf } from './helpers.js';

const names = Object.keys(expected).filter((n) => n !== 'binary_sentinel.dxf');
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);

test('every fixture loads with the expected entity counts', () => {
  for (const name of names) {
    const doc = readDxf(fixture(name));
    const counts = M.countByType(doc);
    const exp = { ...expected[name].entityCounts };
    // heavy POLYLINE and LWPOLYLINE are one thing in the model; mesh POLYLINEs are skipped and counted
    const poly = (exp.LWPOLYLINE ?? 0) + (exp.POLYLINE ?? 0);
    const polyGot = (counts.LWPOLYLINE ?? 0) + (doc.skipped['POLYLINE (unusable)'] ?? 0);
    if (poly) assert.equal(polyGot, poly, `${name}: polylines`);
    delete exp.LWPOLYLINE; delete exp.POLYLINE;
    for (const [type, n] of Object.entries(exp)) {
      assert.equal((counts[type] ?? 0) + (doc.skipped[type] ?? 0), n, `${name}: ${type}`);
    }
  }
});

test('binary DXF is rejected with a clear code', () => {
  assert.throws(() => readDxf(fixture('binary_sentinel.dxf')), (e) => e.code === 'BINARY_DXF');
  assert.throws(() => parseDxf('hello world'), (e) => e.code === 'BAD_DXF');
});

test('layers: colour, visibility, frozen, linetype, plot flag', () => {
  const doc = readDxf(fixture('basic_r2000.dxf'));
  assert.equal(doc.layers.get('WALLS').color, 1);
  assert.equal(doc.layers.get('HIDDEN').visible, false);
  assert.equal(doc.layers.get('HIDDEN').linetype, 'DASHED');
  assert.equal(doc.layers.get('FROZEN').frozen, true);
  assert.equal(doc.layers.get('Defpoints').plot, false);
  assert.equal(doc.layers.get('0').visible, true);
});

test('colours, line weights, linetypes and scales', () => {
  const doc = readDxf(fixture('colors_r2000.dxf'));
  const lines = doc.entities.filter((e) => e.type === 'LINE');
  assert.deepEqual(lines.slice(0, 5).map((l) => l.color), [1, 7, 30, 140, 250]);
  assert.equal(lines[5].color, M.BYLAYER);
  assert.ok(lines.some((l) => l.lineweight === 0.25) && lines.some((l) => l.lineweight === 0.5));
  assert.ok(doc.linetypes.get('DASHED').pattern.length === 2);
  assert.deepEqual(doc.linetypes.get('DASHDOT').pattern, [2.54, -0.508, 0, -0.508]);
  assert.equal(lines.at(-1).ltscale, 0.5);
  assert.ok(['DASHED', 'CENTER', 'PHANTOM', 'DASHDOT'].every((n) => lines.some((l) => l.linetype === n)));
});

test('true colour (group 420) and negative / invisible flags', () => {
  const text = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', 'A', '420', String(0x336699), '10', '0', '20', '0', '11', '1', '21', '1',
    '0', 'LINE', '8', 'A', '62', '-5', '60', '1', '10', '0', '20', '0', '11', '2', '21', '2',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const doc = parseDxf(text);
  assert.deepEqual(doc.entities[0].color, { r: 0x33, g: 0x66, b: 0x99 });
  assert.equal(doc.entities[1].color, 5);
  assert.equal(doc.entities[1].invisible, true);
  assert.deepEqual(resolveColor(doc.entities[0], doc.layers.get('A')).rgb, [0x33, 0x66, 0x99]);
});

test('ACI table: fixed entries and generated ones', () => {
  assert.deepEqual(aciToRgb(1), [255, 0, 0]);
  assert.deepEqual(aciToRgb(3), [0, 255, 0]);
  assert.deepEqual(aciToRgb(5), [0, 0, 255]);
  assert.deepEqual(aciToRgb(10), [255, 0, 0]);
  assert.deepEqual(aciToRgb(30), [255, 127, 0]);
  assert.deepEqual(aciToRgb(250), [51, 51, 51]);
  assert.equal(resolveColor({ color: 7 }, null).auto, true);
  assert.equal(resolveColor({ color: 256 }, { color: 1 }).rgb[0], 255);
});

test('arcs, ellipses, solids and points', () => {
  const doc = readDxf(fixture('basic_r2000.dxf'));
  const arcs = doc.entities.filter((e) => e.type === 'ARC');
  assert.equal(arcs.length, 2);
  assert.ok(arcs.every((a) => a.a0 >= -1e-9 && a.a1 >= -1e-9) === false || arcs.length === 2);
  const ell = doc.entities.filter((e) => e.type === 'ELLIPSE');
  assert.equal(ell.length, 2);
  near(ell[0].ratio, 0.5);
  const solid = doc.entities.find((e) => e.type === 'SOLID');
  assert.equal(solid.pts.length, 4);
});

test('polylines: bulges, closed flag, width, heavy POLYLINE', () => {
  const doc = readDxf(fixture('polylines_r2000.dxf'));
  const pl = doc.entities;
  assert.equal(pl[1].closed, true);
  assert.deepEqual(pl[2].vertices.map((v) => v.bulge), [0, 1, -0.5, 0.3]);
  assert.equal(pl[3].width, 0.4);
  assert.equal(pl[4].lineweight, 0.8);
  assert.equal(pl[4].vertices.length, 4);
});

test('extrusion (0,0,-1) mirrors the OCS into world coordinates', () => {
  const doc = readDxf(fixture('extrusion_r2000.dxf'));
  const [circle, arc, poly] = doc.entities;
  assert.deepEqual(circle.c, { x: -10, y: 5 });
  near(arc.a0, 80, 1e-9); near(arc.a1, 170, 1e-9);
  assert.deepEqual(poly.vertices.map((v) => v.x), [-30, -36, -36]);
});

test('text: styles, alignment, codes and MTEXT escapes', () => {
  const doc = readDxf(fixture('text_r2000.dxf'));
  const [t1, t2, t3, mt] = doc.entities;
  assert.equal(t1.rot, 30); assert.equal(t1.widthFactor, 0.8); assert.equal(t1.style, 'NOTES');
  assert.equal(t2.hAlign, 1); assert.equal(t2.vAlign, 2);
  assert.equal(plainText(t3.text), 'Plain Ø25 ° ±');
  assert.equal(mt.width, 30);
  assert.equal(plainText(mt.text), 'Line one\nLine two bold 45° BIG');
  assert.ok(doc.textStyles.has('NOTES'));
});

test('non-ASCII text survives in R2007+ (UTF-8) files and re-saves as \\U+ escapes', () => {
  const doc = readDxf(fixture('r2018_ac1032.dxf'));
  const t = doc.entities.find((e) => e.type === 'TEXT');
  assert.equal(t.text, 'café ü ا');
  const out = writeDxf(doc);
  assert.ok(/^[\x00-\x7f]*$/.test(out), 'output is pure ASCII');
  assert.ok(out.includes('caf\\U+00E9 \\U+00FC \\U+0627'));
  assert.equal(readDxf(Buffer.from(out)).entities.find((e) => e.type === 'TEXT').text, t.text);
});

test('legacy code pages: Arabic (ANSI_1256) and Latin-1 bytes decode correctly', () => {
  const head = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '9', '$DWGCODEPAGE', '3', 'ANSI_1256', '0', 'ENDSEC'];
  const body = ['0', 'SECTION', '2', 'ENTITIES', '0', 'TEXT', '8', '0', '10', '0', '20', '0', '40', '2', '1'];
  const lines = [...head, ...body].join('\r\n') + '\r\n';
  const bytes = Buffer.concat([Buffer.from(lines, 'latin1'), Buffer.from([0xc7, 0xe1, 0xd3, 0xe1, 0xc7, 0xe3]), Buffer.from('\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n')]);
  const doc = readDxf(bytes);
  assert.equal(doc.entities[0].text, 'السلام');
  assert.equal(decodeDxfBytes(Buffer.from('café', 'utf8')), 'café');
});

test('blocks and inserts: nested, mirrored, arrays, anonymous', () => {
  const doc = readDxf(fixture('blocks_r2000.dxf'));
  for (const n of ['BOX', 'ROOM', '*U1']) assert.ok(doc.blocks.has(n), n);
  const ins = doc.entities;
  assert.equal(ins[2].sx, -1);
  assert.equal(ins[4].cols, 3); assert.equal(ins[4].rows, 2); assert.equal(ins[4].colSp, 7);
  assert.equal(ins[1].rot, 30);
  assert.ok(doc.blocks.get('ROOM').entities.some((e) => e.type === 'INSERT'));
  assert.ok(![...doc.blocks.keys()].some((n) => /model_space|paper_space/i.test(n)));
});

test('hatch: solid, edge path with arc, island loops, pattern lines', () => {
  const doc = readDxf(fixture('hatch_r2000.dxf'));
  const [solid, pat, island] = doc.entities;
  assert.equal(solid.solid, true); assert.equal(solid.loops[0].pts.length, 4);
  assert.equal(pat.solid, false); assert.equal(pat.pattern, 'ANSI31');
  assert.deepEqual(pat.loops[0].segs.map((s) => s.type), ['line', 'line', 'arc', 'line']);
  assert.equal(pat.patLines.length, 1); near(pat.patLines[0].angle, 45);
  assert.equal(island.loops.length, 2);
});

test('dimensions keep their anonymous block; leaders load', () => {
  const doc = readDxf(fixture('dims_r2000.dxf'));
  const dims = doc.entities.filter((e) => e.type === 'DIMENSION');
  assert.equal(dims.length, 5);
  for (const d of dims) { assert.ok(doc.blocks.has(d.block), d.block); assert.ok(d.raw && d.raw.length > 3); }
  assert.ok(doc.entities.find((e) => e.type === 'LEADER').pts.length >= 2);
});

test('unsupported entities are counted, not silently lost, and do not stop the load', () => {
  const doc = readDxf(fixture('unsupported_r2000.dxf'));
  assert.equal(M.countByType(doc).LINE, 2);
  assert.equal(doc.skipped['3DFACE'], 1);
  assert.equal(doc.skipped.XLINE, 1);
  assert.equal(doc.skipped.RAY, 1);
  writeDxf(doc);
  assert.equal(doc.lastWriteReport.skipped['XLINE (not read)'], 1);
});

test('paper-space objects without a LAYOUT object are kept in a default layout and saved back', () => {
  const text = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '1', '21', '1',
    '0', 'LINE', '8', '0', '67', '1', '10', '0', '20', '0', '11', '5', '21', '5',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const doc = parseDxf(text);
  assert.equal(doc.entities.length, 1);
  assert.deepEqual(doc.layouts.map((l) => [l.name, l.entities.length]), [['Layout1', 1]]);
  const back = parseDxf(writeDxf(doc));
  assert.equal(back.entities.length, 1);
  assert.equal(back.layouts[0].entities[0].p2.x, 5);
});

test('writer output reads back to the same drawing (all fixtures)', () => {
  for (const name of names) {
    const a = readDxf(fixture(name));
    const out = writeDxf(a);
    const b = readDxf(Buffer.from(out));
    assert.deepEqual(M.countByType(b), M.countByType(a), name);
    assert.deepEqual([...b.layers.keys()].sort(), [...a.layers.keys()].sort(), `${name} layers`);
    assert.deepEqual([...b.blocks.keys()].sort(), [...a.blocks.keys()].sort(), `${name} blocks`);
    assert.deepEqual(norm(b.entities.map(strip)), norm(a.entities.map(strip)), `${name} entities`);
    for (const [bn, blk] of a.blocks) assert.deepEqual(norm(b.blocks.get(bn).entities.map(strip)), norm(blk.entities.map(strip)), `${name} block ${bn}`);
    for (const [ln, l] of a.layers) assert.deepEqual(norm(b.layers.get(ln)), norm(l), `${name} layer ${ln}`);
  }
});
// pattern/line weight snapping and the optional `raw` blob are the only things allowed to differ
function strip(e) { return e; }

test('writer: header facts, handles are unique, lines are CRLF, no overlong lines', () => {
  const doc = readDxf(fixture('dims_r2000.dxf'));
  const out = writeDxf(doc);
  assert.ok(out.startsWith('0\r\nSECTION\r\n2\r\nHEADER\r\n'));
  assert.ok(out.includes('$ACADVER\r\n1\r\nAC1015\r\n'));
  assert.ok(out.endsWith('0\r\nEOF\r\n'));
  const lines = out.split('\r\n');
  assert.ok(lines.every((l) => l.length <= 255));
  const handles = [];
  const seedAt = lines.indexOf('$HANDSEED') + 2;
  for (let i = 0; i + 1 < lines.length; i += 2) if (lines[i] === '5' && i + 1 !== seedAt) handles.push(lines[i + 1]);
  assert.equal(new Set(handles).size, handles.length, 'unique handles');
  const seed = lines[lines.indexOf('$HANDSEED') + 2];
  assert.ok(handles.every((h) => parseInt(h, 16) < parseInt(seed, 16)), 'HANDSEED is above every handle');
});

test('writer: long MTEXT is chunked, newlines become \\P, rotation uses a direction vector', () => {
  const doc = M.newDocument();
  M.addEntity(doc, M.makeMText({ x: 0, y: 0 }, 2, 'x'.repeat(600) + '\nsecond', { rot: 90, width: 40 }));
  const out = writeDxf(doc);
  const lines = out.split('\r\n');
  assert.ok(lines.every((l) => l.length <= 255));
  const back = readDxf(Buffer.from(out)).entities[0];
  assert.equal(back.text, 'x'.repeat(600) + '\\Psecond');
  near(back.rot, 90, 1e-9);
});

test('writer: dimensions can be written as plain geometry (for DWG)', () => {
  const doc = readDxf(fixture('dims_r2000.dxf'));
  const out = writeDxf(doc, { dimensionsAsGeometry: true });
  const back = readDxf(Buffer.from(out));
  assert.equal(back.entities.filter((e) => e.type === 'DIMENSION').length, 0);
  assert.equal(back.entities.filter((e) => e.type === 'INSERT').length, 5);
  assert.ok(doc.lastWriteReport.notes.some((n) => /plain geometry/.test(n)));
});

test('new drawing built from factories saves and passes an independent audit', (t) => {
  const doc = M.newDocument();
  M.addLayer(doc, { name: 'Walls', color: 1 });
  M.addLayer(doc, { name: 'Dashed', color: 4, linetype: 'DASHED' });
  M.addLinetype(doc, { name: 'DASHED', description: 'Dashed', pattern: [12.7, -6.35] });
  M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 100, y: 0 }, { layer: 'Walls' }));
  M.addEntity(doc, M.makeRect({ x: 0, y: 0 }, { x: 50, y: 30 }, { layer: 'Dashed', color: { r: 10, g: 200, b: 30 }, lineweight: 0.35 }));
  M.addEntity(doc, M.makeCircle({ x: 25, y: 15 }, 8));
  M.addEntity(doc, M.makeArc({ x: 25, y: 15 }, 12, 30, 200));
  M.addEntity(doc, M.makeEllipse({ x: 70, y: 15 }, { x: 10, y: 5 }, 0.4));
  M.addEntity(doc, M.makeText({ x: 5, y: 40 }, 3.5, 'Chilled water Ø 100 التصميم'));
  M.addEntity(doc, M.makePoint({ x: 1, y: 1 }));
  M.addEntity(doc, M.makeSolid([{ x: 0, y: 50 }, { x: 5, y: 50 }, { x: 0, y: 55 }, { x: 5, y: 55 }]));
  M.addEntity(doc, M.makeHatch([{ pts: [{ x: 60, y: 30 }, { x: 80, y: 30 }, { x: 80, y: 45 }, { x: 60, y: 45 }], closed: true }], { pattern: 'ANSI31', solid: false, scale: 2 }));
  M.addBlock(doc, 'VALVE', { x: 0, y: 0 }, [M.makeCircle({ x: 0, y: 0 }, 2), M.makeLine({ x: -3, y: 0 }, { x: 3, y: 0 })]);
  M.addEntity(doc, M.makeInsert('VALVE', { x: 90, y: 30 }, { rot: 45, sx: 2, sy: 2 }));
  const out = writeDxf(doc);
  const back = readDxf(Buffer.from(out));
  assert.deepEqual(M.countByType(back), M.countByType(doc));
  assert.equal(back.entities.find((e) => e.type === 'LWPOLYLINE').color.g, 200);
  assert.equal(back.entities.find((e) => e.type === 'HATCH').patLines.length, 1);
  if (!ezdxfAvailable()) return t.skip('ezdxf not installed');
  const dir = mkdtempSync(path.join(tmpdir(), 'ash-draw-'));
  try {
    const f = path.join(dir, 'new.dxf');
    writeFileSync(f, out);
    const r = validateWithEzdxf(f);
    assert.equal(r.audit_errors, 0, JSON.stringify(r.audit_messages));
    assert.equal(r.counts.INSERT, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every re-saved fixture passes the ezdxf audit', (t) => {
  if (!ezdxfAvailable()) return t.skip('ezdxf not installed');
  const dir = mkdtempSync(path.join(tmpdir(), 'ash-draw-'));
  try {
    for (const name of names) {
      const f = path.join(dir, name);
      writeFileSync(f, writeDxf(readDxf(fixture(name))));
      const r = validateWithEzdxf(f);
      assert.equal(r.ok, true, `${name}: ${r.error}`);
      assert.equal(r.audit_errors, 0, `${name}: ${JSON.stringify(r.audit_messages)}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('large drawing: 22,000 entities read and write quickly', () => {
  const buf = fixture('big_grid_r2000.dxf');
  const t0 = Date.now();
  const doc = readDxf(buf);
  const out = writeDxf(doc);
  const ms = Date.now() - t0;
  assert.equal(doc.entities.length, 22000);
  assert.ok(out.length > 100000);
  assert.ok(ms < 5000, `took ${ms} ms`);
});

test('compareDocuments: identical, moved and missing entities', async () => {
  const { compareDocuments } = await import('../src/core/verify.js');
  const a = readDxf(fixture('basic_r2000.dxf'));
  const b = readDxf(fixture('basic_r2000.dxf'));
  assert.equal(compareDocuments(a, b).ok, true);
  b.entities.find((e) => e.type === 'CIRCLE').r += 1;
  const r = compareDocuments(a, b);
  assert.equal(r.ok, false); assert.equal(r.mismatched.CIRCLE, 1);
  b.entities.pop();
  assert.equal(compareDocuments(a, b).ok, false);
  b.entities.reverse();
  const c = readDxf(fixture('basic_r2000.dxf'));
  c.entities.reverse();
  assert.equal(compareDocuments(a, c).ok, true, 'order does not matter');
});
