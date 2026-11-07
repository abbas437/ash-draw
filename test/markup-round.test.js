import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRound, cleanRounds, recallRound, rememberRound, ROUND_MAX } from '../renderer/markup-round.js';

test('defaultRound: next label after every markup and follow-up rev; none gives Rev.00', () => {
  assert.equal(defaultRound([]), 'Rev.00');
  assert.equal(defaultRound([{ rev: '', followUps: [] }]), 'Rev.00');
  assert.equal(defaultRound([{ rev: 'Rev.00', followUps: [] }]), 'Rev.01');
  assert.equal(defaultRound([{ rev: 'Rev.00', followUps: [{ rev: 'Rev.01' }] }, { rev: 'Rev.00' }]), 'Rev.02');
});

test('rememberRound / recallRound: one label per key, empty forgets, capped at 200 (oldest dropped)', () => {
  let l = rememberRound([], 'p:/a', 'Rev.01');
  l = rememberRound(l, 'p:/b', ' Rev.02 ');
  assert.equal(recallRound(l, 'p:/a'), 'Rev.01');
  assert.equal(recallRound(l, 'p:/b'), 'Rev.02');
  assert.equal(recallRound(l, 'p:/c'), '');
  assert.equal(recallRound(l, null), '');
  l = rememberRound(l, 'p:/a', 'Rev.03');
  assert.deepEqual(l, [['p:/b', 'Rev.02'], ['p:/a', 'Rev.03']], 'a changed key becomes the newest');
  assert.deepEqual(rememberRound(l, 'p:/a', ''), [['p:/b', 'Rev.02']]);
  assert.deepEqual(rememberRound(l, null, 'Rev.09'), l);
  for (let i = 0; i < ROUND_MAX + 5; i++) l = rememberRound(l, `p:/k${i}`, 'Rev.01');
  assert.equal(l.length, ROUND_MAX);
  assert.equal(recallRound(l, 'p:/k0'), '');
  assert.equal(recallRound(l, `p:/k${ROUND_MAX + 4}`), 'Rev.01');
});

test('cleanRounds keeps only valid pairs, one per key', () => {
  assert.deepEqual(cleanRounds(null), []);
  assert.deepEqual(cleanRounds([['p:/a', 'Rev.01'], ['', 'x'], ['p:/b', ''], ['p:/c', 3], 'bad', ['p:/a', 'Rev.02']]), [['p:/a', 'Rev.02']]);
});
