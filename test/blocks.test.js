import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { newDocument, addEntity, addBlock, makeLine, makeRect } from '../src/core/model.js';
import { bboxOf, explode } from '../src/core/geom.js';
import { buildScene } from '../src/core/render.js';
import { makeBlock, instantiate, makeAttdef, blockNameError, withAttribValues } from '../src/core/blocks.js';
import { Session } from '../src/core/edit.js';
import { ezdxfAvailable, validateWithEzdxf } from './helpers.js';

const dxf = (pairs) => pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n';
const attdef = (tag, prompt, def, x, y, flags = 0) => [[0, 'ATTDEF'], [8, '0'], [100, 'AcDbText'], [10, x], [20, y], [40, 2.5], [1, def],
  [100, 'AcDbAttributeDefinition'], [3, prompt], [2, tag], [70, flags]];
const attrib = (tag, val, x, y, flags = 0) => [[0, 'ATTRIB'], [8, '0'], [100, 'AcDbText'], [10, x], [20, y], [40, 2.5], [1, val],
  [100, 'AcDbAttribute'], [2, tag], [70, flags]];
const SRC = dxf([
  [0, 'SECTION'], [2, 'BLOCKS'],
  [0, 'BLOCK'], [8, '0'], [2, 'TAGBOX'], [70, 2], [10, 0], [20, 0],
  [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 10], [21, 0],
  ...attdef('NAME', 'Equipment name', 'AHU', 1, 1), ...attdef('RATING', 'Rating', '5 kW', 1, 5, 1),
  [0, 'ENDBLK'],
  [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'ENTITIES'],
  [0, 'INSERT'], [8, 'EQ'], [66, 1], [2, 'TAGBOX'], [10, 100], [20, 50],
  ...attrib('NAME', 'AHU-01', 101, 51), ...attrib('RATING', '12 kW', 101, 55, 1),
  [0, 'SEQEND'], [8, 'EQ'],
  [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 1],
  [0, 'ENDSEC'], [0, 'EOF'],
]);

test('ATTDEFs are read into the block and ATTRIBs are linked to their INSERT, not loose TEXT', () => {
  const doc = parseDxf(SRC);
  const defs = doc.blocks.get('TAGBOX').entities.filter((e) => e.attdef);
  assert.deepEqual(defs.map((d) => [d.attdef.tag, d.attdef.prompt, d.attdef.default, d.attdef.flags]),
    [['NAME', 'Equipment name', 'AHU', 0], ['RATING', 'Rating', '5 kW', 1]]);
  assert.deepEqual(doc.entities.map((e) => e.type), ['INSERT', 'LINE']);
  const ins = doc.entities[0];
  assert.deepEqual(ins.attribs.map((a) => [a.attrib.tag, a.text, a.attrib.flags, a.p.x, a.p.y]),
    [['NAME', 'AHU-01', 0, 101, 51], ['RATING', '12 kW', 1, 101, 55]]);
  // rendering: the visible attribute value is drawn with the insert; the invisible one and the ATTDEF tags are not
  const texts = buildScene(doc).items.filter((it) => it.kind === 'text').map((it) => it.lines.join());
  assert.deepEqual(texts, ['AHU-01']);
});

