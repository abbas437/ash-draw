// Layout management (LAYOUT command, layout tab menu): new, copy, rename, delete, tab order; one undo step each; DXF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument } from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import { makeViewport, STANDARD_SCALES, viewportPrintScale, viewHeightForScale } from '../src/core/layouts.js';
import { saveView, findView } from '../src/core/views.js';
import { addLayout, copyLayout, renameLayout, deleteLayout, moveLayout, setPageSetup, layoutsOf, layoutNameError } from '../src/core/layoutmgmt.js';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';

const names = (s) => layoutsOf(s.doc).map((l) => `${l.tab}:${l.name}`).join(',');
function drawing() {
  const s = new Session(newDocument());
  addLayout(s, 'Layout1');
  const lo = layoutsOf(s.doc)[0];
  s.transact('paper', (tx) => {
    tx.set(lo, 'entities', [
      { type: 'LINE', id: s.doc.nextId++, layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, p1: { x: 10, y: 10 }, p2: { x: 100, y: 10 } },
      { ...makeViewport({ x: 20, y: 20 }, { x: 200, y: 150 }, { minx: 0, miny: 0, maxx: 1000, maxy: 700 }), id: s.doc.nextId++ },
    ]);
  });
  saveView(s, { name: 'Detail', center: { x: 50, y: 50 }, width: 40, height: 30, space: 'Layout1' });
  saveView(s, { name: 'Plan', center: { x: 0, y: 0 }, width: 400, height: 300, space: 'model' });
  return s;
}

test('LAYOUT New adds an A3 layout after the last tab; one undo step', () => {
  const s = drawing(), steps = s.undoStack.length;
  const lo = addLayout(s);
  assert.equal(lo.name, 'Layout2');
  assert.equal(names(s), '1:Layout1,2:Layout2');
  assert.equal(lo.plot.paperW, 420);
  assert.equal(s.undoStack.length, steps + 1);
  s.undo();
  assert.equal(names(s), '1:Layout1');
  s.redo();
  assert.equal(names(s), '1:Layout1,2:Layout2');
});

test('layout names: unique ignoring case, no reserved characters, not Model', () => {
  const s = drawing();
  assert.match(layoutNameError(s.doc, 'layout1'), /already exists/);
  for (const bad of ['', 'A<B', 'a/b', 'x=1', 'q?', 'Model']) assert.ok(layoutNameError(s.doc, bad), bad);
  assert.equal(layoutNameError(s.doc, 'Sheet A-101'), null);
  assert.throws(() => addLayout(s, 'LAYOUT1'), /already exists/);
});

test('LAYOUT Copy deep-copies paper entities and viewports with new ids, after the source; one undo step', () => {
  const s = drawing(), src = layoutsOf(s.doc)[0], steps = s.undoStack.length;
  addLayout(s, 'Last');
  const c = copyLayout(s, 'Layout1');
  assert.equal(c.name, 'Layout1 (2)');
  assert.equal(names(s), '1:Layout1,2:Layout1 (2),3:Last');
  assert.equal(c.entities.length, 2);
  const ids = new Set(src.entities.map((e) => e.id));
  for (const e of c.entities) assert.ok(!ids.has(e.id), 'new id');
  assert.notEqual(c.entities[1], src.entities[1]);
  c.entities[1].c.x = 999; c.plot.margins.l = 99;
  assert.equal(src.entities[1].c.x, 110, 'deep copy');
  assert.notEqual(src.plot.margins.l, 99);
  assert.equal(s.undoStack.length, steps + 2);
  s.undo();
  assert.equal(names(s), '1:Layout1,2:Last');
});

test('LAYOUT Rename renames the layout and moves its named views; one undo step', () => {
  const s = drawing(), steps = s.undoStack.length;
  (s.doc.header ??= {}).activeLayout = 'Layout1';
  renameLayout(s, 'layout1', 'Sheet 1');
  assert.equal(names(s), '1:Sheet 1');
  assert.equal(s.doc.header.activeLayout, 'Sheet 1', 'the layout the file opens on follows the rename');
  assert.equal(findView(s.doc, 'Detail').space, 'Sheet 1');
  assert.equal(findView(s.doc, 'Plan').space, 'model');
  assert.equal(s.undoStack.length, steps + 1);
  s.undo();
  assert.equal(names(s), '1:Layout1');
  assert.equal(s.doc.header.activeLayout, 'Layout1');
  assert.equal(findView(s.doc, 'Detail').space, 'Layout1');
  addLayout(s, 'Other');
  assert.throws(() => renameLayout(s, 'Other', 'LAYOUT1'), /already exists/);
});

test('LAYOUT Delete removes the layout, its paper entities, viewports and views; undo restores all; the last layout stays', () => {
  const s = drawing(), lo = layoutsOf(s.doc)[0], ents = lo.entities.slice();
  assert.throws(() => deleteLayout(s, 'Layout1'), /at least one layout/);
  addLayout(s, 'Two');
  const steps = s.undoStack.length;
  deleteLayout(s, 'Layout1');
  assert.equal(names(s), '1:Two');
  assert.equal(findView(s.doc, 'Detail'), null);
  assert.ok(findView(s.doc, 'Plan'));
  assert.equal(s.undoStack.length, steps + 1);
  s.undo();
  assert.equal(names(s), '1:Layout1,2:Two');
  assert.deepEqual(layoutsOf(s.doc)[0].entities, ents);
  assert.equal(layoutsOf(s.doc)[0].entities[1].type, 'VIEWPORT');
  assert.equal(findView(s.doc, 'Detail').space, 'Layout1');
});

