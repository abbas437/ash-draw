// Proxy graphics (src/core/proxygfx.js) from a stream built here, and objects kept from their saved graphics
// (dxfRead proxyEntity) written back with their own tags.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProxyGraphics, proxyGraphicsBytes } from '../src/core/proxygfx.js';
import { parseDxf } from '../src/core/dxfRead.js';
import { writeDxf, unkeptObjects } from '../src/core/dxfWrite.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ezdxfAvailable } from './helpers.js';
import { tessellate, bboxOf, transformEntity } from '../src/core/geom.js';

/** records [type, bytes] -> stream (RL total, RL count, then RL size, RL type, data padded to 4 bytes) */
function stream(recs) {
  const body = recs.map(([t, b]) => { const n = 8 + Math.ceil(b.length / 4) * 4; const r = new Uint8Array(n); const dv = new DataView(r.buffer); dv.setUint32(0, n, true); dv.setUint32(4, t, true); r.set(b, 8); return r; });
  const total = 8 + body.reduce((a, r) => a + r.length, 0);
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, total, true); dv.setUint32(4, recs.length, true);
  let at = 8; for (const r of body) { out.set(r, at); at += r.length; }
  return out;
}
const D = (...v) => new Uint8Array(new Float64Array(v).buffer);
const L = (...v) => new Uint8Array(new Int32Array(v).buffer);
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
const str8 = (s) => cat(new TextEncoder().encode(s), new Uint8Array(1));
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

const MOVE = [1, 0, 0, 100, 0, 1, 0, 50, 0, 0, 1, 0, 0, 0, 0, 1]; // translate (100, 50), row-major
const sample = () => stream([
  [6, cat(L(2), D(0, 0, 0, 10, 0, 0))],                                   // polyline of two points (a line)
  [6, cat(L(3), D(0, 0, 0, 10, 0, 0, 10, 5, 0))],                         // polyline
  [14, L(1)],                                                             // colour red
  [2, cat(D(5, 5, 0), D(2), D(0, 0, 1))],                                 // circle
  [29, D(...MOVE)],                                                       // push transform
  [4, cat(D(0, 0, 0), D(3), D(0, 0, 1), D(1, 0, 0), D(Math.PI / 2), L(0))], // quarter arc, moved
  [10, cat(D(1, 2, 0), D(0, 0, 1), D(0, 1, 0), D(2.5, 1, 0), str8('ABC'))], // text at 90 degrees, moved
  [31, new Uint8Array(0)],                                                // pop transform
  [7, cat(L(3), D(0, 0, 0, 1, 0, 0, 0, 1, 0))],                           // polygon (closed), not moved
  [1, D(0, 0, 0, 1, 1, 1)],                                               // extents: skipped
]);

test('proxy graphics: polylines, circle, arc, text, colour change, push / pop transform', () => {
  const parts = parseProxyGraphics(sample(), { layer: 'P', color: 3 });
  assert.deepEqual(parts.map((p) => p.type), ['LWPOLYLINE', 'LWPOLYLINE', 'CIRCLE', 'ARC', 'TEXT', 'LWPOLYLINE']);
  assert.deepEqual(parts[0].vertices.map(({ x, y }) => [x, y]), [[0, 0], [10, 0]]);
  assert.equal(parts[1].vertices.length, 3); assert.equal(parts[1].closed, false);
  assert.equal(parts[0].color, 3, 'the object colour until a colour record');
  assert.equal(parts[0].layer, 'P');
  const c = parts[2]; assert.equal(c.color, 1); near(c.c.x, 5, 'cx'); near(c.r, 2, 'r');
  const a = parts[3]; near(a.c.x, 100, 'arc cx'); near(a.c.y, 50, 'arc cy'); near(a.r, 3, 'arc r'); near(a.a0, 0, 'a0'); near(a.a1, 90, 'a1');
  const t = parts[4]; assert.equal(t.text, 'ABC'); near(t.p.x, 101, 'tx'); near(t.p.y, 52, 'ty'); near(t.rot, 90, 'rot'); near(t.height, 2.5, 'h');
  const g = parts[5]; assert.equal(g.closed, true); near(g.vertices[1].x, 1, 'after pop, not moved');
});

test('proxy graphics: a clockwise arc (normal -Z), a shell, a mesh, and a record cut short', () => {
  const [arc] = parseProxyGraphics(stream([[4, cat(D(0, 0, 0), D(1), D(0, 0, -1), D(1, 0, 0), D(Math.PI / 2), L(0))]]));
  near(arc.a0, -90, 'cw arc a0'); near(arc.a1, 0, 'cw arc a1');
  const shell = parseProxyGraphics(stream([[9, cat(L(4), D(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0), L(8), L(3, 0, 1, 2), L(3, 0, 2, 3))]]));
  assert.equal(shell.length, 2); assert.ok(shell.every((p) => p.closed && p.vertices.length === 3));
  const mesh = parseProxyGraphics(stream([[8, cat(L(2, 2), D(0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0))]]));
  assert.equal(mesh.length, 4);
  const short = stream([[6, cat(L(50), D(0, 0, 0))], [2, cat(D(0, 0, 0), D(1), D(0, 0, 1))]]);
  assert.deepEqual(parseProxyGraphics(short).map((p) => p.type), ['CIRCLE'], 'a bad record is skipped, the next one read');
});

