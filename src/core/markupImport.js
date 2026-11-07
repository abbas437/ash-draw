// ASH Draw Studio - import review markups from the previous revision of a drawing (Rev.00 -> Rev.01).
// Pure ES module (no DOM). The source drawing's markups (src/core/markup.js: parts on layer ASH-MARKUP sharing the uid of
// their ASH_MARKUP XDATA) are copied onto the target at the same place relative to the drawing content:
//
//   const a = alignForImport(rev00, rev01.doc);               // { transform, quality, method: 'auto' | 'none' }
//   const t = a.method === 'auto' ? a.transform : pointsTransform([[a1, b1], [a2, b2]]); // or pick points
//   importMarkups(session, rev00, { transform: t, only: 'open' }); // one undo step
//
// Alignment reuses compare.js: compareSteps with align 'auto' (estimateTransform's quarter-turn + translation voting,
// bounded by its MAX_KEY_PAIRS / MAX_VOTES limits) on both drawings without their markups, and alignQuality ("% of A
// unchanged") of that compare as the quality. alignForImportSteps is the step generator for runSliced on big drawings.
// Paper space: a layout's markups go to the target layout of the same name (any case), untransformed (the sheet does
// not move with the model); a layout the target lacks is skipped and counted (skippedNoLayout, in markups).
import { compareSteps, alignQuality, transformFromPoints, defaultTolerance } from './compare.js';
import { transformEntity, IDENTITY, det } from './geom.js';
import { drain } from './slice.js';
import { addLinetype, newDocument } from './model.js';
import { markupData, MARKUP_LAYER, MARKUP_LINETYPE, MARKUP_STATUSES } from './markup.js';

/** an alignment below this share of the source unchanged (compare's 'good' boundary in alignQuality) is not trusted */
export const IMPORT_MIN_QUALITY = 50;

const U = (s) => String(s ?? '').toUpperCase();
const isMarkupPart = (e) => U(e.layer) === MARKUP_LAYER || !!markupData(e);
/** the drawing seen without its markups (layers, blocks ... shared) */
const withoutMarkups = (doc) => Object.create(doc, { entities: { value: doc.entities.filter((e) => !isMarkupPart(e)) } });

/**
 * step generator behind alignForImport (same arguments and result), for runSliced; yields progress 0..1
 */
export function* alignForImportSteps(sourceDoc, targetDoc, opts = {}) {
  const min = opts.minQuality ?? IMPORT_MIN_QUALITY;
  const tol = opts.tol ?? defaultTolerance(targetDoc.units || sourceDoc.units);
  const a = withoutMarkups(sourceDoc), b = withoutMarkups(targetDoc);
  if (!a.entities.length || !b.entities.length) return { transform: [...IDENTITY], quality: 0, method: 'none' };
  const r = yield* compareSteps(a, b, { tol, align: 'auto', piecewise: false, rotations: opts.rotations, ignoreLayers: [MARKUP_LAYER] });
  const quality = alignQuality(r).pct;
  if (!r.offset?.votes || quality < min) return { transform: [...IDENTITY], quality, method: 'none' };
  return { transform: [...r.offset.m], quality, method: 'auto' };
}

/**
 * The transform from the source drawing's content to the target's (rotation by quarter turns + translation), estimated
 * as COMPARE align 'auto' does, markups (layer ASH-MARKUP or ASH_MARKUP XDATA) left out on both sides.
 * opts: tol (default 1 mm in the target's units), minQuality (default IMPORT_MIN_QUALITY %), rotations.
 * Returns { transform: geom.js matrix, quality: whole % of the source unchanged under it, method: 'auto' | 'none' }
 * ('none': no estimate, or quality below minQuality; transform is then the identity).
 */
export function alignForImport(sourceDoc, targetDoc, opts = {}) {
  return drain(alignForImportSteps(sourceDoc, targetDoc, opts));
}

/** pick-points fallback: pairs [[source point, target point], (optional second pair)] -> geom.js matrix */
export function pointsTransform(pairs) {
  const [[a1, b1], [a2, b2] = []] = pairs;
  return transformFromPoints(a1, a2 ?? null, b1, b2 ?? null);
}

/** markups of one entity list: Map(uid -> { data (the shape's, else the text's, else the first part's), parts }) */
function markupsOf(ents) {
  const by = new Map();
  for (const e of ents) {
    const d = markupData(e);
    if (!d) continue;
    let m = by.get(d.uid);
    if (!m) by.set(d.uid, (m = { data: d, parts: [] }));
    if (d.role === 'shape' || (d.role === 'text' && m.data.role !== 'shape')) m.data = d;
    m.parts.push(e);
  }
  return by;
}

