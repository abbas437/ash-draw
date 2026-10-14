import test from 'node:test';
import assert from 'node:assert/strict';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { newDocument } from '../src/core/model.js';
import { newLayout } from '../src/core/layouts.js';
import { Session } from '../src/core/edit.js';
import { saveView, deleteView, renameView, restoreView, findView, viewsIn, viewsOf, viewFromScreen, restorable, viewBox } from '../src/core/views.js';

const bytes = (s) => new TextEncoder().encode(s);
const asText = (out) => (typeof out === 'string' ? out : new TextDecoder().decode(out));
/** a synthetic drawing with a VIEW table: a plan view, a twisted plan view with a target, a 3D view, a paper-space view */
const dxf = () => {
  const rec = (name, f) => ['0', 'VIEW', '2', name, '70', String(f.flags ?? 0), '40', String(f.h), '10', String(f.cx), '20', String(f.cy), '41', String(f.w),
    '11', String(f.dir?.[0] ?? 0), '21', String(f.dir?.[1] ?? 0), '31', String(f.dir?.[2] ?? 1), '12', String(f.t?.[0] ?? 0), '22', String(f.t?.[1] ?? 0), '32', '0',
    '42', '50', '43', '0', '44', '0', '50', String(f.tw ?? 0), '71', '0'];
  return ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'VIEW', '70', '4',
    ...rec('Plant room', { h: 40, w: 60, cx: 100, cy: 50 }),
    ...rec('Twisted', { h: 10, w: 20, cx: 5, cy: 0, t: [1000, 2000], tw: 90 }),
    ...rec('Iso', { h: 30, w: 30, cx: 0, cy: 0, dir: [1, -1, 1] }),
    ...rec('Sheet', { h: 200, w: 300, cx: 150, cy: 100, flags: 1 }),
    '0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '200', '21', '100', '31', '0', '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
};
const strip = (m, raw = true) => [...m.values()].map((v) => JSON.parse(JSON.stringify(raw ? v : { ...v, dxf: undefined }))).sort((a, b) => a.name.localeCompare(b.name));

test('save, restore and delete a named view, each save and delete one undo step', () => {
  const s = new Session(newDocument());
  const v = saveView(s, viewFromScreen('Level 1 AHU', { cx: 10, cy: 20, zoom: 2, width: 800, height: 600 }));
  assert.deepEqual([v.width, v.height, v.center], [400, 300, { x: 10, y: 20 }]);
  assert.equal(s.undoStack.length, 1);
  assert.equal(findView(s.doc, 'level 1 ahu').name, 'Level 1 AHU', 'names are found case-blind');
  const r = restoreView(s.doc, 'LEVEL 1 AHU', 1600, 600);
  assert.deepEqual(r, { cx: 10, cy: 20, zoom: 2 }, 'the whole view fits the canvas: height governs');
  assert.equal(s.undoStack.length, 1, 'restoring is not an undo step');
  assert.ok(deleteView(s, 'level 1 ahu'));
  assert.equal(s.undoStack.length, 2);
  assert.equal(findView(s.doc, 'Level 1 AHU'), null);
  s.undo();
  assert.equal(findView(s.doc, 'Level 1 AHU').width, 400, 'undo of delete brings it back');
  s.undo();
  assert.equal(findView(s.doc, 'Level 1 AHU'), null, 'undo of save removes it');
  s.redo();
  assert.ok(findView(s.doc, 'Level 1 AHU'), 'redo saves it again');
  assert.equal(deleteView(s, 'nothing'), false);
  assert.equal(restoreView(s.doc, 'nothing', 100, 100), null);
});

test('saving a named view does not ask for a scene rebuild; replacing one is a single step', () => {
  const s = new Session(newDocument()), seen = [];
  s.onChange = (info) => seen.push(info.structure);
  saveView(s, { name: 'A', center: { x: 0, y: 0 }, width: 10, height: 10 });
  saveView(s, { name: 'a', center: { x: 5, y: 5 }, width: 10, height: 10 });
  assert.equal(viewsOf(s.doc).size, 1, 'same name, other case: replaced');
  assert.equal(findView(s.doc, 'A').name, 'a');
  s.undo();
  assert.deepEqual(findView(s.doc, 'A').center, { x: 0, y: 0 });
  assert.deepEqual(seen, [false, false, false]);
});

