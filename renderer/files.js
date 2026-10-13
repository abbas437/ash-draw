// ASH Draw Studio - opening, saving and exporting drawings.
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { compareDocuments } from '../src/core/verify.js';
import { exportSvg } from '../src/core/exportSvg.js';
import { exportPdf } from '../src/core/exportPdf.js';
import { buildScene, buildSceneSteps, drawScene, fitView } from '../src/core/render.js';
import { SpatialIndex } from '../src/core/pick.js';
import { runSliced } from '../src/core/slice.js';
import { docAssembler } from '../src/core/docBatches.js';

export const OPEN_FILTERS = [
  { name: 'Drawings (DWG, DXF)', extensions: ['dwg', 'dxf'] },
  { name: 'AutoCAD DWG', extensions: ['dwg'] },
  { name: 'AutoCAD DXF', extensions: ['dxf'] },
];

const enc = new TextEncoder();
/** part of the main process's "install the ODA File Converter" message (electron/odaConverter.js ODA_HINT) */
export const ODA_HINT_MARK = 'Install the free ODA File Converter';
export const extOf = (name) => (/\.([^.\\/]+)$/.exec(name || '') || [, ''])[1].toLowerCase();
/** default path for a Save dialog: the open file's folder + `fileName`; just `fileName` for a drawing without a path on disk */
export function savePathIn(filePath, fileName) {
  const m = typeof filePath === 'string' ? /^(.*[\\/])[^\\/]*$/.exec(filePath) : null;
  return m && m[1] ? m[1] + fileName : fileName;
}
export const baseName = (name) => String(name || 'drawing').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');

/** INSUNITS -> drawing units per millimetre (unitless drawings are assumed to be millimetres) */
export function unitsPerMm(doc) {
  return ({ 1: 1 / 25.4, 2: 1 / 304.8, 4: 1, 5: 10, 6: 1000, 7: 1e6, 8: 1 / 0.0254, 10: 914.4, 13: 0.001 })[doc.units] ?? 1;
}
export const UNIT_NAMES = { 0: 'unitless', 1: 'inches', 2: 'feet', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 13: 'microns' };

/** Read DXF bytes in a module worker (the window stays responsive), or synchronously where there is no Worker.
 *  onProgress(fraction 0..1); `signal` (AbortSignal) stops the worker and rejects with Error{code:'CANCELLED'}.
 *  A whole, unshared buffer is transferred to the worker (the caller's `bytes` are detached afterwards).
 *  `bytes` may instead be {url}: the worker fetches the DXF (a converted DWG, electron/main.js dwg:open). */
export function readDxfAsync(bytes, { onProgress = null, signal = null } = {}) {
  const cancelled = () => Object.assign(new Error('Opening was cancelled.'), { code: 'CANCELLED' });
  if (signal?.aborted) return Promise.reject(cancelled());
  if (typeof Worker === 'undefined') {
    return (bytes.url ? fetch(bytes.url).then(async (r) => { if (!r.ok) throw new Error('The converted drawing is no longer available; open the file again.'); return new Uint8Array(await r.arrayBuffer()); }) : Promise.resolve(bytes)).then((b) => readDxf(b, { onProgress }));
  }
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./dxfWorker.js', import.meta.url), { type: 'module', name: 'dxf-reader' });
    const finish = () => { w.terminate(); signal?.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(cancelled()); };
    signal?.addEventListener('abort', abort);
    // the reader's progress is shown as 0..90 %, the document arriving in batches (docBatches.js) as 90..100 %
    const asm = docAssembler();
    let shown = -1;
    w.onmessage = ({ data }) => {
      if (data.progress !== undefined) { onProgress?.((0.9 * data.progress) / 100); return; }
      if (asm.accept(data)) { const p = Math.floor(100 * asm.fraction); if (p !== shown) { shown = p; onProgress?.(0.9 + 0.1 * asm.fraction); } return; }
      finish();
      if (data.error) reject(Object.assign(new Error(data.error.message), data.error.code ? { code: data.error.code } : {}));
      else resolve(asm.doc);
    };
    w.onerror = (e) => { finish(); reject(new Error(`The DXF reader stopped: ${e.message || 'worker error'}`)); };
    if (bytes.url) { w.postMessage({ url: bytes.url }); return; }
    const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && !(typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer);
    const view = whole ? bytes : bytes.slice();
    w.postMessage({ bytes: view }, [view.buffer]);
  });
}

