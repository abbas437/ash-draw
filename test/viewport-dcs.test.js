import test from 'node:test';
import assert from 'node:assert/strict';
import { readViewport, viewportTags } from '../src/core/layouts.js';

// a record as dxfRead hands it over: first value per code
function rec(pairs) {
  const get = (c) => pairs.find(([k]) => k === c)?.[1];
  return {
    tags: () => pairs, has: (c) => get(c) !== undefined,
    num: (c, d = 0) => (get(c) === undefined ? d : +get(c)), int: (c, d = 0) => (get(c) === undefined ? d : parseInt(get(c), 10)),
    str: (c, d = '') => (get(c) === undefined ? d : String(get(c))),
  };
}
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('VIEWPORT view centre is read from DCS (relative to the target, turned by the twist in degrees)', () => {
  // the client layout: target on the site, centre given relative to it, twist 21.61 degrees
  const vp = readViewport(rec([[10, 356.88], [20, 292.48], [40, 697.87], [41, 549.01], [68, 1], [69, 3],
    [12, -247.1141502027096], [22, -65.53859614808198], [17, 626286.7691737288], [27, 2714441.998273774], [45, 274.505], [51, 21.61015107377975], [90, 839680]]), new Map());
  near(vp.twist, 21.61015107377975 * Math.PI / 180);
  // the site's middle (the plan the viewport shows), not (-247, -66) near the origin
  near(vp.viewCenter.x, 626032.9, 0.5); near(vp.viewCenter.y, 2714472.1, 0.5);
});

test('VIEWPORT written and read back keeps the WCS centre, target and twist', () => {
  const vp = { c: { x: 100, y: 80 }, width: 200, height: 150, vpId: 2, viewCenter: { x: 5000, y: 7000 }, target: { x: 4000, y: 6500 }, viewHeight: 300, twist: 0.4, frozen: [] };
  const back = readViewport(rec(viewportTags(vp, () => null)), new Map());
  near(back.viewCenter.x, 5000); near(back.viewCenter.y, 7000); near(back.twist, 0.4);
  assert.deepEqual(back.target, { x: 4000, y: 6500 });
  const t51 = viewportTags(vp, () => null).find(([c]) => c === 51)[1];
  near(t51, 0.4 * 180 / Math.PI); // degrees in the file
});
