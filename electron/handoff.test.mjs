import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffStore } from './handoff.js';

const bytes = (n) => new Uint8Array([n]);

test('a token is served once', () => {
  const s = createHandoffStore();
  const t = s.put(bytes(1));
  assert.match(t, /^[0-9a-f]{48}$/);
  assert.deepEqual(s.take(t), bytes(1));
  assert.equal(s.take(t), null);
  assert.equal(s.size, 0);
});

test('malformed and unknown tokens are refused', () => {
  const s = createHandoffStore();
  const t = s.put(bytes(1));
  for (const bad of [t.toUpperCase(), t + '/', '../' + t, t.slice(1), '', undefined, 'f'.repeat(48)]) assert.equal(s.take(bad), null);
  assert.equal(s.size, 1);
});

test('release drops an unserved token (a cancelled open)', () => {
  const s = createHandoffStore();
  const t = s.put(bytes(1));
  s.release(t);
  assert.equal(s.size, 0);
  assert.equal(s.take(t), null);
  s.release(t); // already gone: no-op
});

test('newer hand-offs push out the oldest beyond maxEntries', () => {
  const s = createHandoffStore({ maxEntries: 2 });
  const a = s.put(bytes(1)), b = s.put(bytes(2)), c = s.put(bytes(3));
  assert.equal(s.size, 2);
  assert.equal(s.take(a), null);
  assert.deepEqual(s.take(b), bytes(2));
  assert.deepEqual(s.take(c), bytes(3));
});

test('a token expires', async () => {
  const s = createHandoffStore({ ttlMs: 20 });
  const t = s.put(bytes(1));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s.size, 0);
  assert.equal(s.take(t), null);
});
