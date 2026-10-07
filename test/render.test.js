import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, norm } from './helpers.js';
import { readDxf } from '../src/core/dxfRead.js';
import { docExtents } from '../src/core/geom.js';
import { newDocument, makeLine, makeCircle, makeHatch, makeText, addEntity, addBlock, makeInsert, addLayer } from '../src/core/model.js';
import { buildScene, updateScene, drawScene, fitView, screenToWorld, worldToScreen, zoomAt } from '../src/core/render.js';

/** recording stand-in for CanvasRenderingContext2D */
function fakeCtx() {
  const calls = {};
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'calls') return calls;
      if (k in t) return t[k];
      if (k === 'measureText') return (str) => ({ width: String(str).length * 6 });
      return (...a) => { (calls[k] ||= []).push(a); };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return ctx;
}
void norm;

test('scene bbox matches document extents for simple geometry', () => {
  const doc = newDocument();
  addEntity(doc, makeLine({ x: 0, y: 0 }, { x: 10, y: 5 }));
  addEntity(doc, makeCircle({ x: 20, y: 20 }, 3));
  const sc = buildScene(doc);
  assert.equal(sc.items.length, 2);
  assert.deepEqual(sc.bbox, { minx: 0, miny: 0, maxx: 23, maxy: 23 });
});

test('hidden / frozen layers are not drawn; BYBLOCK inherits from the INSERT', () => {
  const doc = newDocument();
  addLayer(doc, { name: 'HID', visible: false });
  addLayer(doc, { name: 'FRZ', frozen: true });
  addLayer(doc, { name: 'RED', color: 1 });
  addEntity(doc, makeLine({ x: 0, y: 0 }, { x: 1, y: 0 }, { layer: 'HID' }));
  addEntity(doc, makeLine({ x: 0, y: 0 }, { x: 1, y: 0 }, { layer: 'FRZ' }));
  addBlock(doc, 'B', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 }, { color: 0 })]);
  addEntity(doc, makeInsert('B', { x: 0, y: 0 }, { layer: 'RED' }));
  const sc = buildScene(doc);
  assert.equal(sc.items.length, 1);
  assert.deepEqual(sc.items[0].style.color.rgb, [255, 0, 0]);
});

test('insert transforms: rotation, scale and arrays', () => {
  const doc = newDocument();
  addBlock(doc, 'B', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 })]);
  addEntity(doc, makeInsert('B', { x: 10, y: 10 }, { rot: 90, sx: 2, sy: 2, cols: 2, colSp: 5 }));
  const sc = buildScene(doc);
  assert.equal(sc.items.length, 2);
  const [a, b] = sc.items.map((i) => i.bbox);
  assert.ok(Math.abs(a.maxx - 10) < 1e-9 && Math.abs(a.maxy - 12) < 1e-9);
  // column spacing runs along the rotated X axis (here +Y) and is not scaled by sx
  assert.ok(Math.abs(b.minx - 10) < 1e-9 && Math.abs(b.miny - 15) < 1e-9);
});

test('updateScene rebuilds only the given ids and refreshes bbox', () => {
  const doc = newDocument();
  const a = addEntity(doc, makeLine({ x: 0, y: 0 }, { x: 1, y: 0 }));
  addEntity(doc, makeLine({ x: 0, y: 5 }, { x: 1, y: 5 }));
  const sc = buildScene(doc);
  a.p2 = { x: 100, y: 0 };
  updateScene(sc, [a.id]);
  assert.equal(sc.items.length, 2);
  assert.equal(sc.bbox.maxx, 100);
  doc.entities = doc.entities.filter((e) => e.id !== a.id);
  updateScene(sc, [a.id]);
  assert.equal(sc.items.length, 1);
  assert.equal(sc.bbox.maxx, 1);
});

test('every fixture builds and draws without throwing', () => {
  for (const n of ['basic', 'blocks', 'colors', 'dims', 'extrusion', 'hatch', 'polylines', 'splines', 'text', 'unsupported']) {
    const doc = readDxf(fixture(`${n}_r2000.dxf`));
    const sc = buildScene(doc);
    const ctx = fakeCtx();
    const view = fitView(sc.bbox, 800, 600);
    drawScene(ctx, sc, view, { showLineweight: true, highlight: new Set(doc.entities.map((e) => e.id)) });
    assert.ok(ctx.calls.stroke?.length || ctx.calls.fill?.length || ctx.calls.fillText?.length, `${n} drew nothing`);
    const ext = docExtents(doc);
    if (ext && sc.bbox) {
      assert.ok(sc.bbox.minx <= ext.minx + 1e-6 && sc.bbox.maxx >= ext.maxx - 1e-6, `${n} bbox x`);
    }
  }
});

test('solid and pattern hatch', () => {
  const doc = newDocument();
  const loop = [{ pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], closed: true }];
  addEntity(doc, makeHatch(loop, { solid: true }));
  addEntity(doc, makeHatch(loop, { solid: false, pattern: 'ANSI31', scale: 1 }));
  const sc = buildScene(doc);
  const ctx = fakeCtx();
  drawScene(ctx, sc, fitView(sc.bbox, 400, 400), {});
  assert.ok(ctx.calls.fill.length >= 1);
  assert.ok(ctx.calls.clip.length >= 1);
  assert.ok(ctx.calls.stroke.length >= 1);
});

test('text lines and tiny text', () => {
  const doc = newDocument();
  addEntity(doc, makeText({ x: 0, y: 0 }, 2, 'abc'));
  const sc = buildScene(doc);
  assert.equal(sc.items[0].kind, 'text');
  const ctx = fakeCtx();
  drawScene(ctx, sc, { cx: 0, cy: 0, zoom: 10, width: 200, height: 200 }, {});
  assert.equal(ctx.calls.fillText.length, 1);
  const ctx2 = fakeCtx();
  drawScene(ctx2, sc, { cx: 0, cy: 0, zoom: 0.1, width: 200, height: 200 }, {});
  assert.equal(ctx2.calls.fillText, undefined);
});

test('view math round trips', () => {
  const v = { cx: 100, cy: -50, zoom: 4, width: 800, height: 600 };
  const p = { x: 123.5, y: -40 };
  const s = worldToScreen(v, p);
  const q = screenToWorld(v, s.x, s.y);
  assert.ok(Math.abs(q.x - p.x) < 1e-9 && Math.abs(q.y - p.y) < 1e-9);
  const z = zoomAt(v, 300, 200, 2);
  const before = screenToWorld(v, 300, 200), after = screenToWorld(z, 300, 200);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.equal(z.zoom, 8);
});
