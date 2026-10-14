import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import * as M from '../src/core/model.js';
import { newLayout } from '../src/core/layouts.js';
import { exportPdf } from '../src/core/exportPdf.js';
import { Session, renameLayer, layerRenameError } from '../src/core/edit.js';

/** model space and tables only (the sample's bare layout is not a full layout record) */
const modelOnly = (doc) => { delete doc.layouts; return doc; };
const roundTrip = (doc) => readDxf(new TextEncoder().encode(writeDxf(modelOnly(doc))));

/** model line + INSERT with an attribute on WALLS, a block piece on WALLS, a paper line and a viewport freezing WALLS */
function sample() {
  const doc = M.newDocument();
  M.addLayer(doc, { name: 'Walls', color: 3, plot: false });
  M.addLayer(doc, { name: 'Doors', color: 1 });
  M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 1, y: 1 }, { layer: 'Walls' }));
  M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 2, y: 1 }, { layer: 'Doors' }));
  M.addBlock(doc, 'B', { x: 0, y: 0 }, [{ ...M.makeLine({ x: 0, y: 0 }, { x: 1, y: 0 }, { layer: 'WALLS' }), id: 900 }]);
  const ins = M.addEntity(doc, M.makeInsert('B', { x: 5, y: 5 }, { layer: 'Doors' }));
  ins.attribs = [{ ...M.makeText({ x: 5, y: 5 }, 1, 'x', { layer: 'Walls' }), attrib: { tag: 'T', flags: 0 } }];
  const lay = newLayout('Layout1', 1);
  lay.entities.push({ ...M.makeLine({ x: 0, y: 0 }, { x: 9, y: 9 }, { layer: 'Walls' }), id: 901 },
    { type: 'VIEWPORT', id: 902, layer: '0', color: 256, vpId: 2, on: true, c: { x: 200, y: 150 }, width: 200, height: 100, viewCenter: { x: 0, y: 0 }, viewHeight: 100, twist: 0, frozen: ['WALLS', 'Doors'] });
  doc.layouts = [lay];
  return doc;
}
const onLayer = (doc, n) => [doc.entities, ...doc.layouts.map((l) => l.entities), ...[...doc.blocks.values()].map((b) => b.entities)]
  .flat().flatMap((e) => [e, ...(e.attribs ?? [])]).filter((e) => e.layer === n).length;

test('rename: entities in model, layouts, blocks and attributes, viewport frozen lists and the current layer follow; one undo step', () => {
  const doc = sample(), s = new Session(doc), cur = { layer: 'Walls' };
  const vp = doc.layouts[0].entities.find((e) => e.type === 'VIEWPORT');
  const steps = s.undoStack.length;
  assert.equal(renameLayer(s, 'Walls', 'A-WALL', { current: cur }), true);
  assert.equal(s.undoStack.length, steps + 1, 'one undo step');
  assert.ok(!doc.layers.has('Walls') && doc.layers.get('A-WALL'));
  assert.equal(doc.layers.get('A-WALL').name, 'A-WALL');
  assert.equal(doc.layers.get('A-WALL').color, 3, 'properties kept');
  assert.equal(doc.layers.get('A-WALL').plot, false, 'plot flag kept');
  assert.equal(onLayer(doc, 'A-WALL'), 4, 'model line, block piece (WALLS, any case), attribute, paper line');
  assert.equal(onLayer(doc, 'Walls') + onLayer(doc, 'WALLS'), 0);
  assert.deepEqual(vp.frozen, ['A-WALL', 'Doors']);
  assert.equal(cur.layer, 'A-WALL');
  s.undo();
  assert.ok(doc.layers.has('Walls') && !doc.layers.has('A-WALL'));
  assert.equal(onLayer(doc, 'Walls'), 3);
  assert.equal(onLayer(doc, 'WALLS'), 1);
  assert.deepEqual(vp.frozen, ['WALLS', 'Doors']);
  assert.equal(cur.layer, 'Walls');
  s.redo();
  assert.equal(onLayer(doc, 'A-WALL'), 4);
  assert.equal(cur.layer, 'A-WALL');
});

test('rename: a case-only change of the same layer is allowed; renaming survives a DXF round trip', () => {
  const doc = sample(), s = new Session(doc);
  renameLayer(s, 'Walls', 'WALLS');
  assert.ok(doc.layers.has('WALLS') && !doc.layers.has('Walls'));
  const back = roundTrip(doc);
  assert.ok(back.layers.has('WALLS'));
  assert.equal(back.entities.filter((e) => e.layer === 'WALLS').length, 1);
});

