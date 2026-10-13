import test from 'node:test';
import assert from 'node:assert/strict';
import { markPaperViewport, isPaperViewport, viewportAt, viewportTags } from '../src/core/layouts.js';

// the reviewer's B11 HVAC layout as LibreDWG converts it: the model viewport has ID 1, the paper viewport ID 2
const vp = (vpId, c, width, height, viewCenter, viewHeight) =>
  ({ type: 'VIEWPORT', vpId, c, width, height, viewCenter, viewHeight, twist: 0, on: true, frozen: [] });
const b11 = () => [
  vp(1, { x: 1.3776, y: 120.5606 }, 993.2244, 796.709, { x: 1771.0794, y: 54162.8665 }, 25640.1248),
  vp(2, { x: 77.1198, y: 120.5606 }, 2392.0644, 915.9765, { x: 77.1198, y: 120.5606 }, 915.9765),
  vp(3, { x: -382.1059, y: 452.8744 }, 226.2575, 132.0814, { x: -24060.2772, y: 70107.9109 }, 4067.4778),
];

test('the paper viewport is the one viewing the paper itself, not the one numbered 1', () => {
  const ents = b11();
  assert.equal(markPaperViewport(ents), ents[1]);
  assert.deepEqual(ents.map(isPaperViewport), [false, true, false]);
  // a click in the main viewport finds the model viewport (ID 1), which used to be skipped
  assert.equal(viewportAt(ents, { x: 0, y: 100 }), ents[0]);
});

test('without a self-viewing viewport the ID 1 rule still applies', () => {
  const ents = [vp(1, { x: 0, y: 0 }, 100, 80, { x: 50, y: 50 }, 10), vp(2, { x: 0, y: 0 }, 50, 40, { x: 9, y: 9 }, 5)];
  assert.equal(markPaperViewport(ents), ents[0]);
  assert.deepEqual(ents.map(isPaperViewport), [true, false]);
  // unmarked viewports (made in code) fall back to the ID
  assert.equal(isPaperViewport({ vpId: 1 }), true);
  assert.equal(isPaperViewport({ vpId: 4 }), false);
});

test('the paper viewport is written with ID 1 and a model viewport never is', () => {
  const ents = b11(); markPaperViewport(ents);
  const id = (v) => viewportTags(v, () => null).find(([c]) => c === 69)[1];
  assert.deepEqual(ents.map(id), [2, 1, 3]);
});
