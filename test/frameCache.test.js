// Reuse rule for the viewport's cached scene bitmap (src/core/frameCache.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { frameKey, framePlan, exposedStrips } from '../src/core/frameCache.js';

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
