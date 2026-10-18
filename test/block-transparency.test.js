// Transparency inside a block reference, as AutoCAD / DWG TrueView draw it (checked 18-Oct-2026 on the noise
// treatment sheets): content keeps its own transparency (ByLayer: its own layer's); only layer-0 ByLayer and ByBlock
// content takes the INSERT's. A block on a 75 % transparent layer does not fade content on opaque layers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScene } from '../src/core/render.js';
import { newDocument, addLayer, addEntity, makeLine, makeInsert } from '../src/core/model.js';

const near = (a, b, tol = 0.005) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const at = (scene, y) => scene.items.find((it) => it.bbox && Math.abs(it.bbox.miny - y) < 1e-6);

function doc() {
  const d = newDocument();
  addLayer(d, { name: 'GA', color: 7, alpha: 63 }); // 75 % transparent: the insert's layer
  addLayer(d, { name: 'TAGS', color: 5 }); // opaque
  addLayer(d, { name: 'HALF', color: 7, alpha: 127 }); // 50 %
  const line = (y, props) => ({ ...makeLine({ x: 0, y }, { x: 10, y }), ...props });
  d.blocks.set('BG', { name: 'BG', base: { x: 0, y: 0 }, entities: [
    line(0, { layer: 'TAGS' }), // own opaque layer: solid
    line(1, { layer: '0' }), // layer 0: the insert's layer
    line(2, { layer: 'TAGS', alpha: -2 }), // ByBlock: the insert's
    line(3, { layer: 'HALF' }), // own layer 50 %
    line(4, { layer: 'GA' }), // on the insert's layer itself
  ] });
  addEntity(d, { ...makeInsert('BG', { x: 0, y: 0 }), layer: 'GA' });
  return d;
}

test('block content keeps its own transparency; layer-0 and ByBlock content take the INSERT\'s', () => {
  const sc = buildScene(doc());
  near(at(sc, 0).style.alpha, 1);
  near(at(sc, 1).style.alpha, 63 / 255);
  near(at(sc, 2).style.alpha, 63 / 255);
  near(at(sc, 3).style.alpha, 127 / 255);
  near(at(sc, 4).style.alpha, 63 / 255);
});