/** Build the scene and the spatial index of a just-read drawing in time slices (the window keeps repainting).
 *  onProgress(fraction): scene 0..1/3, index 1/3..1 (the index takes about twice as long); `signal` cancels
 *  (rejects with Error{code:'CANCELLED'}). Returns {scene, index} for App.installDoc. */
export async function prepareView(doc, { signal = null, onProgress = null } = {}) {
  const scene = await runSliced(buildSceneSteps(doc), { signal, onProgress: onProgress && ((f) => onProgress(f / 3)) });
  const index = new SpatialIndex(doc, { deferred: true });
  await runSliced(index.rebuildSteps(), { signal, onProgress: onProgress && ((f) => onProgress((1 + 2 * f) / 3)) });
  return { scene, index };
}

/** objects a drawing shows: model space plus layout (paper space) objects; layout viewports alone do not count */
export const objectsRead = (doc) => doc.entities.length + (doc.layouts ?? []).reduce((n, l) => n + (l.entities ?? []).filter((e) => e.type !== 'VIEWPORT').length, 0);
export const EMPTY_DWG_MIN = 100 * 1024;
/** A DWG over 100 KB whose conversion reads as no objects at all is a failed conversion, not an empty drawing. */
export const isEmptyConversion = (dwgSize, doc) => dwgSize > EMPTY_DWG_MIN && objectsRead(doc) === 0;

const plural = (n, w) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
/** Status-bar item for a DWG's last conversion ({converter, errorCount, objects, skipped}): short text + tooltip. */
export function conversionSummary(c) {
  const name = c.converter === 'ODA' ? 'ODA File Converter' : 'LibreDWG';
  const errs = c.errorCount ? plural(c.errorCount, 'converter error') : 'no converter errors';
  const sk = Object.entries(c.skipped ?? {});
  return {
    text: c.converter === 'ODA' ? name : `${name} · ${errs}`,
    title: [`Converted from DWG with ${name}.`, `Objects read: ${c.objects.toLocaleString('en-US')}.`,
      `Object types not shown: ${sk.length ? sk.map(([k, v]) => `${v.toLocaleString('en-US')} ${k}`).join(', ') : 'none'}.`,
      c.converter === 'ODA' ? null : `Converter errors: ${c.errorCount.toLocaleString('en-US')}.`, 'Click for the converter log.'].filter(Boolean).join('\n'),
  };
}

/** Load a DWG/DXF. Returns {doc, format, notes[], warnings, conversion}; throws Error with a user-readable message.
 *  conversion (DWG only): {converter: 'LibreDWG'|'ODA', errorCount, log, objects, skipped} of this open.
 *  opts: {onProgress(fraction), signal} for the DXF read (see readDxfAsync); `path`: the granted file, which a DWG
 *  is then converted from without its bytes passing through the window (`bytes` may be null for a .dwg path). */
