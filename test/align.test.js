import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignTransform } from '../src/core/align.js';
import { apply } from '../src/core/geom.js';

const near = (p, q, tol = 1e-9) => Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol;
const s1 = { x: 0, y: 0 }, s2 = { x: 10, y: 0 }, d1 = { x: 100, y: 100 }, d2 = { x: 100, y: 140 };

test('one pair: a pure move of s1 onto d1', () => {
  const m = alignTransform({ x: 3, y: 4 }, { x: -2, y: 7 });
  assert.ok(near(apply(m, { x: 3, y: 4 }), { x: -2, y: 7 }));
  assert.ok(near(apply(m, { x: 0, y: 0 }), { x: -5, y: 3 }));
});

test('two pairs, no scale: s1 -> d1 and s2 lands on the d1->d2 ray at its own distance', () => {
  const m = alignTransform(s1, d1, s2, d2, false);
  assert.ok(near(apply(m, s1), d1), 's1 -> d1');
  assert.ok(near(apply(m, s2), { x: 100, y: 110 }), 's2 on the ray, 10 from d1');
  assert.ok(near(apply(m, { x: 10, y: 10 }), { x: 90, y: 110 }), 'rigid: the far corner of a 10x10 square');
  // an oblique case: source direction 45 deg, destination direction 200 deg
  const a = { x: 1, y: 2 }, b = { x: 4, y: 5 }, c = { x: -3, y: 6 };
  const dd = { x: c.x + Math.cos(200 * Math.PI / 180) * 7, y: c.y + Math.sin(200 * Math.PI / 180) * 7 };
  const n = alignTransform(a, c, b, dd, false), q = apply(n, b);
  assert.ok(near(apply(n, a), c));
  const L = Math.hypot(q.x - c.x, q.y - c.y);
  assert.ok(Math.abs(L - Math.hypot(3, 3)) < 1e-9, 'length kept');
  assert.ok(near({ x: (q.x - c.x) / L, y: (q.y - c.y) / L }, { x: Math.cos(200 * Math.PI / 180), y: Math.sin(200 * Math.PI / 180) }), 'on the ray');
});

test('two pairs with scale: s2 maps exactly onto d2', () => {
  const m = alignTransform(s1, d1, s2, d2, true);
  assert.ok(near(apply(m, s1), d1));
  assert.ok(near(apply(m, s2), d2));
  assert.ok(near(apply(m, { x: 10, y: 10 }), { x: 60, y: 140 }), 'scaled x4 and turned 90 deg');
});

test('coincident source (or destination) points are rejected', () => {
  assert.throws(() => alignTransform(s1, d1, { x: 0, y: 0 }, d2, false), /source points coincide/);
  assert.throws(() => alignTransform(s1, d1, s2, { x: 100, y: 100 }, true), /destination points coincide/);
});
