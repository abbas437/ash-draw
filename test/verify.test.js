import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDocuments } from '../src/core/verify.js';
import { newDocument, addEntity, makeInsert } from '../src/core/model.js';

test('compareDocuments: a rotation of -90 and 270 degrees is the same (ODA writes the positive angle)', () => {
  const mk = (rot) => { const d = newDocument(); addEntity(d, makeInsert('B', { x: 1, y: 2 }, { rot })); return d; };
  assert.equal(compareDocuments(mk(-90), mk(270)).ok, true);
  assert.equal(compareDocuments(mk(-90), mk(90)).ok, false);
});
