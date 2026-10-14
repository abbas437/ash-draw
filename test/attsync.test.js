import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addEntity, addBlock, makeLine } from '../src/core/model.js';
import { makeAttdef, instantiate, syncAttribs, attSync, blocksWithAttdefs } from '../src/core/blocks.js';
import { Session } from '../src/core/edit.js';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';

/** TAG block: a line, NAME and TYPE attributes; NEST block holds one TAG insert; model space holds one TAG and one NEST */
function setup() {
  const doc = newDocument();
  const tag = { name: 'TAG', base: { x: 0, y: 0 }, entities: [makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }), makeAttdef({ x: 1, y: 1 }, 2, 'NAME', { default: 'N?' }), makeAttdef({ x: 1, y: 4 }, 2, 'TYPE', { default: 'T?' })] };
  doc.blocks.set('TAG', tag);
  const top = addEntity(doc, instantiate(tag, { x: 100, y: 50 }, { sx: 2, rot: 90, values: { NAME: 'AHU-1', TYPE: 'supply' } }));
  addBlock(doc, 'NEST', { x: 0, y: 0 }, [instantiate(tag, { x: 5, y: 5 }, { values: { NAME: 'inner' } })]);
  addEntity(doc, instantiate(doc.blocks.get('NEST'), { x: 0, y: 0 }));
  return { doc, tag, top };
}
/** the definition after an edit: TYPE removed, SIZE added, NAME moved and taller */
function redefine(doc) {
  const tag = doc.blocks.get('TAG');
  tag.entities = [tag.entities[0], makeAttdef({ x: 3, y: 2 }, 3, 'NAME', { default: 'N?' }), makeAttdef({ x: 1, y: 7 }, 2, 'SIZE', { default: '300x200' })];
}
const vals = (ins) => Object.fromEntries(ins.attribs.map((a) => [a.attrib.tag, a.text]));

test('syncAttribs adds missing tags with defaults, removes undefined tags, keeps values', () => {
  const { doc, top } = setup();
  redefine(doc);
  const c = syncAttribs(doc.entities.find((e) => e.id === top.id), doc.blocks.get('TAG'));
  assert.deepEqual(vals(c), { NAME: 'AHU-1', SIZE: '300x200' });
});

test('syncAttribs reapplies placement and height through the insert transform (scale 2, rotation 90)', () => {
  const { doc, top } = setup();
  redefine(doc);
  const c = syncAttribs(top, doc.blocks.get('TAG'));
  const name = c.attribs.find((a) => a.attrib.tag === 'NAME');
  assert.ok(Math.abs(name.p.x - (100 - 4)) < 1e-9 && Math.abs(name.p.y - (50 + 6)) < 1e-9, JSON.stringify(name.p));
  assert.ok(Math.abs(name.height - 6) < 1e-9, `height ${name.height}`);
  assert.ok(Math.abs(name.rot - 90) < 1e-9, `rotation ${name.rot}`);
  assert.equal(syncAttribs(c, doc.blocks.get('TAG')), null, 'an insert already in sync is unchanged');
});

test('attSync updates model space and nested inserts in one undo step', () => {
  const { doc, top } = setup();
  const s = new Session(doc);
  redefine(doc);
  const nestBefore = doc.blocks.get('NEST');
  assert.equal(attSync(s, 'TAG'), 2);
  assert.equal(s.undoStack.length, 1, 'one undo step');
  assert.deepEqual(vals(doc.entities.find((e) => e.id === top.id)), { NAME: 'AHU-1', SIZE: '300x200' });
  assert.deepEqual(vals(doc.blocks.get('NEST').entities[0]), { NAME: 'inner', SIZE: '300x200' });
  s.undo();
  assert.deepEqual(vals(doc.entities.find((e) => e.id === top.id)), { NAME: 'AHU-1', TYPE: 'supply' });
  assert.equal(doc.blocks.get('NEST'), nestBefore, 'undo restores the nested block');
  s.redo();
  assert.deepEqual(vals(doc.blocks.get('NEST').entities[0]), { NAME: 'inner', SIZE: '300x200' });
});

test('attSync reaches layout (paper space) inserts and lists blocks with attributes', () => {
  const { doc } = setup();
  const lay = { name: 'Layout1', entities: [instantiate(doc.blocks.get('TAG'), { x: 1, y: 1 }, { values: { NAME: 'paper' } })] };
  doc.layouts = [lay];
  const s = new Session(doc);
  redefine(doc);
  assert.equal(attSync(s, 'TAG'), 3);
  assert.deepEqual(vals(lay.entities[0]), { NAME: 'paper', SIZE: '300x200' });
  assert.deepEqual(blocksWithAttdefs(doc), ['TAG']);
  s.undo();
  assert.deepEqual(vals(lay.entities[0]), { NAME: 'paper', TYPE: 'T?' });
});

test('attSync: inserts read from DXF that already match their definition are not counted', () => {
  const { doc } = setup();
  // ATTRIBs as AutoCAD writes them: width, oblique, justification codes and an alignment point, 16-digit coordinates
  const text = writeDxf(doc).replace('AcDbText\r\n10\r\n98\r\n', 'AcDbText\r\n10\r\n97.99999999999999\r\n')
    .replaceAll('\r\n7\r\nSTANDARD\r\n100\r\nAcDbAttribute\r\n', '\r\n7\r\nSTANDARD\r\n41\r\n1.0\r\n51\r\n0.0\r\n71\r\n0\r\n72\r\n0\r\n11\r\n0.0\r\n21\r\n0.0\r\n31\r\n0.0\r\n100\r\nAcDbAttribute\r\n');
  assert.ok(text.includes('97.99999999999999') && text.includes('51\r\n0.0'));
  const back = readDxf(new TextEncoder().encode(text));
  assert.equal(attSync(new Session(back), 'TAG'), 0);
});
