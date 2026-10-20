// Reuse rule for the viewport's cached scene bitmap (src/core/frameCache.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { frameKey, framePlan, placeFrame, sameKey, exposedStrips } from '../src/core/frameCache.js';
import { zoomAt } from '../src/core/render.js';

const scene = { version: 3 }, selection = new Set();
const key = (o = {}) => frameKey({ scene, dark: false, lineweights: false, selection, dpr: 1, pxWidth: 800, pxHeight: 600, ...o });
const view = { cx: 100, cy: 50, zoom: 2, width: 800, height: 600 };
const frame = (o = {}) => ({ key: key(), view, exact: true, ...o });

test('any content change invalidates the cached frame, gesture or not', () => {
  for (const g of [null, 'pan', 'zoom']) {
    assert.equal(framePlan(frame(), key(), view, g).mode, 'blit');
    const edited = { ...scene, version: 4 };
    assert.equal(framePlan(frame(), key({ scene: edited }), view, g).mode, 'full', 'new scene object');
    const before = frame();
    scene.version = 4; // updateScene bumps the version of the same scene object
    assert.equal(framePlan(before, key(), view, g).mode, 'full', 'edit');
    scene.version = 3;
    assert.equal(framePlan(frame(), key({ dark: true }), view, g).mode, 'full', 'theme');
    assert.equal(framePlan(frame(), key({ lineweights: true }), view, g).mode, 'full', 'lineweights');
    assert.equal(framePlan(frame(), key({ selection: new Set([1]) }), view, g).mode, 'full', 'selection');
    assert.equal(framePlan(frame(), key({ pxWidth: 801 }), view, g).mode, 'full', 'resize');
    assert.equal(framePlan(null, key(), view, g).mode, 'full', 'invalidated');
  }
});

test('view changes: full render without a gesture, shift while panning, scale while zooming', () => {
  const panned = { ...view, cx: view.cx - 10 / 2, cy: view.cy + 4.2 / 2 };
  assert.equal(framePlan(frame(), key(), panned, null).mode, 'full');
  const p = framePlan(frame(), key(), panned, 'pan');
  assert.equal(p.mode, 'shift');
  assert.deepEqual([p.dx, p.dy], [10, 4]); // whole device pixels; the frame view moves by exactly that
  assert.equal(p.view.cx, view.cx - 10 / 2); assert.equal(p.view.cy, view.cy + 4 / 2);
  assert.equal(framePlan(frame(), key(), { ...view, cx: view.cx + 900 }, 'pan').mode, 'full', 'shift beyond the canvas');
  const z = framePlan(frame(), key(), { ...view, zoom: 4 }, 'zoom');
  assert.deepEqual(z, { mode: 'scale', s: 2, ox: -400, oy: -300 }); // zoom x2 about the centre
  // a gesture approximation is redrawn once the gesture is over, an exact frame is not
  assert.equal(framePlan(frame({ exact: false }), key(), view, 'pan').mode, 'blit');
  assert.equal(framePlan(frame({ exact: false }), key(), view, null).mode, 'full');
});

test('placeFrame maps a point of the old view to where the new view shows it; sameKey can leave one field out', () => {
  const to = { ...view, cx: 130, cy: 20, zoom: 5 }, p = { x: 117, y: 61 };
  const scr = (v) => ({ x: (p.x - v.cx) * v.zoom + v.width / 2, y: v.height / 2 - (p.y - v.cy) * v.zoom });
  const { s, ox, oy } = placeFrame(view, to), a = scr(view), b = scr(to);
  assert.equal(s, 2.5);
  assert.ok(Math.abs(a.x * s + ox - b.x) < 1e-9 && Math.abs(a.y * s + oy - b.y) < 1e-9);
  const k1 = { ...key(), msView: 'a' }, k2 = { ...key(), msView: 'b' };
  assert.equal(sameKey(k1, k2), false);
  assert.equal(sameKey(k1, k2, 'msView'), true);
  assert.equal(sameKey({ ...k1, dpr: 2 }, k2, 'msView'), false);
});

test('exposed strips cover exactly the uncovered area', () => {
  for (const [dx, dy] of [[10, 0], [-10, 0], [0, 7], [0, -7], [10, -7], [-3, 5]]) {
    const r = exposedStrips(dx, dy, 40, 30);
    const hit = new Uint8Array(40 * 30);
    for (const [x, y, w, h] of r) for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) hit[j * 40 + i]++;
    for (let j = 0; j < 30; j++) for (let i = 0; i < 40; i++) {
      const covered = i - dx >= 0 && i - dx < 40 && j - dy >= 0 && j - dy < 30;
      assert.equal(hit[j * 40 + i], covered ? 0 : 1, `(${dx},${dy}) pixel ${i},${j}`);
    }
  }
});

test('a wheel burst: the cached frame is scaled about the cursor, accumulated over the steps, and stands in under the full redraw', () => {
  const f0 = frame(), sx = 230, sy = 410; // the cursor, CSS pixels
  const scr = (v, p) => ({ x: (p.x - v.cx) * v.zoom + v.width / 2, y: v.height / 2 - (p.y - v.cy) * v.zoom });
  const under = { x: view.cx + (sx - view.width / 2) / view.zoom, y: view.cy - (sy - view.height / 2) / view.zoom }; // world point under the cursor
  const other = { x: 37, y: 91 };
  let v = view, s = 1;
  for (const k of [1.25, 1.25, 1.25, 0.8, 1.5]) { // each wheel step zooms about the cursor (render.js zoomAt)
    v = zoomAt(v, sx, sy, k); s *= k;
    const p = framePlan(f0, key(), v, 'zoom');
    assert.equal(p.mode, 'scale');
    assert.ok(Math.abs(p.s - s) < 1e-12, `accumulated scale ${p.s} vs ${s}`);
    assert.ok(Math.abs(sx * p.s + p.ox - sx) < 1e-9 && Math.abs(sy * p.s + p.oy - sy) < 1e-9, 'the point under the cursor stays put');
    const a = scr(view, other), b = scr(v, other);
    assert.ok(Math.abs(a.x * p.s + p.ox - b.x) < 1e-9 && Math.abs(a.y * p.s + p.oy - b.y) < 1e-9, 'any other point lands where the new view shows it');
    const c = scr(v, under);
    assert.ok(Math.abs(c.x - sx) < 1e-9 && Math.abs(c.y - sy) < 1e-9);
  }
  // the burst is over: a full render, with the last frame placed the same way to stand in until it is finished
  const full = framePlan(f0, key(), v, null);
  assert.equal(full.mode, 'full');
  assert.deepEqual(full.under, placeFrame(view, v));
  assert.deepEqual(framePlan(frame({ exact: false }), key(), view, null), { mode: 'full', under: { s: 1, ox: 0, oy: 0 } }, 'a gesture approximation stands in for its own exact redraw');
  // no stand-in where the frame shows other content or another canvas size
  assert.equal(framePlan(f0, key({ dark: true }), v, null).under, undefined);
  assert.equal(framePlan(f0, key({ pxWidth: 900 }), { ...v, width: 900 }, null).under, undefined);
  assert.equal(framePlan(null, key(), v, null).under, undefined);
});
