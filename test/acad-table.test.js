// ACAD_TABLE (equipment schedules, legends, title blocks): read as a reference to its graphics block (*Tn), so it
// draws, selects and explodes like an INSERT, and saved as a plain block reference (INSERT) to that block renamed to
// an ordinary anonymous *U block: never as an ACAD_TABLE, which an R2000 file cannot hold (dxfRead buildTable).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDxf } from '../src/core/dxfRead.js';
import { writeDxf, unkeptObjects, TABLE_NOTE } from '../src/core/dxfWrite.js';
import { bboxOf, docExtents, explode, transformEntity } from '../src/core/geom.js';
import { ezdxfAvailable } from './helpers.js';
import { compareDocuments } from '../src/core/verify.js';
import { saveDwg, saveWriterOpts, savedToast, loadDrawing } from '../renderer/files.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

/** a one-cell table at (100, 50) on layer SCHED; its block *T1 holds the cell border (a LINE) and the cell text */
function tableDrawing({ placement = [], tableCodes = [] } = {}) {
  return ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1027', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '5', '40', '330', '41', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockBegin', '2', '*T1', '70', '1',
    '10', '0.0', '20', '0.0', '30', '0.0', '3', '*T1', '1', '',
    '0', 'LINE', '5', '42', '330', '41', '100', 'AcDbEntity', '8', '0', '100', 'AcDbLine', '10', '0.0', '20', '0.0', '30', '0.0', '11', '40.0', '21', '-10.0', '31', '0.0',
    '0', 'TEXT', '5', '43', '330', '41', '100', 'AcDbEntity', '8', '0', '100', 'AcDbText', '10', '1.0', '20', '-8.0', '30', '0.0', '40', '2.5', '1', 'PUMP P-101', '100', 'AcDbText',
    '0', 'ENDBLK', '5', '44', '330', '41', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockEnd',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'ACAD_TABLE', '5', '2A', '330', '1F', '100', 'AcDbEntity', '8', 'SCHED', '62', '3',
    '100', 'AcDbBlockReference', '2', '*T1', '10', '100.0', '20', '50.0', '30', '0.0', ...placement,
    '100', 'AcDbTable', ...tableCodes, '280', '0', '342', '4F', '343', '41', '11', '1.0', '21', '0.0', '31', '0.0',
    '90', '22', '91', '1', '92', '1', '93', '0', '94', '0', '95', '0', '96', '0', '141', '10.0', '142', '40.0',
    '171', '1', '172', '0', '173', '0', '174', '0', '175', '1', '176', '1', '91', '262177', '178', '0', '145', '0.0',
    '92', '0', '301', 'CELL_VALUE', '93', '6', '90', '4', '1', 'PUMP P-101', '94', '0', '300', '', '302', 'PUMP P-101', '304', 'ACVALUE_END',
    '7', 'Standard', '344', '0',
    '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
}
const tables = (doc) => doc.entities.filter((e) => e.table);
/** the written file's records of type `type` in ENTITIES, as [code, value] lists */
function records(text, type) {
  const l = text.split(/\r?\n/), out = [];
  const from = l.findIndex((v, i) => v === 'ENTITIES' && l[i - 1].trim() === '2');
  for (let i = from + 1; i < l.length - 1; i += 2) {
    if (l[i].trim() === '0' && l[i + 1] === 'ENDSEC') break;
    if (l[i].trim() === '0') out.push({ type: l[i + 1], tags: [] }); else out.at(-1)?.tags.push([+l[i], l[i + 1]]);
  }
  return out.filter((r) => r.type === type).map((r) => r.tags);
}
/** the table's tags from AcDbBlockReference on, as the file has them */
const own = (tags) => tags.slice(tags.findIndex(([c, v]) => c === 100 && v === 'AcDbBlockReference'));