test('rename: invalid names are rejected and nothing changes', () => {
  const doc = sample(), s = new Session(doc);
  M.addLayer(doc, { name: 'X|REF', xrefDep: 'X' });
  for (const bad of ['', '  ', 'a<b', 'a>b', 'a/b', 'a\\b', 'a"b', 'a:b', 'a;b', 'a?b', 'a*b', 'a|b', 'a,b', 'a=b', 'a`b', ' lead', 'doors', 'DOORS']) {
    assert.ok(layerRenameError(doc, 'Walls', bad), `"${bad}" rejected`);
    assert.throws(() => renameLayer(s, 'Walls', bad));
  }
  assert.match(layerRenameError(doc, '0', 'Zero'), /Layer 0/);
  assert.match(layerRenameError(doc, 'X|REF', 'Y'), /Xref/);
  assert.equal(layerRenameError(doc, 'Walls', 'A-WALL 2'), '');
  assert.equal(s.undoStack.length, 0);
  assert.ok(doc.layers.has('Walls'));
});

test('plot flag: DXF group 290 is read and written; default plottable', () => {
  const back = roundTrip(sample());
  assert.equal(back.layers.get('Walls').plot, false);
  assert.equal(back.layers.get('Doors').plot, true);
  const lines = writeDxf(modelOnly(sample())).split(/\r?\n/).map((x) => x.trim());
  const rec = (name) => { const out = new Map(); for (let i = lines.indexOf(name) + 1; i + 1 < lines.length && lines[i] !== '0'; i += 2) out.set(lines[i], lines[i + 1]); return out; };
  assert.equal(rec('Walls').get('290'), '0', 'non-plotting: 290 0');
  assert.ok(!rec('Doors').has('290'), 'plottable: no 290 (default 1)');
});

async function pdfText(doc, opts) {
  const pdf = await PDFDocument.load((await exportPdf(doc, opts)).bytes), c = pdf.getPage(0).node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
  return streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode())).join('\n');
}
const GREEN = /\b0 1 0 RG/, RED = /\b1 0 0 RG/;

test('plot flag: objects on a non-plotting layer are left out of the PDF (model and layout viewports)', async () => {
  const doc = M.newDocument();
  M.addLayer(doc, { name: 'NP', color: 3, plot: false });
  M.addLayer(doc, { name: 'P', color: 1 });
  M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }, { layer: 'NP' }));
  M.addEntity(doc, M.makeLine({ x: 0, y: 5 }, { x: 10, y: 5 }, { layer: 'P' }));
  let t = await pdfText(doc);
  assert.match(t, RED);
  assert.doesNotMatch(t, GREEN);
  const lay = newLayout('Layout1', 1);
  lay.entities.push({ type: 'VIEWPORT', id: 99, layer: '0', color: 256, vpId: 2, on: true, c: { x: 200, y: 150 }, width: 200, height: 100, viewCenter: { x: 5, y: 2 }, viewHeight: 20, twist: 0 },
    { ...M.makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }, { layer: 'NP' }), id: 98 });
  doc.layouts = [lay];
  t = await pdfText(doc, { layout: lay });
  assert.match(t, RED);
  assert.doesNotMatch(t, GREEN);
  doc.layers.get('NP').plot = true;
  assert.match(await pdfText(doc), GREEN, 'plots once the flag is back on');
});

test('rename is case-exact: Walls -> A-WALL leaves a separate "walls" layer and its objects alone', () => {
  const doc = M.newDocument();
  M.addLayer(doc, { name: 'Walls', color: 3 });
  M.addLayer(doc, { name: 'walls', color: 4 });
  M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 1, y: 1 }, { layer: 'Walls' }));
  M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 2, y: 1 }, { layer: 'walls' }));
  const s = new Session(doc), cur = { layer: 'walls' };
  assert.equal(renameLayer(s, 'Walls', 'A-WALL', { current: cur }), true);
  assert.deepEqual(doc.entities.map((e) => e.layer), ['A-WALL', 'walls']);
  assert.ok(doc.layers.has('walls') && doc.layers.has('A-WALL') && !doc.layers.has('Walls'));
  assert.equal(cur.layer, 'walls', 'the current layer "walls" is a different layer');
});
