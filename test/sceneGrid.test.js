import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { SceneGrid } from '../src/core/sceneGrid.js';
import { mixedDoc } from './ref/mixedDoc.js';
import { buildScene, updateScene, drawScene, fitView, sceneGrid, visibleItems } from '../src/core/render.js';
import { drawSceneRef } from './ref/drawSceneRef.js';

const box = (minx, miny, maxx, maxy) => ({ minx, miny, maxx, maxy });

test('SceneGrid: insert, query and remove', () => {
  const g = new SceneGrid(box(0, 0, 100, 100), 100);
  const a = { bbox: box(1, 1, 2, 2) }, b = { bbox: box(80, 80, 90, 85) }, huge = { bbox: box(-1e6, -1e6, 1e6, 1e6) }, none = { bbox: null };
  const out = { bbox: box(500, 500, 501, 501) }; // outside the extent: clamped to the edge cells
  for (const it of [a, b, huge, none, out]) g.insert(it);
  assert.equal(g.size, 5);
  const q = (bx) => new Set(g.query(bx));
  assert.deepEqual(q(box(0, 0, 5, 5)), new Set([a, huge, none]));
  assert.ok(q(box(85, 82, 86, 83)).has(b));
  assert.ok(!q(box(85, 82, 86, 83)).has(a));
  assert.ok(q(box(499, 499, 600, 600)).has(out));
  g.remove(a); g.remove(huge);
  assert.equal(g.size, 3);
  assert.deepEqual(q(box(0, 0, 5, 5)), new Set([none]));
  assert.equal(g.query(box(0, 0, 100, 100)).length, 3); // each item once
});

const W = 500, H = 320;
function pixels(draw, scene, view) {
  const cv = createCanvas(W, H), ctx = cv.getContext('2d');
  draw(ctx, scene, view, { background: '#ffffff' });
  return ctx.getImageData(0, 0, W, H).data;
}
const differing = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++; return n / (a.length / 4); };

test('pixel parity: grid-culled drawScene matches the reference drawScene at three zoom levels', () => {
  const doc = mixedDoc();
  const scene = buildScene(doc);
  const fit = fitView(scene.bbox, W, H);
  const views = [[2, 300, 200], [6, 620, 410], [16, 150, 520]].map(([k, cx, cy]) => ({ ...fit, zoom: fit.zoom * k, cx, cy }));
  for (const v of views) {
    const ref = pixels(drawSceneRef, scene, v);
    let ink = 0; for (let i = 0; i < ref.length; i += 4) if (ref[i] < 250 || ref[i + 1] < 250 || ref[i + 2] < 250) ink++;
    assert.ok(ink > 500, `reference view at zoom ${v.zoom} draws something (${ink} px)`);
    const d = differing(ref, pixels(drawScene, scene, v));
    assert.ok(d <= 0.005, `zoom ${v.zoom.toFixed(3)}: ${(d * 100).toFixed(3)} % of pixels differ`);
  }
});

test('visibleItems keeps scene order and follows updateScene', () => {
  const doc = mixedDoc();
  const scene = buildScene(doc);
  sceneGrid(scene);
  const view = [300, 200, 420, 300];
  const brute = () => scene.items.filter((it) => !it.bbox || !(it.bbox.maxx < view[0] || it.bbox.minx > view[2] || it.bbox.maxy < view[1] || it.bbox.miny > view[3]));
  assert.deepEqual(visibleItems(scene, ...view), brute());
  // move an entity into the view, delete another that is in it
  const inView = brute().find((it) => it.kind === 'path').id;
  const mover = doc.entities.find((e) => e.type === 'LINE' && e.p1.x > 800);
  mover.p1 = { x: 350, y: 250 }; mover.p2 = { x: 360, y: 255 };
  doc.entities = doc.entities.filter((e) => e.id !== inView);
  updateScene(scene, [mover.id, inView]);
  const vis = visibleItems(scene, ...view);
  assert.deepEqual(vis, brute());
  assert.ok(vis.some((it) => it.id === mover.id) && !vis.some((it) => it.id === inView));
  assert.equal(scene.grid.size, scene.items.length);
});

test('visibleItems: a view containing the whole scene returns scene.items without a bbox pass', () => {
  const scene = buildScene(mixedDoc());
  const b = scene.bbox;
  assert.equal(visibleItems(scene, b.minx - 1, b.miny - 1, b.maxx + 1, b.maxy + 1), scene.items);
});