test('read: an ACAD_TABLE is a reference to its *T block, at its position, with a Table marker; nothing skipped', () => {
  const doc = parseDxf(tableDrawing());
  assert.deepEqual(doc.skipped, {});
  assert.equal(doc.entities.length, 1);
  const [t] = doc.entities;
  assert.equal(t.type, 'INSERT'); assert.equal(t.block, '*T1'); assert.equal(t.layer, 'SCHED'); assert.equal(t.color, 3);
  near(t.p.x, 100, 'x'); near(t.p.y, 50, 'y'); near(t.rot, 0, 'rot'); near(t.sx, 1, 'sx'); near(t.sy, 1, 'sy');
  assert.ok(t.table?.raw?.length, 'kept as a table');
  // its graphics: extents and explode come from the block
  const b = bboxOf(t, doc);
  near(b.minx, 100, 'minx'); near(b.maxx, 140, 'maxx'); near(b.miny, 40, 'miny'); near(b.maxy, 50, 'maxy');
  const ext = docExtents(doc); near(ext.maxx, 140, 'drawing extents');
  const parts = explode(t, doc);
  assert.deepEqual(parts.map((e) => e.type), ['LINE', 'TEXT']);
  assert.equal(parts[1].text, 'PUMP P-101'); near(parts[0].p2.x, 140, 'exploded line');
});

test('read: rotation from 50, else from the 11 direction; scale from 41 / 42', () => {
  near(tables(parseDxf(tableDrawing({ placement: ['41', '2.0', '42', '3.0', '43', '1.0', '50', '30.0'] })))[0].rot, 30, '50');
  const [s] = tables(parseDxf(tableDrawing({ placement: ['41', '2.0', '42', '3.0', '43', '1.0'] })));
  near(s.sx, 2, 'sx'); near(s.sy, 3, 'sy');
  const [r] = tables(parseDxf(tableDrawing().replace('\n11\n1.0\n21\n0.0\n', '\n11\n0.0\n21\n1.0\n')));
  near(r.rot, 90, 'from the direction vector');
});

test('read: cell margins and other AcDbTable codes are not taken as the scale or rotation', () => {
  const [t] = tables(parseDxf(tableDrawing({ tableCodes: ['40', '0.06', '41', '0.06', '42', '0.5', '43', '0.5', '50', '12.0'] })));
  near(t.sx, 1, 'sx'); near(t.sy, 1, 'sy'); near(t.rot, 0, 'rot');
  near(bboxOf(t, parseDxf(tableDrawing())).maxx, 140, 'full size');
});

/** the BLOCK records of the written file: { name, flags, types } */
function blocksOf(text) {
  const l = text.split(/\r?\n/), out = [];
  const from = l.findIndex((v, i) => v === 'BLOCKS' && l[i - 1].trim() === '2');
  let cur = null;
  for (let i = from + 1; i < l.length - 1; i += 2) {
    const c = +l[i], v = l[i + 1];
    if (c === 0 && v === 'ENDSEC') break;
    if (c === 0) { if (v === 'BLOCK') out.push(cur = { name: null, flags: null, types: [] }); else if (v !== 'ENDBLK') cur.types.push(v); continue; }
    if (cur && !cur.types.length && c === 2 && cur.name === null) cur.name = v;
    if (cur && !cur.types.length && c === 70 && cur.flags === null) cur.flags = +v;
  }
  return out;
}
const tag = (tags, c) => tags.find(([k]) => k === c)?.[1];

test('write: a table is saved as a plain INSERT of its block, renamed to an anonymous *U block; no ACAD_TABLE', () => {
  const doc = parseDxf(tableDrawing());
  const text = writeDxf(doc);
  assert.deepEqual(unkeptObjects(doc), {}); assert.deepEqual(doc.lastWriteReport.skipped, {});
  assert.deepEqual(doc.lastWriteReport.notes, [TABLE_NOTE]);
  assert.equal(records(text, 'ACAD_TABLE').length, 0);
  assert.ok(!/ACAD_TABLE|AcDbTable/.test(text), 'no table entity or class');
  assert.ok(!/\r\n\*T1\r\n/.test(text), 'no *T block name');
  const [ins] = records(text, 'INSERT');
  assert.equal(tag(ins, 2), '*U1'); near(+tag(ins, 10), 100, 'x'); near(+tag(ins, 20), 50, 'y');
  assert.equal(tag(ins, 8), 'SCHED'); assert.equal(+tag(ins, 62), 3);
  assert.ok(!ins.some(([c]) => c === 342 || c === 343 || c === 344), 'no table references');
  assert.deepEqual(blocksOf(text).find((b) => b.name === '*U1'), { name: '*U1', flags: 1, types: ['LINE', 'TEXT'] });
  // read back: a plain block reference, drawn the same
  const back = parseDxf(text);
  const [e] = back.entities;
  assert.equal(e.type, 'INSERT'); assert.equal(e.block, '*U1'); assert.equal(e.table, undefined);
  const b = bboxOf(e, back); near(b.minx, 100, 'minx'); near(b.maxx, 140, 'maxx'); near(b.miny, 40, 'miny');

  // the name is past the drawing's own *U blocks
  doc.blocks.set('*U3', { name: '*U3', base: { x: 0, y: 0 }, entities: [] });
  assert.equal(tag(records(writeDxf(doc), 'INSERT')[0], 2), '*U4');
});

