// Shared fixture for the drawScene pixel-parity checks (node test/sceneGrid.test.js and the browser e2e).
import { newDocument, makeLine, makeArc, makeCircle, makeHatch, makeText, makeInsert, addEntity, addBlock, addLayer, addLinetype } from '../../src/core/model.js';

/** a mixed drawing: lines (one dashed layer), arcs, circles, pattern and solid hatches, texts, a rotated block */
export function mixedDoc() {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const doc = newDocument();
  addLinetype(doc, { name: 'DASHED', description: '__ __', pattern: [5, -2.5] });
  [1, 2, 3, 5, 7].forEach((c, i) => addLayer(doc, { name: `L${i}`, color: c, linetype: i === 2 ? 'DASHED' : 'CONTINUOUS' }));
  const L = () => `L${Math.floor(rnd() * 5)}`, P = () => ({ x: rnd() * 1000, y: rnd() * 600 });
  for (let i = 0; i < 1500; i++) { const p = P(), a = rnd() * 6.28, l = 2 + rnd() * 40; addEntity(doc, makeLine(p, { x: p.x + l * Math.cos(a), y: p.y + l * Math.sin(a) }, { layer: L() })); }
  for (let i = 0; i < 200; i++) addEntity(doc, makeArc(P(), 1 + rnd() * 15, rnd() * 360, rnd() * 360, { layer: L() }));
  for (let i = 0; i < 100; i++) addEntity(doc, makeCircle(P(), 1 + rnd() * 8, { layer: L() }));
  for (let i = 0; i < 60; i++) {
    const p = P(), w = 10 + rnd() * 40, h = 10 + rnd() * 40;
    addEntity(doc, makeHatch([{ pts: [p, { x: p.x + w, y: p.y }, { x: p.x + w, y: p.y + h }, { x: p.x, y: p.y + h }] }], { solid: i % 5 === 0, pattern: 'ANSI31', scale: 1 + (i % 3), layer: L() }));
  }
  addBlock(doc, 'EQP', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 10, y: 4 }), makeCircle({ x: 5, y: 5 }, 3), makeText({ x: 0, y: -2 }, 1.5, 'FCU')]);
  for (let i = 0; i < 80; i++) addEntity(doc, makeInsert('EQP', P(), { rot: rnd() * 360, sx: 1 + rnd(), sy: 1 + rnd(), layer: L() }));
  for (let i = 0; i < 300; i++) addEntity(doc, makeText(P(), 2 + rnd() * 4, ['ROOM 204', 'RA-12', 'FFL +3.250'][i % 3], { rot: i % 4 ? 0 : 90, layer: L() }));
  return doc;
}