test('proxy graphics bytes: the 310 run after the 92 size', () => {
  const s = sample();
  const tags = [[90, '499'], [92, String(s.length)], [310, hex(s.subarray(0, 20))], [310, hex(s.subarray(20))], [93, '0'], [310, 'FF']];
  assert.deepEqual([...proxyGraphicsBytes(tags)], [...s]);
});

// a drawing with a proxy entity, a custom object carrying graphics in its common part, and a 3DSOLID with ACIS data
function drawing() {
  const s = sample();
  const g = hex(s), half = g.length / 2;
  const custom = stream([[6, cat(L(2), D(0, 0, 0, 0, 7, 0))]]);
  return ['0', 'SECTION', '2', 'ENTITIES',
    '0', 'ACAD_PROXY_ENTITY', '5', '2A', '330', '1F', '100', 'AcDbEntity', '8', 'P', '62', '3',
    '100', 'AcDbProxyEntity', '90', '498', '91', '500', '92', String(s.length), '310', g.slice(0, half), '310', g.slice(half),
    '93', '32', '310', '0102030405060708', '330', '2B', '94', '0', '95', '1335', '70', '0',
    '0', 'AECC_THING', '5', '2C', '330', '1F', '100', 'AcDbEntity', '8', 'C', '92', String(custom.length), '310', hex(custom),
    '100', 'AeccDbThing', '90', '7', '1', 'name', '340', '2D',
    '0', '3DSOLID', '5', '2E', '330', '1F', '100', 'AcDbEntity', '8', 'S',
    '100', 'AcDbModelerGeometry', '70', '1', '1', 'mnn m o n', '1', ' ^*^ ', '3', '-- [', '100', 'AcDb3dSolid', '350', '0',
    '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
}
const kept = (doc) => doc.entities.filter((e) => e.type === 'PROXY');

test('kept objects: drawn read-only from their graphics; the solid is kept but not drawn', () => {
  const doc = parseDxf(drawing());
  const [p, c, s] = kept(doc);
  assert.deepEqual([p.name, c.name, s.name], ['ACAD_PROXY_ENTITY', 'AECC_THING', '3DSOLID']);
  assert.equal(p.parts.length, 6); assert.equal(c.parts.length, 1); assert.equal(s.parts.length, 0);
  assert.equal(c.parts[0].layer, 'C');
  assert.ok(tessellate(p).length >= 5);
  const b = bboxOf(p, doc); near(b.maxx, 103, 'extents reach the moved arc');
  assert.throws(() => transformEntity(p, [1, 0, 0, 1, 5, 5]), /saved graphics/);
  assert.deepEqual(doc.skipped, {});
});

test('an ACAD_PROXY_ENTITY is saved back as read; the other kinds are left out, and the save report counts them', () => {
  const doc = parseDxf(drawing());
  const again = kept(parseDxf(writeDxf(doc)));
  assert.deepEqual(again.map((e) => e.name), ['ACAD_PROXY_ENTITY']);
  assert.equal(doc.lastWriteReport.skipped.ACAD_PROXY_ENTITY, undefined);
  assert.equal(doc.lastWriteReport.skipped.AECC_THING, 1);
  assert.equal(doc.lastWriteReport.skipped['3DSOLID'], 1);
  // DWG through LibreDWG (dimensions as geometry) cannot take it: left out and counted
  writeDxf(doc, { dimensionsAsGeometry: true });
  assert.equal(doc.lastWriteReport.skipped.ACAD_PROXY_ENTITY, 1);
});

// ACAD_PROXY_ENTITY with graphics, entity data, object ids and XDATA, in model space and in a block definition
function proxyRec(h, owner, layer, g, extra = []) {
  return ['0', 'ACAD_PROXY_ENTITY', '5', h, '330', owner, '100', 'AcDbEntity', '8', layer,
    '100', 'AcDbProxyEntity', '90', '498', '91', '500', '92', String(g.length / 2), '310', g,
    '93', '64', '310', '0102030405060708', '330', '1F', '340', '2B', '350', '0', '360', '2D', '94', '0', '95', String((4 << 16) | 31), '70', '0',
    ...extra];
}
function proxyDrawing() {
  const g = hex(sample());
  return ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1027', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '5', '40', '330', '41', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockBegin', '2', 'CIVIL', '70', '0', '10', '0', '20', '0', '30', '0', '3', 'CIVIL', '1', '',
    ...proxyRec('42', '41', 'B', g),
    '0', 'ENDBLK', '5', '43', '330', '41', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockEnd',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    ...proxyRec('2A', '1F', 'P', g, ['1001', 'CIVIL_APP', '1000', 'alignment', '1005', '2B']),
    '0', 'INSERT', '5', '44', '330', '1F', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockReference', '2', 'CIVIL', '10', '0', '20', '0', '30', '0',
    '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
}
const isPtr = (c) => (c >= 320 && c <= 369) || c === 1005;

test('ACAD_PROXY_ENTITY round trip: model and block, same graphics and entity data, null object ids, valid handles', (t) => {
  const doc = parseDxf(proxyDrawing());
  const before = [...kept(doc), ...kept({ entities: doc.blocks.get('CIVIL').entities })];
  assert.equal(before.length, 2);
  const text = writeDxf(doc);
  const doc2 = parseDxf(text);
  const after = [...kept(doc2), ...kept({ entities: doc2.blocks.get('CIVIL').entities })];
  assert.deepEqual(after.map((e) => e.name), ['ACAD_PROXY_ENTITY', 'ACAD_PROXY_ENTITY']);
  assert.deepEqual(after.map((e) => e.layer), ['P', 'B']);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(after[i].raw.filter(([c]) => c === 310), before[i].raw.filter(([c]) => c === 310), 'graphics and entity data as read');
    assert.deepEqual(after[i].raw, before[i].raw.map(([c, v]) => [c, isPtr(c) ? '0' : v]), 'object ids kept in place as null handles');
    assert.equal(after[i].parts.length, before[i].parts.length, 'still drawn from its graphics');
  }
  assert.deepEqual(doc.lastWriteReport.skipped, {});
  assert.ok(text.includes('\r\nAPPID\r\n5\r\n'), 'APPID table');
  assert.ok(/\r\n2\r\nCIVIL_APP\r\n/.test(text), 'the XDATA application is registered');
  const py = ezdxfAvailable();
  if (!py) { t.skip('ezdxf not installed'); return; }
  const dir = mkdtempSync(path.join(tmpdir(), 'ash-proxy-'));
  try {
    const f = path.join(dir, 'proxy.dxf');
    writeFileSync(f, text);
    const r = spawnSync(py, ['-c', `import ezdxf,sys
d=ezdxf.readfile(sys.argv[1]); a=d.audit()
ps=[e for e in d.entitydb.values() if e.dxftype()=='ACAD_PROXY_ENTITY']
owners=[d.entitydb[e.dxf.owner].dxftype() for e in ps]
print(len(a.errors), len(ps), len(set(e.dxf.handle for e in ps)), ','.join(owners), ','.join(sorted(d.entitydb[e.dxf.owner].dxf.name for e in ps)))`, f], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), '0 2 2 BLOCK_RECORD,BLOCK_RECORD *Model_Space,CIVIL', r.stderr);
  } finally { rmSync(dir, { recursive: true }); }
});