test('write: a moved, scaled and turned table, and a copy, write their placement on the INSERT', () => {
  const doc = parseDxf(tableDrawing());
  const [t] = doc.entities;
  const c = Math.SQRT1_2 * 2; // 45 degrees, scale 2
  const turned = transformEntity(t, [c, c, -c, c, 5, -7]);
  doc.entities = [turned, transformEntity(t, [1, 0, 0, 1, 0, -20])];
  const text = writeDxf(doc);
  assert.equal(records(text, 'ACAD_TABLE').length, 0);
  const [a, b] = records(text, 'INSERT');
  assert.equal(tag(a, 2), '*U1'); assert.equal(tag(b, 2), '*U1');
  near(+tag(a, 10), turned.p.x, 'x'); near(+tag(a, 20), turned.p.y, 'y');
  near(+tag(a, 41), 2, 'sx'); near(+tag(a, 42), 2, 'sy'); near(+tag(a, 50), 45, 'rot');
  near(+tag(b, 10), 100, 'copy x'); near(+tag(b, 20), 30, 'copy y');
  assert.deepEqual(doc.lastWriteReport.notes, [TABLE_NOTE], 'one note');
  const [ra, rb] = parseDxf(text).entities;
  near(ra.rot, 45, 're-read rot'); near(ra.sx, 2, 're-read sx'); near(rb.p.y, 30, 're-read copy y');
});

test('write: an exploded table is written as its block entities; a DWG save (LibreDWG) as a plain reference too', () => {
  const doc = parseDxf(tableDrawing());
  const t = doc.entities[0];
  doc.entities = explode(t, doc);
  const text = writeDxf(doc);
  assert.equal(records(text, 'ACAD_TABLE').length, 0);
  assert.deepEqual([records(text, 'LINE').length, records(text, 'TEXT').length], [1, 1]);
  assert.deepEqual(doc.lastWriteReport.notes, []);

  doc.entities = [t];
  for (const opts of [{ dimensionsAsGeometry: true }, { mleadersAsGeometry: true }]) {
    assert.deepEqual(unkeptObjects(doc, opts), {});
    const dwg = writeDxf(doc, opts);
    assert.deepEqual([records(dwg, 'ACAD_TABLE').length, tag(records(dwg, 'INSERT')[0], 2)], [0, '*U1']);
    assert.deepEqual(doc.lastWriteReport.notes, [TABLE_NOTE]);
  }
});

test('ezdxf audits the written table cleanly and reads it as an INSERT of its block', (t) => {
  const py = ezdxfAvailable();
  if (!py) { t.skip('ezdxf not installed'); return; }
  const dir = mkdtempSync(path.join(tmpdir(), 'ash-table-'));
  try {
    const f = path.join(dir, 'table.dxf');
    writeFileSync(f, writeDxf(parseDxf(tableDrawing())));
    const r = spawnSync(py, ['-c', `import ezdxf,sys
d=ezdxf.readfile(sys.argv[1]); a=d.audit()
es=[e.dxftype() for e in d.modelspace()]
i=d.modelspace()[0]
print(len(a.errors), es, i.dxf.name, tuple(round(v, 6) for v in i.dxf.insert)[:2], sorted(e.dxftype() for e in d.blocks.get(i.dxf.name)))`, f], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), "0 ['INSERT'] *U1 (100.0, 50.0) ['LINE', 'TEXT']", r.stderr);
  } finally { rmSync(dir, { recursive: true }); }
});