/** a markup the review has finished with: latest status Closed, or review code A */
const isClosed = (d) => d.status === MARKUP_STATUSES[2] || d.code === 'A';

/**
 * Copy the source drawing's markups into the target as one undo step ('Import markups'). target: a Session (edit.js),
 * which may show a layout (its doc a space doc: model space is still the drawing's). opts: transform (geom.js matrix
 * for model-space markups, default identity), only 'all' | 'open' (skip a markup whose status is Closed or code A),
 * space 'model' | 'all' (default: model space and every layout).
 * Every part is copied (geometry transformed, MTEXT position / rotation / height and the dash scale with it; XDATA
 * verbatim) with a fresh id and no source handle; the ASH-MARKUP layer and DASHED linetype are made as markup.js makes
 * them when missing. A uid already in the target is skipped; a number another target markup already has is kept and
 * reported. Returns { imported, skippedClosed, skippedDuplicate, skippedNoLayout, numberCollisions: [no ...] } (markups).
 */
export function importMarkups(s, sourceDoc, { transform = IDENTITY, only = 'all', space = 'all' } = {}) {
  const root = s.doc.modelDoc ?? s.doc;
  const res = { imported: 0, skippedClosed: 0, skippedDuplicate: 0, skippedNoLayout: 0, numberCollisions: [] };
  const targetLayouts = root.layouts ?? [];
  const lists = [root.entities, ...targetLayouts.map((l) => l.entities ?? [])];
  const uids = new Set(), nos = new Set();
  for (const l of lists) for (const [uid, m] of markupsOf(l)) { uids.add(uid); nos.add(m.data.no); }
  const spaces = [{ ents: sourceDoc.entities, owner: root, m: transform }];
  if (space !== 'model') {
    for (const lo of sourceDoc.layouts ?? []) {
      const to = targetLayouts.find((l) => U(l.name) === U(lo.name)) ?? null;
      spaces.push({ ents: lo.entities ?? [], owner: to, m: IDENTITY });
    }
  }
  const scale = Math.sqrt(Math.abs(det(transform)));
  const plan = []; // [{ owner, parts: [copies] }]
  for (const sp of spaces) {
    const out = [];
    for (const [uid, mk] of markupsOf(sp.ents)) {
      if (only === 'open' && isClosed(mk.data)) { res.skippedClosed++; continue; }
      if (uids.has(uid)) { res.skippedDuplicate++; continue; }
      if (!sp.owner) { res.skippedNoLayout++; continue; }
      const ident = sp.m === IDENTITY || sp.m.every((v, i) => v === IDENTITY[i]);
      for (const e of mk.parts) {
        const c = ident ? structuredClone(e) : transformEntity(e, sp.m);
        if (!ident && sp.m === transform && c.ltscale && scale !== 1) c.ltscale *= scale;
        c.xdata = structuredClone(e.xdata);
        c.id = 0; delete c.handle; delete c.parent;
        out.push(c);
      }
      uids.add(uid);
      if (nos.has(mk.data.no)) res.numberCollisions.push(mk.data.no); else nos.add(mk.data.no);
      res.imported++;
    }
    if (out.length) plan.push({ owner: sp.owner, parts: out });
  }
  if (!plan.length) return res;
  s.transact('Import markups', (tx) => {
    // as markup.js ensureMarkupLayer, but the linetype too is part of this undo step
    if (!root.linetypes.has(MARKUP_LINETYPE)) {
      const lt = addLinetype(newDocument(), { name: MARKUP_LINETYPE, description: 'Dashed __ __ __ __', pattern: [0.5, -0.25] });
      tx.set(root.linetypes, MARKUP_LINETYPE, lt);
    }
    if (!root.layers.has(MARKUP_LAYER)) tx.layer(MARKUP_LAYER, { color: 1, linetype: MARKUP_LINETYPE, plot: true });
    for (const { owner, parts } of plan) {
      if (owner === root && s.doc === root) { for (const c of parts) tx.add(c); continue; }
      // another space's list (a layout, or model space while the session shows a layout): one undoable list change
      for (const c of parts) c.id = root.nextId++;
      tx.set(owner, 'entities', [...(owner.entities ?? []), ...parts]);
    }
  });
  return res;
}
