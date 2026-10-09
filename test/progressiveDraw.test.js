// Progressive frames: drawSceneSteps run in time slices (as renderer/viewport.js does for huge scenes) must give the
// same pixels as the synchronous drawScene.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { mixedDoc } from './ref/mixedDoc.js';
import { addEntity, makeLine, addLayer } from '../src/core/model.js';
import { buildScene, drawScene, drawSceneSteps, fitView } from '../src/core/render.js';
import { runSliced } from '../src/core/slice.js';

const W = 500, H = 320, OPTS = { background: '#ffffff' };
const canvas = () => { const cv = createCanvas(W, H); return [cv, cv.getContext('2d')]; };
const differing = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++; return n; };

/** the mixed fixture plus 40,000 short lines on one layer (one style batch longer than a stroke chunk) */
function bigDoc() {
  const doc = mixedDoc();
  addLayer(doc, { name: 'MANY', color: 4 });
  for (let i = 0; i < 40000; i++) { const x = (i % 400) * 2.5, y = -20 - Math.floor(i / 400) * 2; addEntity(doc, makeLine({ x, y }, { x: x + 1.7, y: y - 1.3 }, { layer: 'MANY' })); }
  return doc;
}

test('drawSceneSteps in time slices draws the same pixels as drawScene, and is split into many steps', async () => {
  const scene = buildScene(bigDoc());
  const fit = fitView(scene.bbox, W, H);
  for (const view of [fit, { ...fit, zoom: fit.zoom * 5, cx: 300, cy: 100 }, { ...fit, zoom: fit.zoom * 3, cx: 400, cy: -60 }]) {
    const [, a] = canvas(), [, b] = canvas(), [, other] = canvas();
    drawScene(a, scene, view, OPTS);
    let steps = 0;
    const gen = drawSceneSteps(b, scene, view, OPTS);
    const counted = (function* () { for (;;) { const r = gen.next(); if (r.done) return r.value; steps++; other.fillRect(0, 0, 1, 1); yield 0; } })();
    await runSliced(counted, { budgetMs: 0 }); // every step in its own event-loop turn
    const pa = a.getImageData(0, 0, W, H).data, pb = b.getImageData(0, 0, W, H).data;
    let ink = 0; for (let i = 0; i < pa.length; i += 4) if (pa[i] < 250 || pa[i + 1] < 250 || pa[i + 2] < 250) ink++;
    assert.ok(ink > 2000, `the view draws something (${ink} px)`);
    assert.equal(differing(pa, pb), 0, `pixels differ at zoom ${view.zoom}`);
    if (view === fit) assert.ok(steps >= 40, `the full view is drawn in many steps (${steps})`);
  }
});