// ---- DWG read-back check, save notes, reader and open note (review fixes) ----
const nestedTable = () => {
  const doc = parseDxf(tableDrawing());
  const [t] = doc.entities;
  doc.blocks.set('OUTER', { name: 'OUTER', base: { x: 0, y: 0 }, entities: [t] });
  doc.entities = [{ type: 'INSERT', block: 'OUTER', p: { x: 5, y: 5 }, sx: 1, sy: 1, rot: 0, layer: '0' }];
  return doc;
};
for (const [label, mk] of [['top level', () => parseDxf(tableDrawing())], ['nested in a block', nestedTable]]) {
  for (const version of ['r2000', 'acad2018']) {
    test(`DWG read-back check passes for a table (${label}, ${version} route)`, async () => {
      const doc = mk();
      const opts = saveWriterOpts('dwg', version);
      const text = writeDxf(doc, opts);
      if (label === 'top level') {
        assert.equal(compareDocuments(doc, parseDxf(text)).ok, false, 'without the rename map the *T1 / *U1 names differ');
        assert.deepEqual(doc.lastWriteReport.renamedBlocks, { '*T1': '*U1' });
        assert.equal(compareDocuments(doc, parseDxf(text), 5, doc.lastWriteReport.renamedBlocks).ok, true);
      }
      // the real save path: the converters are replaced by an identity round trip of the DXF
      const api = { isElectron: true, dwgAvailable: async () => ({ available: true }), saveFile: async () => ({ path: 'p' }),
        dxfToDwg: async (b) => ({ dwgBytes: b }), dwgToDxf: async (b) => ({ dxfBytes: b, converter: 'ODA' }) };
      const r = await saveDwg(api, doc, { name: 'a.dxf', version });
      assert.equal(r.verification.ok, true, JSON.stringify(r.verification));
    });
  }
}

test('save notes: four undefined linetypes give one note, and the table note still reaches the toast (<= 300 characters)', () => {
  const doc = parseDxf(tableDrawing());
  for (const n of ['LTA', 'LTB', 'LTC', 'LTD']) doc.entities.push({ type: 'LINE', layer: '0', linetype: n, p1: { x: 0, y: 0 }, p2: { x: 1, y: 1 } });
  writeDxf(doc);
  const notes = doc.lastWriteReport.notes;
  assert.equal(notes.filter((n) => /^Linetypes not defined/.test(n)).length, 1);
  assert.equal(notes[0], TABLE_NOTE);
  assert.ok(notes.includes('Linetypes not defined, written as BYLAYER: LTA, LTB, LTC, LTD'));
  const [text] = savedToast('Saved', { report: doc.lastWriteReport });
  assert.ok(text.includes(TABLE_NOTE.replace(/\.$/, '')) && text.length <= 300, `${text.length}: ${text}`);
  for (const n of ['E', 'F', 'G']) doc.entities.push({ type: 'LINE', layer: '0', linetype: n, p1: { x: 0, y: 0 }, p2: { x: 1, y: 1 } });
  writeDxf(doc);
  assert.ok(doc.lastWriteReport.notes.includes('Linetypes not defined, written as BYLAYER: LTA, LTB, LTC, LTD, E and 2 more'));
});

test('read: a table record with AcDbBlockReference but no AcDbTable marker takes no scale or rotation from the codes after it', () => {
  const text = tableDrawing().replace('\n100\nAcDbTable\n', '\n').replace(/\n11\n1\.0\n21\n0\.0\n31\n0\.0\n/, '\n');
  assert.ok(!text.includes('AcDbTable'));
  const [t] = tables(parseDxf(text.replace('\n280\n0\n', '\n41\n0.06\n42\n0.06\n50\n12\n280\n0\n')));
  near(t.sx, 1, 'sx'); near(t.sy, 1, 'sy'); near(t.rot, 0, 'rot');
});

test('open: a table whose *T block is missing is reported in the open notes', async () => {
  const text = tableDrawing().replace('2\n*T1\n70', '2\n*X1\n70').replace('3\n*T1', '3\n*X1');
  const { notes } = await loadDrawing({ isElectron: false }, 'a.dxf', new TextEncoder().encode(text), { path: null });
  assert.ok(notes.some((n) => /1 table without its graphics block/.test(n)), notes.join(' | '));
  const ok = await loadDrawing({ isElectron: false }, 'a.dxf', new TextEncoder().encode(tableDrawing()), { path: null });
  assert.ok(!ok.notes.some((n) => /table/.test(n)));
});
