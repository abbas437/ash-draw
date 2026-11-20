// A twisted model view: the world box it shows (all four screen corners) and the culling box it is drawn through
// (the turned screen's bounding box, so a thin pan strip culls to about its own area)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenToWorld, visibleWorldBox, turnedView } from '../src/core/render.js';

const corners = (v) => [[0, 0], [v.width, 0], [0, v.height], [v.width, v.height]].map(([x, y]) => screenToWorld(v, x, y));
const holds = (b, p, e = 1e-9) => p.x >= b.minx - e && p.x <= b.maxx + e && p.y >= b.miny - e && p.y <= b.maxy + e;

test('visibleWorldBox at 45 degrees on a square screen holds all four corners and is the turned square\'s box', () => {
  const v = { cx: 5, cy: -3, zoom: 2, width: 400, height: 400, rot: Math.PI / 4 };
  const b = visibleWorldBox(v);
  for (const p of corners(v)) assert.ok(holds(b, p), `${p.x},${p.y}`);
  const side = 400 / 2 * Math.SQRT2; // a 200-unit square turned 45 degrees: its box is 200 * sqrt(2) each way
  assert.ok(Math.abs(b.maxx - b.minx - side) < 1e-9 && Math.abs(b.maxy - b.miny - side) < 1e-9, JSON.stringify(b));
  assert.ok(Math.abs((b.minx + b.maxx) / 2 - 5) < 1e-9 && Math.abs((b.miny + b.maxy) / 2 + 3) < 1e-9);
});

test('visibleWorldBox of an unturned view is the screen', () => {
  const b = visibleWorldBox({ cx: 0, cy: 0, zoom: 4, width: 400, height: 200 });
  assert.deepEqual(b, { minx: -50, miny: -25, maxx: 50, maxy: 25 });
});

test('a thin pan strip of a turned view culls to its own bounding box, not a square of its length', () => {
  const strip = { cx: 0, cy: 0, zoom: 1, width: 1920, height: 4 };
  const at90 = turnedView({ ...strip, rot: Math.PI / 2 });
  assert.ok(at90.width <= 8 && at90.height <= 1924, `${at90.width} x ${at90.height}`);
  for (const rot of [0.3, Math.PI / 4, 2, -1]) {
    const v = { ...strip, rot }, t = turnedView(v), hw = t.width / 2 / t.zoom, hh = t.height / 2 / t.zoom;
    for (const p of corners(v)) assert.ok(Math.abs(p.x - t.cx) <= hw && Math.abs(p.y - t.cy) <= hh, `rot ${rot}: corner outside`);
    const b = visibleWorldBox(v); // the cull box is the strip's world box plus the rounding margin
    assert.ok(t.width <= (b.maxx - b.minx) * t.zoom + 3 && t.height <= (b.maxy - b.miny) * t.zoom + 3, `rot ${rot}: ${t.width} x ${t.height}`);
  }
});