test('Move left / right changes the tab order; one undo step; no move past either end', () => {
  const s = drawing();
  addLayout(s, 'B'); addLayout(s, 'C');
  const steps = s.undoStack.length;
  assert.equal(moveLayout(s, 'C', -1), true);
  assert.equal(names(s), '1:Layout1,2:C,3:B');
  assert.equal(moveLayout(s, 'Layout1', -1), false);
  assert.equal(moveLayout(s, 'B', 1), false);
  assert.equal(s.undoStack.length, steps + 1);
  s.undo();
  assert.equal(names(s), '1:Layout1,2:B,3:C');
});

test('PAGESETUP stores paper, orientation, scale and plot area on the layout; one undo step', () => {
  const s = drawing();
  setPageSetup(s, 'Layout1', { paperName: 'ISO_A1_(841.00_x_594.00_MM)', paperW: 841, paperH: 594, rotation: 1, scaleNum: 1, scaleDen: 2, plotType: 1 });
  const p = layoutsOf(s.doc)[0].plot;
  assert.deepEqual([p.paperW, p.rotation, p.scaleDen, p.plotType, p.margins.l], [841, 1, 2, 1, 7.5]);
  s.undo();
  assert.equal(layoutsOf(s.doc)[0].plot.paperW, 420);
});

test('DXF round trip: 3 layouts after rename, delete and reorder keep names, tab order, entities, views and page setup', () => {
  const s = drawing();
  copyLayout(s, 'Layout1', 'Copy');
  addLayout(s, 'Gone'); addLayout(s, 'Third'); addLayout(s, 'Fourth');
  renameLayout(s, 'Layout1', 'Sheet A');
  deleteLayout(s, 'Gone');
  moveLayout(s, 'Fourth', -1);
  setPageSetup(s, 'Copy', { rotation: 1, scaleNum: 1, scaleDen: 2 });
  assert.equal(names(s), '1:Sheet A,2:Copy,3:Fourth,4:Third');
  deleteLayout(s, 'Third');
  const text = writeDxf(s.doc);
  // one LAYOUT object, one ACAD_LAYOUT entry and one block record per layout (*Paper_Space, *Paper_Space0, *Paper_Space1)
  assert.equal(text.match(/\n\s*0\r?\nLAYOUT\r?\n/g).length, 4);
  for (const b of ['*Paper_Space0', '*Paper_Space1']) assert.ok(text.includes(`\n${b}\n`) || text.includes(`\n${b}\r\n`), b);
  assert.ok(!/\*Paper_Space2\r?\n/.test(text));
  const back = readDxf(new TextEncoder().encode(text));
  assert.deepEqual(back.layouts.map((l) => `${l.tab}:${l.name}`), ['1:Sheet A', '2:Copy', '3:Fourth']);
  assert.deepEqual(back.layouts.map((l) => l.entities.length), [2, 2, 0]);
  assert.equal(back.layouts[1].plot.rotation, 1);
  assert.equal(back.layouts[1].plot.scaleDen, 2);
  assert.equal(findView(back, 'Detail').space, 'Sheet A');
});

test('viewport print scale 1:N is paper mm to model mm: mm, unitless, m and inch layouts; 250 is a standard scale', () => {
  const vp = { height: 100, viewHeight: 5000 }, mm = { units: 1, scaleNum: 1, scaleDen: 1 };
  assert.ok(STANDARD_SCALES.includes(250));
  assert.equal(viewportPrintScale(vp, mm, 4), 50, 'mm drawing on a mm layout');
  assert.equal(viewportPrintScale(vp, mm, 0), 50, 'unitless is taken as mm');
  assert.equal(viewHeightForScale(vp, 50, mm, 6), 5, 'metres: 100 mm of paper at 1:50 shows 5 m');
  assert.equal(viewportPrintScale({ height: 100, viewHeight: 5 }, mm, 6), 50);
  const inch = { units: 0, scaleNum: 1, scaleDen: 1 };
  assert.equal(viewHeightForScale({ height: 4 }, 50, inch, 1), 200, 'inch layout, inch drawing: 4 in of paper at 1:50 shows 200 in');
  assert.ok(Math.abs(viewportPrintScale({ height: 4, viewHeight: 5.08 }, inch, 6) - 50) < 1e-9, 'inch layout, metre drawing');
  for (const u of [0, 1, 4, 6]) for (const n of [1, 25, 250]) assert.ok(Math.abs(viewportPrintScale({ height: 7, viewHeight: viewHeightForScale({ height: 7 }, n, mm, u) }, mm, u) - n) < 1e-9);
});

test('viewport print scale ignores the page setup plot scale, as AutoCAD does: only the layout paper units count', () => {
  const vp = { height: 100, viewHeight: 5000 };
  assert.equal(viewportPrintScale(vp, { units: 1, scaleNum: 1, scaleDen: 2 }, 4), 50, 'mm layout plotted at 1:2');
  assert.equal(viewHeightForScale(vp, 50, { units: 1, scaleNum: 1, scaleDen: 2 }, 4), 5000);
  const inch = { units: 0, scaleNum: 1, scaleDen: 25.585 }; // an inch layout whose page setup plots 1:25.585
  assert.ok(Math.abs(viewportPrintScale({ height: 4, viewHeight: 5.08 }, inch, 6) - 50) < 1e-9, 'inch layout, metre drawing');
  assert.equal(viewHeightForScale({ height: 4 }, 50, inch, 1), 200);
});