export async function loadDrawing(api, name, bytes, { onProgress = null, signal = null, path = null } = {}) {
  const ext = extOf(name);
  let dxfBytes = bytes, format = 'dxf';
  const notes = [];
  let warnings = [];
  let conv = null;
  if (ext === 'dwg' || (bytes && looksLikeDwg(bytes))) {
    format = 'dwg';
    if (!api.isElectron) throw new Error('Opening DWG files needs the desktop app (it includes the free LibreDWG converter). In this browser preview, please open a DXF file.');
    const av = await api.dwgAvailable();
    if (!av.available) throw new Error(`The DWG converter is not available: ${av.reason ?? 'unknown reason'}. DXF files can still be opened.`);
    try {
      // dwg:open hands the DXF back as a URL the reader worker fetches (no big clone on this thread)
      const res = api.dwgOpen ? await api.dwgOpen(path ?? bytes) : await api.dwgToDxf(bytes);
      dxfBytes = res.url ? { url: res.url } : res.dxfBytes;
      warnings = Array.isArray(res.warnings) ? res.warnings : [];
      conv = { converter: res.converter === 'ODA' || res.engine === 'oda' ? 'ODA' : 'LibreDWG', errorCount: res.errorCount ?? 0, log: res.log ?? '', dwgSize: res.dwgSize ?? bytes?.byteLength ?? 0,
        dwgHeader: typeof res.header === 'string' ? res.header : bytes ? String.fromCharCode(...bytes.subarray(0, 6)) : '' };
    } catch (err) {
      const m = String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
      if (m.includes(ODA_HINT_MARK)) throw Object.assign(new Error(m), { odaHint: true });
      throw new Error(`${/^This DWG file could not be converted/.test(m) ? m.split('\n')[0] : `This DWG file could not be converted (${m.split('\n')[0]}).`} Try opening it in your CAD program and saving it as DXF.`);
    }
  } else if (ext !== 'dxf' && ext !== '') {
    throw new Error(`Unsupported file type ".${ext}". Open a DWG or DXF file.`);
  }
  let doc;
  try { doc = await readDxfAsync(dxfBytes, { onProgress, signal }); } catch (err) {
    if (dxfBytes?.url) api.dwgRelease?.(dxfBytes.url)?.catch?.(() => {}); // cancelled/failed before the fetch: free it in main
    if (err.code === 'BINARY_DXF') throw new Error('This is a binary DXF file, which is not supported. Save it as an ASCII DXF, or open the DWG instead.');
    if (err.code === 'BAD_DXF') throw new Error('This file is not a valid DXF drawing.');
    throw err;
  }
  if (conv && isEmptyConversion(conv.dwgSize, doc)) {
    const kb = conv.dwgSize >= 1048576 ? `${(conv.dwgSize / 1048576).toFixed(1)} MB` : `${Math.round(conv.dwgSize / 1024)} KB`;
    const name = conv.converter === 'ODA' ? 'The ODA File Converter' : 'The built-in converter';
    const errs = conv.errorCount ? ` and reported ${plural(conv.errorCount, 'error')}` : '';
    const hint = conv.converter === 'ODA' ? ' Try opening it in your CAD program and saving it as DXF.' : ` ${ODA_HINT_MARK} (opendesign.com) and ASH Draw Studio will use it automatically.`;
    const log = conv.log.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20).join('\n').replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')'));
    throw Object.assign(new Error(`${name} produced an incomplete drawing from this DWG: the ${kb} file read as a drawing with no objects${errs}. It was not opened, so that you do not work on a drawing with missing objects.${hint}${log && conv.converter !== 'ODA' ? ` [${log}]` : ''}`), { odaHint: conv.converter !== 'ODA' });
  }
  if (warnings.length) notes.push('The DWG file has checksum/format errors (reported by the converter); the drawing was recovered — check it before relying on it.');
  const rep = doc.header?.repairedValues;
  if (rep) notes.push(`${rep} damaged text value${rep === 1 ? ' was' : 's were'} repaired (split over several lines in the file).`);
  const sk = Object.entries(doc.skipped || {});
  const ole = [doc.entities, ...[...doc.blocks.values()].map((b) => b.entities)].reduce((n, l) => n + l.filter((x) => x.type === 'OLE2FRAME').length, 0);
  if (ole) notes.push(`${ole} OLE object${ole === 1 ? '' : 's'} shown as frames (content not displayed).`);
  if (sk.length) notes.push(`Not displayed (unsupported object types): ${sk.map(([k, v]) => `${v} ${k}`).join(', ')}.`);
  const conversion = conv && { converter: conv.converter, errorCount: conv.errorCount, log: conv.log, objects: objectsRead(doc), skipped: { ...(doc.skipped || {}) }, dwgHeader: conv.dwgHeader };
  return { doc, format, notes, warnings, conversion };
}
function looksLikeDwg(b) { return b.length > 6 && b[0] === 0x41 && b[1] === 0x43 && b[2] === 0x31 && b[3] >= 0x30 && b[3] <= 0x39; } // "AC10.."

export function dxfBytesOf(doc, opts) { return enc.encode(writeDxf(doc, opts)); }

/** Write the document as DXF. path === null opens the save dialog. */
export async function saveDxf(api, doc, { path, name, fromPath = null }) {
  const bytes = dxfBytesOf(doc);
  const res = path ? await api.writeFile(path, bytes) : await api.saveFile({ defaultPath: savePathIn(fromPath, `${baseName(name)}.dxf`), filters: [{ name: 'AutoCAD DXF', extensions: ['dxf'] }], bytes });
  if (!res) return null;
  return { path: res.path ?? null, report: doc.lastWriteReport, backup: res.backup ?? null };
}

/** DWG versions written by the ODA File Converter ('acad2018', ...); 'r2000'/'r14' are LibreDWG's */
export const isOdaDwgVersion = (v) => /^acad\d{4}$/.test(String(v));

