import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { newDocument, makeLine, makeCircle, makeText } from '../src/core/model.js';
import { Session, addEntities } from '../src/core/edit.js';
import { transformEntity, compose, rotation, translation, apply } from '../src/core/geom.js';
import { addMarkup, listMarkups, markupData, setMarkupStatus, setMarkupCode, MARKUP_LAYER } from '../src/core/markup.js';
import { alignForImport, importMarkups, pointsTransform, IMPORT_MIN_QUALITY } from '../src/core/markupImport.js';
import { ezdxfAvailable, validateWithEzdxf } from './helpers.js';

const meta = { author: 'Ahmad', date: '2026-11-07' };
const DAMPER = { x: 40, y: 25 }; // centre of a content circle; markup 1 is drawn around it

/** a small duct plan: an outline, a grid of varied lines, circles (dampers) and labels, units mm */
function content() {
  const out = [makeLine({ x: 0, y: 0 }, { x: 200, y: 0 }), makeLine({ x: 200, y: 0 }, { x: 200, y: 120 }), makeLine({ x: 200, y: 120 }, { x: 0, y: 120 }), makeLine({ x: 0, y: 120 }, { x: 0, y: 0 })];
  for (let i = 0; i < 12; i++) out.push(makeLine({ x: 10 + i * 15, y: 10 }, { x: 10 + i * 15 + 3 * i, y: 10 + 7 + i * 4 }));
  for (let i = 0; i < 6; i++) out.push(makeCircle({ x: 40 + i * 25, y: 25 + (i % 3) * 30 }, 2 + i));
  for (let i = 0; i < 4; i++) out.push(makeText({ x: 20 + i * 40, y: 100 }, 3, `VCD-${i + 1}`));
  return out;
}

function docOf(ents) {
  const d = newDocument(); d.units = 4;
  addEntities(new Session(d), ents);
  return d;
}

/** Rev.00 with three markups: an open circle (no 1), a closed rect (no 2), an open text with code A (no 3) */
function rev00() {
  const s = new Session(docOf(content()));
  addMarkup(s, 'circle', { c: DAMPER, r: 6 }, { ...meta, comment: 'Check damper access' });
  addMarkup(s, 'rect', { p1: { x: 100, y: 40 }, p2: { x: 130, y: 60 } }, { ...meta, comment: 'Duct size to suit' });
  addMarkup(s, 'text', { p: { x: 150, y: 110 } }, { ...meta, comment: 'See spec 23 31 13' });
  const [, b, c] = listMarkups(s.doc);
  setMarkupStatus(s, b.uid, 'Closed');
  setMarkupCode(s, c.uid, 'A');
  return s.doc;
}

const M = compose(translation(500, -300), rotation(Math.PI / 2)); // Rev.01: turned 90 degrees and moved
const rev01 = (m = null) => new Session(docOf(content().map((e) => (m ? transformEntity(e, m) : e))));
const parts = (doc) => doc.entities.filter((e) => markupData(e));
const strip = (e) => { const { id, handle, parent, ...r } = e; return r; };

test('import at identity: geometry and XDATA identical, parts grouped by uid, fresh ids, layer and linetype as markup.js', () => {
  const src = rev00(), s = rev01();
  const r = importMarkups(s, src);
  assert.deepEqual(r, { imported: 3, skippedClosed: 0, skippedDuplicate: 0, skippedNoLayout: 0, numberCollisions: [] });
  assert.deepEqual(parts(s.doc).map(strip), parts(src).map(strip));
  const strp = (l) => l.map(({ ids, bbox, ...m }) => ({ ...m, n: ids.length }));
  assert.deepEqual(strp(listMarkups(s.doc)), strp(listMarkups(src)));
  const ids = parts(s.doc).map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id > content().length), 'ids are fresh in the target');
  assert.deepEqual(s.doc.layers.get(MARKUP_LAYER), src.layers.get(MARKUP_LAYER));
  assert.deepEqual(s.doc.linetypes.get('DASHED'), src.linetypes.get('DASHED'));
  assert.deepEqual([...s.doc.layers.keys()].sort(), ['0', MARKUP_LAYER]);
  assert.equal(s.doc.blocks.size, 0);
});

test('rotated and moved Rev.01: alignForImport finds the transform; the markup circle lands on the same damper', () => {
  const src = rev00(), s = rev01(M);
  const a = alignForImport(src, s.doc);
  assert.equal(a.method, 'auto');
  assert.ok(a.quality >= 99, `quality ${a.quality}`);
  importMarkups(s, src, { transform: a.transform });
  const circle = parts(s.doc).find((e) => e.type === 'CIRCLE');
  const want = apply(M, DAMPER);
  assert.ok(s.doc.entities.some((e) => e.type === 'CIRCLE' && !markupData(e) && Math.hypot(e.c.x - want.x, e.c.y - want.y) < 1e-9), 'the damper is there in Rev.01');
  const err = Math.hypot(circle.c.x - want.x, circle.c.y - want.y) / Math.hypot(want.x, want.y);
  assert.ok(err < 1e-6, `circle centre ${JSON.stringify(circle.c)} vs damper ${JSON.stringify(want)}`);
  const text = parts(s.doc).find((e) => e.type === 'MTEXT' && markupData(e).no === 1);
  const srcText = parts(src).find((e) => e.type === 'MTEXT' && markupData(e).no === 1);
  assert.ok(Math.abs(text.rot - 90) < 1e-9 && Math.abs(text.height - srcText.height) < 1e-12);
  // the pick-points fallback gives the same matrix from two point pairs
  const p = pointsTransform([[DAMPER, want], [{ x: 0, y: 0 }, apply(M, { x: 0, y: 0 })]]);
  p.forEach((v, i) => assert.ok(Math.abs(v - M[i]) < 1e-9));
});