test('rename a named view, refusing bad and taken names', () => {
  const s = new Session(newDocument());
  saveView(s, { name: 'One', center: { x: 0, y: 0 }, width: 1, height: 1 });
  saveView(s, { name: 'Two', center: { x: 0, y: 0 }, width: 1, height: 1 });
  assert.throws(() => renameView(s, 'One', 'two'), /already exists/);
  assert.throws(() => renameView(s, 'One', 'a/b'), /not a valid/);
  assert.throws(() => saveView(s, { name: '', center: { x: 0, y: 0 }, width: 1, height: 1 }), /not a valid/);
  renameView(s, 'One', 'Plant room');
  assert.deepEqual(viewsIn(s.doc, 'model').map((v) => v.name), ['Plant room', 'Two']);
  renameView(s, 'plant room', 'Plant Room'); // case change of the same view
  assert.equal(findView(s.doc, 'PLANT ROOM').name, 'Plant Room');
  s.undo(); s.undo();
  assert.deepEqual(viewsIn(s.doc, 'model').map((v) => v.name), ['One', 'Two']);
});

test('VIEW table: read -> write -> read keeps every view', () => {
  const doc = readDxf(bytes(dxf()));
  const views = doc.views;
  assert.equal(views.size, 4);
  const p = views.get('PLANT ROOM');
  assert.deepEqual([p.center, p.width, p.height, p.space], [{ x: 100, y: 50 }, 60, 40, 'model']);
  const t = views.get('TWISTED');
  assert.ok(Math.abs(t.center.x - 1000) < 1e-9 && Math.abs(t.center.y - 1995) < 1e-9, `twisted centre in world ${JSON.stringify(t.center)}`);
  assert.equal(views.get('SHEET').space, 'Layout1', 'a paper-space view without a layout name goes to the first layout');
  const out = asText(writeDxf(doc));
  assert.match(out, /AcDbViewTableRecord/);
  const back = readDxf(bytes(out));
  assert.deepEqual(strip(back.views), strip(views));
  // a view saved in the program round-trips too, with its layout
  const s = new Session(back);
  saveView(s, { name: 'Title block', center: { x: 1, y: 2 }, width: 3, height: 4, space: 'Layout1' });
  const again = readDxf(bytes(asText(writeDxf(back))));
  assert.deepEqual(strip(again.views, false), strip(back.views, false)); // a view made here gains its DXF fields on reading
  assert.equal(again.views.get('TITLE BLOCK').space, 'Layout1');
});

test('a 3D view is kept on save but cannot be restored', () => {
  const doc = readDxf(bytes(dxf()));
  const iso = doc.views.get('ISO');
  assert.equal(restorable(iso), false);
  assert.equal(restoreView(doc, 'Iso', 100, 100), null);
  assert.equal(restorable(doc.views.get('PLANT ROOM')), true);
  const again = readDxf(bytes(asText(writeDxf(doc))));
  assert.deepEqual(again.views.get('ISO').dxf.dir, { x: 1, y: -1, z: 1 });
  assert.deepEqual(viewBox(doc.views.get('PLANT ROOM')), { minx: 70, maxx: 130, miny: 30, maxy: 70 });
});

test('a view on a layout with a non-ASCII name (written as \\U+XXXX) keeps its layout and name', () => {
  const doc = newDocument();
  doc.layouts = [newLayout('Café', 1)];
  const s = new Session(doc);
  saveView(s, { name: 'Façade', center: { x: 1, y: 2 }, width: 3, height: 4, space: 'Café' });
  const out = asText(writeDxf(doc));
  assert.match(out, /Caf\\U\+00E9/);
  const back = readDxf(bytes(out));
  assert.deepEqual(back.layouts.map((l) => l.name), ['Café']);
  const v = findView(back, 'Façade');
  assert.equal(v?.name, 'Façade');
  assert.equal(v.space, 'Café');
  assert.deepEqual(viewsIn(back, 'Café').map((x) => x.name), ['Façade']);
});
