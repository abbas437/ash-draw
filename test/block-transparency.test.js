// A block reference's transparency fades the whole block (AutoCAD / TrueView): a background plan inserted on a 75 %
// transparent layer is drawn faded whatever the layers of its contents (reported 18-Oct-2026, noise treatment sheets).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScene } from '../src/core/render.js';
import { newDocument, addLayer, addEntity, makeLine, makeInsert } from '../src/core/model.js';

const near = (a, b, tol = 0.005) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const at = (scene, y) => scene.items.find((it) => it.bbox && Math.abs(it.bbox.miny - y) < 1e-6);

function doc() {
  const d = newDocument();
  addLayer(d, { name: 'GA', color: 7, alpha: 63 }); // 75 % transparent: the background's insert layer
  addLayer(d, { name: 'WALL', color: 7 }); // opaque
  addLayer(d, { name: 'HALF', color: 7, alpha: 127 }); // 50 %
  const line = (y, props) => ({ ...makeLine({ x: 0, y }, { x: 10, y }), ...props });
  d.blocks.set('BG', { name: 'BG', base: { x: 0, y: 0 }, entities: [
    line(0, { layer: 'WALL' }), // own layer opaque
    line(1, { layer: '0' }), // layer 0: takes the insert's layer
    line(2, { layer: 'WALL', alpha: -2 }), // ByBlock
    line(3, { layer: 'HALF' }), // own layer 50 %
    line(4, { layer: 'WALL', alpha: 127 }), // own value 50 %
  ] });
  d.blocks.set('OUTER', { name: 'OUTER', base: { x: 0, y: 0 }, entities: [{ ...makeInsert('BG', { x: 0, y: 100 }), layer: 'WALL' }] });
  addEntity(d, { ...makeInsert('BG', { x: 0, y: 0 }), layer: 'GA' });
  addEntity(d, { ...makeInsert('BG', { x: 0, y: 50 }), layer: 'WALL' }); // an opaque insert: contents as they are
  addEntity(d, { ...makeInsert('OUTER', { x: 0, y: 0 }), layer: 'GA' }); // nested: the outer insert fades it all
  return d;
}

test('a block on a 75 % transparent layer is drawn at 25 % opacity throughout', () => {
  const sc = buildScene(doc());
  near(at(sc, 0).style.alpha, 63 / 255); // opaque own layer, faded by the insert
  near(at(sc, 1).style.alpha, 63 / 255); // layer 0: once, not squared
  near(at(sc, 2).style.alpha, 63 / 255); // ByBlock: once, not squared
  near(at(sc, 3).style.alpha, (127 / 255) * (63 / 255)); // its own 50 % on top
  near(at(sc, 4).style.alpha, (127 / 255) * (63 / 255));
});

test('an opaque insert keeps its contents\' own transparency; a nested block takes the outer insert\'s', () => {
  const sc = buildScene(doc());
  near(at(sc, 50).style.alpha, 1);
  near(at(sc, 53).style.alpha, 127 / 255);
  near(at(sc, 100).style.alpha, 63 / 255); // BG inside OUTER (opaque WALL insert) inside a GA insert
  near(at(sc, 103).style.alpha, (127 / 255) * (63 / 255));
});