/** Write the document as DWG and verify it by reading the result back.
 *  ODA versions ('acad2018', ...) get the full DXF (real dimensions); LibreDWG ('r2000', 'r14') gets dimensions as
 *  geometry. `path`: overwrite this granted file (Save); null opens the save dialog (Save as).
 *  `confirmDifferences(verification)` is asked (when the read-back differs) BEFORE anything is written; return false to abort. */
export async function saveDwg(api, doc, { name, fromPath = null, version = 'r2000', path = null, confirmDifferences }) {
  if (!api.isElectron) throw new Error('Saving DWG needs the desktop app.');
  const av = await api.dwgAvailable();
  if (!av.available) throw new Error(`The DWG converter is not available: ${av.reason ?? 'unknown reason'}.`);
  const dxf = isOdaDwgVersion(version) ? dxfBytesOf(doc) : dxfBytesOf(doc, { dimensionsAsGeometry: true });
  const { dwgBytes } = await api.dxfToDwg(dxf, version);
  // verification.converter: which converter read the DWG back ('ODA' | 'LibreDWG'; null when the read-back failed)
  let verification;
  try {
    const res = await api.dwgToDxf(dwgBytes);
    const converter = res.converter === 'ODA' || res.engine === 'oda' ? 'ODA' : 'LibreDWG';
    verification = { ...compareDocuments(doc, readDxf(res.dxfBytes)), converter };
  } catch (err) { verification = { ok: false, error: String(err.message || err), converter: null }; }
  if (!verification.ok && confirmDifferences && !(await confirmDifferences(verification))) return null;
  const res = path ? await api.writeFile(path, dwgBytes) : await api.saveFile({ defaultPath: savePathIn(fromPath, `${baseName(name)}.dwg`), filters: [{ name: 'AutoCAD DWG', extensions: ['dwg'] }], bytes: dwgBytes });
  if (!res) return null;
  return { path: res.path ?? path ?? null, verification, readBack: verification.converter, report: doc.lastWriteReport, version, backup: res.backup ?? null };
}

/** `oda`: the DWG was written by the ODA File Converter; the read-back converter is `v.converter` (from saveDwg) */
export function verificationMessage(v, { oda = false } = {}) {
  if (v.error) return `The DWG was written, but it could not be read back to check it (${v.error}). Please open it in your CAD program to confirm, or save as DXF.`;
  if (v.ok) return 'The saved DWG was read back and matches the drawing.';
  const bad = Object.keys(v.mismatched || {});
  const reader = v.converter === 'LibreDWG' ? 'the built-in LibreDWG converter' : 'the ODA File Converter';
  if (oda) return `The saved DWG, read back through ${reader}, differs from your drawing for: ${bad.join(', ') || 'some objects'}. Open it in your CAD program to check those objects, or save as DXF.`;
  return `The saved DWG differs from your drawing for: ${bad.join(', ') || 'some objects'}. DWG writing is experimental (text rotation and some hatch edges can be lost). Saving as DXF is lossless for everything this program supports.`;
}

export async function exportSvgBytes(doc, scene, opts = {}) {
  return enc.encode(exportSvg(doc, { scene, unitsPerMm: unitsPerMm(doc), monochrome: !!opts.monochrome, background: opts.background ?? '#ffffff' }));
}
export async function exportPdfBytes(doc, scene, opts = {}) {
  return exportPdf(doc, { scene, pageSize: opts.pageSize ?? 'A3', orientation: opts.orientation ?? 'auto', margin: opts.margin ?? 10, monochrome: !!opts.monochrome, lineweights: opts.lineweights !== false, scale: opts.scale ?? null, region: opts.region ?? null, centre: opts.centre !== false, unicodeFont: opts.unicodeFont ?? null, layout: opts.layout ?? null, modelScene: opts.modelScene ?? null, transparency: opts.transparency !== false });
}
export async function exportPngBytes(doc, scene, { longSide = 3000, dark = false, lineweights = true } = {}) {
  const b = scene.bbox ?? { minx: 0, miny: 0, maxx: 1, maxy: 1 };
  const w = Math.max(b.maxx - b.minx, 1e-9), h = Math.max(b.maxy - b.miny, 1e-9);
  const W = w >= h ? longSide : Math.max(16, Math.round((longSide * w) / h)), H = w >= h ? Math.max(16, Math.round((longSide * h) / w)) : longSide;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  drawScene(cv.getContext('2d'), scene, fitView(scene.bbox, W, H, 0.02), { background: dark ? '#1b1f23' : '#ffffff', showLineweight: lineweights, pixelsPerMm: W / 420 });
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export { buildScene };
