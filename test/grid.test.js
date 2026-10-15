import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridStep, axisPositions, gridLayout, drawGrid, GRID_MAX, GRID_MIN_PX, cleanSpacing, cleanMajor, cleanStyle } from '../src/core/grid.js';

const view = (zoom, cx = 0, cy = 0, width = 1000, height = 600) => ({ cx, cy, zoom, width, height });

test('the base spacing is kept while it is readable', () => {
  assert.deepEqual(gridStep(10, 5, view(1)), { step: 10, major: 5 });
  assert.deepEqual(gridStep(10, 5, view(0.8)), { step: 10, major: 5 }); // exactly 8 px
});

test('adaptive spacing: multiplied by the major count until at least 8 px on screen', () => {
  assert.equal(gridStep(10, 5, view(0.5)).step, 50);
  assert.equal(gridStep(10, 5, view(0.01)).step, 1250); // 10 * 5^4: 12.5 px
  for (const z of [1e-6, 0.003, 0.07, 0.5, 2, 40]) {
    const { step } = gridStep(10, 5, view(z));
    assert.ok(step * z >= GRID_MIN_PX, `zoom ${z}: ${step * z} px`);
    assert.ok(step === 10 || (step / 5) * z < GRID_MIN_PX, `zoom ${z}: step ${step} is not the finest readable one`);
  }
});

test('without major lines the spacing grows tenfold', () => {
  assert.equal(gridStep(10, 1, view(0.5)).step, 100);
});

test('the dot count is capped: a dense but readable grid of dots coarsens, lines do not', () => {
  const v = view(1, 0, 0, 1920, 1080); // 10 px spacing: 193 x 109 dots
  assert.equal(gridStep(10, 5, v, 'lines').step, 10);
  const dots = gridStep(10, 5, v, 'dots');
  assert.equal(dots.step, 50);
  const L = gridLayout(v, { spacing: 10, major: 5, style: 'dots' });
  assert.ok(L.xs.length * L.ys.length <= GRID_MAX);
  // a tiny cap forces it further
  assert.ok(gridStep(10, 5, v, 'dots', 100).step >= 250);
});

test('the count stays capped at any zoom and canvas size', () => {
  for (const [w, h] of [[800, 600], [3840, 2160], [7680, 4320]]) {
    for (let z = 1e-5; z < 1e4; z *= 3.7) {
      for (const style of ['dots', 'lines']) {
        const L = gridLayout(view(z, 123.4, -56.7, w, h), { spacing: 10, major: 5, style });
        const n = style === 'dots' ? L.xs.length * L.ys.length : L.xs.length + L.ys.length;
        assert.ok(n <= GRID_MAX, `${w}x${h} zoom ${z} ${style}: ${n}`);
      }
    }
  }
});

test('visible range to positions: multiples of the step inside the view, majors every N', () => {
  const xs = axisPositions(-12, 31, 10, 5);
  assert.deepEqual(xs.map((p) => p.v), [-10, 0, 10, 20, 30]);
  assert.deepEqual(xs.map((p) => p.major), [false, true, false, false, false]);
  assert.deepEqual(axisPositions(40, 60, 10, 5).map((p) => p.major), [false, true, false]);
  assert.deepEqual(axisPositions(1, 9, 10, 5), []);
  const L = gridLayout(view(2, 100, 50, 400, 200), { spacing: 10, major: 5, style: 'lines' }); // x 0..200, y 0..100
  assert.equal(L.step, 10);
  assert.equal(L.xs.length, 21); assert.equal(L.ys.length, 11);
  assert.equal(L.xs[0].v, 0); assert.equal(L.xs.at(-1).v, 200);
  assert.deepEqual(L.xs.filter((p) => p.major).map((p) => p.v), [0, 50, 100, 150, 200]);
});

test('unusable input draws nothing', () => {
  assert.equal(gridStep(0, 5, view(1)), null);
  assert.equal(gridStep(10, 5, view(0)), null);
  assert.equal(gridStep(10, 5, view(1, 0, 0, 0, 600)), null);
});

test('drawGrid strokes the lines in two passes and fills dots, never more than the cap', () => {
  const calls = { moveTo: 0, rect: 0, stroke: 0, fill: 0 };
  const ctx = { save() {}, restore() {}, beginPath() {}, setLineDash() {}, lineTo() {}, moveTo() { calls.moveTo++; }, rect() { calls.rect++; }, stroke() { calls.stroke++; }, fill() { calls.fill++; } };
  const v = view(2, 100, 50, 400, 200);
  assert.equal(drawGrid(ctx, v, { spacing: 10, major: 5, style: 'lines' }, true), 32);
  assert.equal(calls.moveTo, 32); assert.equal(calls.stroke, 2);
  assert.equal(drawGrid(ctx, v, { spacing: 10, major: 5, style: 'dots' }, false), 21 * 11);
  assert.equal(calls.rect, 21 * 11); assert.equal(calls.fill, 2);
});

test('saved values are validated', () => {
  assert.equal(cleanSpacing(2.5), 2.5); assert.equal(cleanSpacing(0), null); assert.equal(cleanSpacing('10'), null); assert.equal(cleanSpacing(Infinity), null);
  assert.equal(cleanMajor(5), 5); assert.equal(cleanMajor(0), null); assert.equal(cleanMajor(2.5), null);
  assert.equal(cleanStyle('dots'), 'dots'); assert.equal(cleanStyle('cross'), null);
});