test("only 'open' skips a Closed markup and a code-A markup", () => {
  const src = rev00(), s = rev01();
  const r = importMarkups(s, src, { only: 'open' });
  assert.deepEqual([r.imported, r.skippedClosed], [1, 2]);
  assert.deepEqual(listMarkups(s.doc).map((m) => m.no), [1]);
});

test('a second import skips every markup as a duplicate and adds nothing', () => {
  const src = rev00(), s = rev01();
  importMarkups(s, src);
  const n = s.doc.entities.length, steps = s.undoStack.length;
  const r = importMarkups(s, src);
  assert.deepEqual([r.imported, r.skippedDuplicate], [0, 3]);
  assert.equal(s.doc.entities.length, n);
  assert.equal(s.undoStack.length, steps, 'nothing imported: no undo step');
});

test('a number held by a different target markup is kept and reported', () => {
  const src = rev00(), s = rev01();
  addMarkup(s, 'circle', { c: { x: 5, y: 5 }, r: 2 }, { ...meta, comment: 'Rev.01 own comment', no: 2 });
  const r = importMarkups(s, src);
  assert.deepEqual(r.numberCollisions, [2]);
  assert.deepEqual(listMarkups(s.doc).map((m) => m.no), [1, 2, 2, 3]);
});

test('undo removes every imported part, the layer and the linetype in one step; redo puts them back', () => {
  const src = rev00(), s = rev01();
  const before = s.doc.entities.length, steps = s.undoStack.length;
  importMarkups(s, src);
  assert.equal(s.undoStack.length, steps + 1);
  assert.equal(s.undoLabel, 'Import markups');
  s.undo();
  assert.equal(s.doc.entities.length, before);
  assert.equal(parts(s.doc).length, 0);
  assert.ok(!s.doc.layers.has(MARKUP_LAYER) && !s.doc.linetypes.has('DASHED'));
  s.redo();
  assert.equal(listMarkups(s.doc).length, 3);
});

test("an alignment below the quality threshold gives method 'none' and the identity", () => {
  const src = rev00();
  const other = [];
  for (let i = 0; i < 20; i++) other.push(makeLine({ x: i * 37.3, y: i * i * 1.7 }, { x: i * 37.3 + 11.1 + i, y: i * i * 1.7 + 5.3 * i + 2 }));
  const a = alignForImport(src, docOf(other));
  assert.equal(a.method, 'none');
  assert.ok(a.quality < IMPORT_MIN_QUALITY, `quality ${a.quality}`);
  assert.deepEqual(a.transform, [1, 0, 0, 1, 0, 0]);
});

test('paper-space markups go to the same-named layout; a layout the target lacks is skipped and counted', () => {
  const src = rev00(), s = rev01();
  const ps = new Session(newDocument());
  addMarkup(ps, 'circle', { c: { x: 10, y: 10 }, r: 3 }, { ...meta, comment: 'Title block' });
  addMarkup(ps, 'circle', { c: { x: 20, y: 10 }, r: 3 }, { ...meta, comment: 'Other sheet' });
  const [p1, p2] = ps.doc.entities.reduce((g, e) => { g[markupData(e).no - 1].push(e); return g; }, [[], []]);
  src.layouts = [{ name: 'Layout1', entities: p1 }, { name: 'Sheet9', entities: p2 }];
  s.doc.layouts = [{ name: 'LAYOUT1', entities: [] }];
  const r = importMarkups(s, src, { transform: M });
  assert.deepEqual([r.imported, r.skippedNoLayout], [4, 1]);
  assert.deepEqual(s.doc.layouts[0].entities.map(strip), p1.map(strip), 'paper space is not transformed');
  s.undo();
  assert.equal(s.doc.layouts[0].entities.length, 0);
});

test('writeDxf/parseDxf keeps the imported markups; ezdxf audit clean', { skip: !ezdxfAvailable() && 'ezdxf not installed' }, (t) => {
  const src = rev00(), s = rev01(M);
  importMarkups(s, src, { transform: alignForImport(src, s.doc).transform });
  const text = writeDxf(s.doc);
  const back = parseDxf(text);
  const data = (d) => parts(d).map((e) => markupData(e));
  assert.deepEqual(data(back), data(s.doc));
  const dir = mkdtempSync(path.join(tmpdir(), 'ashmkimport-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rev01.dxf');
  writeFileSync(file, text);
  const audit = validateWithEzdxf(file);
  assert.equal(audit.audit_errors, 0, JSON.stringify(audit.audit_messages));
});