test('INSERT attributes round-trip through writeDxf -> parseDxf and are valid for ezdxf', { skip: !ezdxfAvailable() && 'ezdxf not installed' }, (t) => {
  const out = writeDxf(parseDxf(SRC));
  const back = parseDxf(out);
  const ins = back.entities.find((e) => e.type === 'INSERT');
  assert.deepEqual(ins.attribs.map((a) => [a.attrib.tag, a.text]), [['NAME', 'AHU-01'], ['RATING', '12 kW']]);
  assert.deepEqual(back.blocks.get('TAGBOX').entities.filter((e) => e.attdef).map((d) => d.attdef.default), ['AHU', '5 kW']);
  const dir = mkdtempSync(path.join(tmpdir(), 'ashblocks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'blocks.dxf');
  writeFileSync(file, out);
  const audit = validateWithEzdxf(file);
  assert.equal(audit.audit_errors, 0, JSON.stringify(audit.audit_messages));
  const py = 'import ezdxf, json, sys\ndoc = ezdxf.readfile(sys.argv[1])\n'
    + 'print(json.dumps([[a.dxf.tag, a.dxf.text] for i in doc.modelspace().query("INSERT") for a in i.attribs]))\n'
    + 'print(json.dumps([[a.dxf.tag, a.dxf.prompt, a.dxf.text] for a in doc.blocks.get("TAGBOX").query("ATTDEF")]))';
  const r = spawnSync(ezdxfAvailable(), ['-c', py, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [attribs, defs] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(attribs, [['NAME', 'AHU-01'], ['RATING', '12 kW']]);
  assert.deepEqual(defs, [['NAME', 'Equipment name', 'AHU'], ['RATING', 'Rating', '5 kW']]);
});

test('makeBlock translates the definition by -base; instantiate with scale 2 rotation 90 places the block', () => {
  const doc = newDocument();
  const ents = [makeLine({ x: 10, y: 10 }, { x: 14, y: 10 }), makeRect({ x: 10, y: 10 }, { x: 14, y: 12 }), makeAttdef({ x: 11, y: 11 }, 1, 'tag1', { default: 'X' })]
    .map((e) => addEntity(doc, e));
  const { block, insert } = makeBlock(doc, 'BOX', ents, { x: 10, y: 10 });
  assert.deepEqual(block.base, { x: 0, y: 0 });
  assert.deepEqual([block.entities[0].p1, block.entities[0].p2], [{ x: 0, y: 0 }, { x: 4, y: 0 }]);
  assert.deepEqual(block.entities[1].vertices.map((v) => [v.x, v.y]), [[0, 0], [4, 0], [4, 2], [0, 2]]);
  assert.deepEqual(block.entities[2].p, { x: 1, y: 1 });
  assert.equal(block.entities[2].attdef.tag, 'TAG1');
  assert.deepEqual([insert.p, insert.attribs[0].text, insert.attribs[0].p], [{ x: 10, y: 10 }, 'X', { x: 11, y: 11 }]);
  assert.match(blockNameError(doc, 'a<b'), /cannot contain/);
  addBlock(doc, block.name, block.base, block.entities);
  assert.match(blockNameError(doc, 'box'), /already exists/);
  // scale 2, rotation 90 at (100, 0): the 4 x 2 rectangle becomes x 96..100, y 0..8
  const ins = instantiate(block, { x: 100, y: 0 }, { sx: 2, rot: 90, values: { TAG1: 'A' } });
  const rect = explode(ins, doc).find((e) => e.type === 'LWPOLYLINE');
  const b = bboxOf(rect, doc);
  for (const [k, v] of Object.entries({ minx: 96, miny: 0, maxx: 100, maxy: 8 })) assert.ok(Math.abs(b[k] - v) < 1e-9, `${k} ${b[k]}`);
  const a = ins.attribs[0];
  assert.equal(a.text, 'A');
  assert.ok(Math.abs(a.p.x - 98) < 1e-9 && Math.abs(a.p.y - 2) < 1e-9 && Math.abs(a.rot - 90) < 1e-9 && a.height === 2, JSON.stringify(a));
  assert.equal(withAttribValues(ins, { TAG1: 'C' }).attribs[0].text, 'C');
  assert.equal(ins.attribs[0].text, 'A');
});

test('a block definition is one undo step with the entities it replaces', () => {
  const doc = newDocument();
  const s = new Session(doc);
  const e = addEntity(doc, makeLine({ x: 0, y: 0 }, { x: 1, y: 0 }));
  const { block, insert } = makeBlock(doc, 'B1', [e], { x: 0, y: 0 });
  s.transact('Block', (tx) => { tx.block(block.name, block); tx.remove([e.id]); tx.add(insert); });
  assert.ok(doc.blocks.has('B1'));
  s.undo();
  assert.ok(!doc.blocks.has('B1'));
  assert.deepEqual(doc.entities.map((x) => x.type), ['LINE']);
  s.redo();
  assert.deepEqual([doc.blocks.has('B1'), doc.entities.map((x) => x.type)], [true, ['INSERT']]);
});
