import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { newDocument, makeLine, makeText, addEntity } from '../src/core/model.js';
import { buildScene, drawScene, zoomAt, zoomLimits, worldToScreen } from '../src/core/render.js';

// A drawing at UTM-like coordinates: long lines (km) through the area of interest, short ones and text near it.
const E = 626812, N = 2714424;
function utmDoc() {
  const doc = newDocument();
  addEntity(doc, makeLine({ x: E - 4000, y: N + 0.3 }, { x: E + 5000, y: N + 0.3 }));        // 9 km, horizontal
  addEntity(doc, makeLine({ x: E + 0.2, y: N - 3000 }, { x: E + 0.2, y: N + 2500 }));        // 5.5 km, vertical
  addEntity(doc, makeLine({ x: E - 2, y: N - 2 }, { x: E + 3, y: N + 1 }));                  // short, diagonal
  addEntity(doc, makeText({ x: E - 1, y: N - 1 }, 0.5, 'E : 626812.045'));
  return doc;
}

/** draws through a recording proxy: every coordinate handed to a path call is checked, the pixels are real */
function draw(scene, view) {
  const cv = createCanvas(view.width, view.height), real = cv.getContext('2d');
  let maxAbs = 0;
  const PATH = new Set(['moveTo', 'lineTo', 'arc', 'ellipse', 'rect']);
  const ctx = new Proxy(real, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== 'function') return v;
      if (PATH.has(k)) return (...a) => { for (const n of a.slice(0, 2)) maxAbs = Math.max(maxAbs, Math.abs(n)); return v.apply(t, a); };
      return v.bind(t);
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  drawScene(ctx, scene, view, { background: '#ffffff' });
  const d = real.getImageData(0, 0, view.width, view.height).data;
  const ink = (x, y) => { // any non-background pixel within 1 px of (x, y)
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const o = ((Math.round(y) + j) * view.width + Math.round(x) + i) * 4;
      if (d[o] < 200 || d[o + 1] < 200 || d[o + 2] < 200) return true;
    }
    return false;
  };
  return { maxAbs, ink };
}

test('deep zoom at UTM coordinates: lines stay drawn at the right place from 1 m to 1 mm per pixel', () => {
  const scene = buildScene(utmDoc());
  for (const mPerPx of [1, 0.01, 0.001]) {
    const view = { cx: E + 0.05, cy: N + 0.25, zoom: 1 / mPerPx, width: 400, height: 300 };
    const r = draw(scene, view);
    const h = worldToScreen(view, { x: E, y: N + 0.3 }), v = worldToScreen(view, { x: E + 0.2, y: N });
    assert.ok(r.ink(view.width / 2 + 30, h.y), `horizontal line at ${mPerPx} m/px (y=${h.y})`);
    assert.ok(r.ink(v.x, view.height / 2 + 40), `vertical line at ${mPerPx} m/px (x=${v.x})`);
    assert.ok(!r.ink(view.width / 2 + 30, h.y + 6) || mPerPx === 1, `nothing drawn 6 px off the horizontal line at ${mPerPx} m/px`);
    // the canvas never gets coordinates far outside the view (GPU backends drop such paths)
    assert.ok(r.maxAbs < 1e4, `largest path coordinate ${r.maxAbs} at ${mPerPx} m/px`);
  }
});

test('deep zoom: zoom limits are relative to the extents and keep 1 mm per pixel reachable', () => {
  const scene = buildScene(utmDoc());
  const lim = zoomLimits(scene.bbox, 800, 600);
  assert.ok(lim.max >= 1000, `max zoom ${lim.max} px/unit allows 1 mm per pixel`);
  assert.ok(lim.max <= 2 ** 36 / N + 1e-9, 'max zoom keeps double precision of the coordinates');
  assert.ok(lim.min < 800 / 9000 && lim.min > 0, `min zoom ${lim.min}`);
  let v = { cx: E, cy: N, zoom: 1, width: 800, height: 600 };
  for (let i = 0; i < 200; i++) v = zoomAt(v, 400, 300, 1.25, lim);
  assert.equal(v.zoom <= lim.max, true);
  assert.equal(zoomAt(v, 400, 300, 1.25, lim), v, 'zooming in at the limit leaves the view unchanged');
});