test('the Save guard counts exactly what the writer leaves out (unkeptObjects = lastWriteReport.skipped)', () => {
  const doc = parseDxf(drawing());
  doc.skipped.HELIX = 2;
  doc.entities.push({ id: 0, type: 'LWPOLYLINE', layer: '0', vertices: [{ x: 0, y: 0 }] },
    { id: 0, type: 'SPLINE', layer: '0', ctrl: [{ x: 0, y: 0 }], fit: [] },
    { id: 0, type: 'INSERT', layer: '0', block: 'NOPE', p: { x: 0, y: 0 }, sx: 1, sy: 1 },
    { id: 0, type: 'FOO', layer: '0' });
  for (const opts of [{}, { dimensionsAsGeometry: true }, { mleadersAsGeometry: true }]) {
    const guard = unkeptObjects(doc, opts);
    writeDxf(doc, opts);
    assert.deepEqual(guard, doc.lastWriteReport.skipped, JSON.stringify(opts));
  }
  assert.deepEqual(unkeptObjects(doc), { AECC_THING: 1, '3DSOLID': 1, 'LWPOLYLINE (fewer than 2 vertices)': 1, 'SPLINE (unusable)': 1,
    'INSERT (block missing)': 1, FOO: 1, 'HELIX (not read)': 2 });
});

test('the Save guard uses the save route\'s writer options: a proxy is kept by DXF and ODA, left out by LibreDWG', async () => {
  const { droppedBySave } = await import('../renderer/files.js');
  const doc = parseDxf(drawing());
  doc.entities = doc.entities.filter((e) => e.type === 'PROXY' && e.name === 'ACAD_PROXY_ENTITY');
  for (const b of doc.blocks.values()) b.entities = [];
  assert.equal(doc.entities.length, 1);
  assert.deepEqual(droppedBySave(doc, 'dxf'), [], 'DXF overwrite');
  assert.deepEqual(droppedBySave(doc, 'dwg', 'acad2018'), [], 'DWG through ODA');
  assert.deepEqual(droppedBySave(doc, 'dwg', 'r2000'), ['1 ACAD_PROXY_ENTITY'], 'DWG through LibreDWG');
});
