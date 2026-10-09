// A DIMENSION whose anonymous block does not match its definition points (bound / exploded xref: the *D block
// already holds world coordinates) is drawn from regenerated geometry, so it is not transformed a second time.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/core/model.js';
import { buildScene } from '../src/core/render.js';
import { bboxOf, dimensionContent, compose, translation, rotation, transformEntity, DEG } from '../src/core/geom.js';
import { buildDimension } from '../src/core/dims.js';
import { resolveDimStyle } from '../src/core/dimsStyle.js';

const P = (x, y) => ({ x, y });
const INS = P(626112.97, 2714404.2), ROT = 336.19;
const DEF = { kind: 'aligned', p1: P(-60, 40), p2: P(20, 40), at: P(20, 55), text: '' };

/** doc with block B holding a dimension; `world` puts the *D geometry in world coordinates (as the insert places it) */
function docWith(world, asInsert = false) {
  const doc = M.newDocument();
  const geo = buildDimension(DEF, resolveDimStyle(doc, 'Standard')).entities;
  const m = compose(translation(INS.x, INS.y), rotation(ROT * DEG));
  M.addBlock(doc, '*D1', P(0, 0), geo.map((g) => (world ? transformEntity(g, m) : g)));
  const dim = asInsert ? M.makeInsert('*D1', P(0, 0), {}) : M.makeDimension('*D1', { dimType: 1 | 32, p: P(-20, 57) });
  if (!asInsert) Object.assign(dim, { def: DEF, style: 'Standard' });
  M.addBlock(doc, 'B', P(0, 0), [dim, M.makeLine(P(-100, 0), P(100, 0))]);
  M.addEntity(doc, M.makeInsert('B', INS, { rot: ROT }));
  return { doc, dim };
}
const near = (b, p, r) => b && b.minx > p.x - r && b.maxx < p.x + r && b.miny > p.y - r && b.maxy < p.y + r;

test('a nested dimension whose *D block holds world coordinates is regenerated: extents stay at the insert', () => {
  const { doc, dim } = docWith(true);
  assert.equal(dimensionContent(dim, doc).regenerated, true);
  const sc = buildScene(doc);
  assert.ok(near(sc.bbox, INS, 500), `scene bbox ${JSON.stringify(sc.bbox)}`);
  assert.ok(near(bboxOf(doc.entities[0], doc), INS, 500), 'bboxOf of the insert');
  assert.ok(sc.items.length > 1, 'the dimension is still drawn');
});

test('a consistent nested dimension still draws its own block, item for item', () => {
  const { doc, dim } = docWith(false);
  const dc = dimensionContent(dim, doc);
  assert.equal(dc.regenerated, false);
  assert.equal(dc.entities, doc.blocks.get('*D1').entities);
  const ref = docWith(false, true).doc; // the same *D block drawn as a plain INSERT
  const strip = (s) => s.items.map(({ id, ...it }) => JSON.stringify(it)).sort();
  assert.deepEqual(strip(buildScene(doc)), strip(buildScene(ref)));
  assert.deepEqual(bboxOf(doc.entities[0], doc), bboxOf(ref.entities[0], ref));
});
