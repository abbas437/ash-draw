import test from 'node:test';
import assert from 'node:assert/strict';
import { viewportToPaper, docWithFrozen } from '../src/core/render.js';

const vp = { c: { x: 200, y: 150 }, width: 200, height: 100, viewCenter: { x: 1000, y: 500 }, viewHeight: 5000, twist: 0 };
const near = (a, b) => { assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9, `${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

test('viewportToPaper: 1:50, no twist', () => {
  near(viewportToPaper(vp, { x: 1000, y: 500 }), { x: 200, y: 150 });
  near(viewportToPaper(vp, { x: 1500, y: 500 }), { x: 210, y: 150 }); // 500 model = 10 paper at 1:50
  near(viewportToPaper(vp, { x: 1000, y: 250 }), { x: 200, y: 145 });
});

test('viewportToPaper: 1:50, twist 30 degrees turns the model counter-clockwise', () => {
  const t = Math.PI / 6, v = { ...vp, twist: t };
  near(viewportToPaper(v, { x: 1500, y: 500 }), { x: 200 + 10 * Math.cos(t), y: 150 + 10 * Math.sin(t) });
  near(viewportToPaper(v, { x: 1000, y: 1000 }), { x: 200 - 10 * Math.sin(t), y: 150 + 10 * Math.cos(t) });
});

test('docWithFrozen freezes only the listed layers, case-insensitively, without touching the doc', () => {
  const doc = { layers: new Map([['0', { name: '0' }], ['HIDE', { name: 'HIDE' }]]), entities: [] };
  const d = docWithFrozen(doc, ['hide']);
  assert.equal(d.layers.get('HIDE').frozen, true);
  assert.ok(!d.layers.get('0').frozen);
  assert.ok(!doc.layers.get('HIDE').frozen);
  assert.equal(docWithFrozen(doc, []), doc);
});
