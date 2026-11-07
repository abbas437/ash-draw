// ACAD_TABLE (equipment schedules, legends, title blocks): read as a reference to its graphics block (*Tn), so it
// draws, selects and explodes like an INSERT, and written back as the table it was read as (dxfRead buildTable,
// dxfWrite tableTags).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDxf } from '../src/core/dxfRead.js';
import { writeDxf, unkeptObjects } from '../src/core/dxfWrite.js';
import { bboxOf, docExtents, explode, transformEntity } from '../src/core/geom.js';
import { ezdxfAvailable } from './helpers.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

/** a one-cell table at (100, 50) on layer SCHED; its block *T1 holds the cell border (a LINE) and the cell text */
function tableDrawing({ placement = [] } = {}) {
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
    '100', 'AcDbTable', '280', '0', '342', '4F', '343', '41', '11', '1.0', '21', '0.0', '31', '0.0',
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

test('write: an unmodified table is written back as the ACAD_TABLE it was, its tags as read', () => {
  const doc = parseDxf(tableDrawing());
  const text = writeDxf(doc);
  assert.deepEqual(unkeptObjects(doc), {}); assert.deepEqual(doc.lastWriteReport.skipped, {});
  assert.deepEqual(doc.lastWriteReport.notes, []);
  const [tags] = records(text, 'ACAD_TABLE');
  assert.ok(tags, 'an ACAD_TABLE is written');
  assert.equal(records(text, 'INSERT').length, 0);
  // 343 names *T1's block record in the new file; the style (342) and cell field (344) handles are null there
  const blk = text.split('\r\n'), at = blk.findIndex((v, i) => v === '*T1' && blk[i - 1].trim() === '2' && blk[i - 2] === 'AcDbBlockTableRecord');
  assert.ok(at > 0, '*T1 block record');
  const recH = blk.slice(0, at).lastIndexOf('BLOCK_RECORD');
  const hRec = blk[recH + 2];
  const expect = own(records(tableDrawing(), 'ACAD_TABLE')[0]).map(([c, v]) => [c, c === 343 ? hRec : c === 342 ? '0' : v]);
  assert.deepEqual(own(tags), expect);
  assert.ok(/\r\nCLASS\r\n1\r\nACAD_TABLE\r\n2\r\nAcDbTable\r\n/.test(text), 'the ACAD_TABLE class is declared');
  // and it reads back as the same table
  const [again] = tables(parseDxf(text));
  assert.equal(again.block, '*T1'); near(again.p.x, 100, 'x');
  assert.deepEqual(parseDxf(text).blocks.get('*T1').entities.map((e) => e.type), ['LINE', 'TEXT'], 'the *T block is kept');
});

test('write: a moved table changes only its position codes; a turned one its direction', () => {
  const doc = parseDxf(tableDrawing());
  const before = own(records(writeDxf(doc), 'ACAD_TABLE')[0]);
  doc.entities = [transformEntity(doc.entities[0], [1, 0, 0, 1, 5, -7])];
  const moved = own(records(writeDxf(doc), 'ACAD_TABLE')[0]);
  assert.equal(moved.length, before.length);
  const diff = moved.map((t, i) => [t, before[i]]).filter(([a, b]) => a[1] !== b[1]);
  assert.deepEqual(diff.map(([a]) => a[0]), [10, 20]);
  near(+diff[0][0][1], 105, 'x'); near(+diff[1][0][1], 43, 'y');
  const [back] = tables(parseDxf(writeDxf(doc)));
  near(back.p.x, 105, 're-read x'); near(back.p.y, 43, 're-read y');

  const c = Math.SQRT1_2;
  doc.entities = [transformEntity(doc.entities[0], [c, c, -c, c, 0, 0])]; // 45 degrees about the origin
  const turned = parseDxf(writeDxf(doc));
  const [r] = tables(turned);
  near(r.rot, 45, 'rotation kept through the 11 direction');
  const tags = own(records(writeDxf(doc), 'ACAD_TABLE')[0]);
  assert.ok(!tags.some(([k]) => k === 50), 'no 50 added when the table has a direction');
  near(+tags.find(([k]) => k === 11)[1], c, '11'); near(+tags.find(([k]) => k === 21)[1], c, '21');
});

test('write: an exploded table is written as its block entities; a copy and a LibreDWG save as plain references', () => {
  const doc = parseDxf(tableDrawing());
  const t = doc.entities[0];
  doc.entities = explode(t, doc);
  const text = writeDxf(doc);
  assert.equal(records(text, 'ACAD_TABLE').length, 0);
  assert.deepEqual([records(text, 'LINE').length, records(text, 'TEXT').length], [1, 1]);

  doc.entities = [t, transformEntity(t, [1, 0, 0, 1, 0, -20])];
  const two = writeDxf(doc);
  assert.deepEqual([records(two, 'ACAD_TABLE').length, records(two, 'INSERT').length], [1, 1], 'two tables cannot share one block');
  assert.equal(doc.lastWriteReport.notes.length, 1);

  doc.entities = [t];
  assert.deepEqual(unkeptObjects(doc, { dimensionsAsGeometry: true }), {});
  const dwg = writeDxf(doc, { dimensionsAsGeometry: true });
  assert.deepEqual([records(dwg, 'ACAD_TABLE').length, records(dwg, 'INSERT').length], [0, 1], 'DWG through LibreDWG');
  assert.match(doc.lastWriteReport.notes.join(' '), /Tables are saved as plain geometry/);
  assert.equal(records(writeDxf(doc, { mleadersAsGeometry: true }), 'ACAD_TABLE').length, 1, 'DWG through ODA keeps the table');
});

test('ezdxf audits the written table cleanly and reads it as an ACAD_TABLE with its block', (t) => {
  const py = ezdxfAvailable();
  if (!py) { t.skip('ezdxf not installed'); return; }
  const dir = mkdtempSync(path.join(tmpdir(), 'ash-table-'));
  try {
    const f = path.join(dir, 'table.dxf');
    writeFileSync(f, writeDxf(parseDxf(tableDrawing())));
    const r = spawnSync(py, ['-c', `import ezdxf,sys
d=ezdxf.readfile(sys.argv[1]); a=d.audit()
ts=[e for e in d.modelspace() if e.dxftype()=='ACAD_TABLE']
print(len(a.errors), len(ts), ts[0].dxf.geometry if ts else '-', sorted(e.dxftype() for e in d.blocks.get('*T1')))`, f], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), "0 1 *T1 ['LINE', 'TEXT']", r.stderr);
  } finally { rmSync(dir, { recursive: true }); }
});
