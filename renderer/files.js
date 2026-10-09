// ASH Draw Studio - opening, saving and exporting drawings.
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { compareDocuments } from '../src/core/verify.js';
import { exportSvg } from '../src/core/exportSvg.js';
import { exportPdf } from '../src/core/exportPdf.js';
import { buildScene, drawScene, fitView } from '../src/core/render.js';

export const OPEN_FILTERS = [
  { name: 'Drawings (DWG, DXF)', extensions: ['dwg', 'dxf'] },
  { name: 'AutoCAD DWG', extensions: ['dwg'] },
  { name: 'AutoCAD DXF', extensions: ['dxf'] },
];

const enc = new TextEncoder();
/** part of the main process's "install the ODA File Converter" message (electron/odaConverter.js ODA_HINT) */
export const ODA_HINT_MARK = 'Install the free ODA File Converter';
export const extOf = (name) => (/\.([^.\\/]+)$/.exec(name || '') || [, ''])[1].toLowerCase();
export const baseName = (name) => String(name || 'drawing').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');

/** INSUNITS -> drawing units per millimetre (unitless drawings are assumed to be millimetres) */
export function unitsPerMm(doc) {
  return ({ 1: 1 / 25.4, 2: 1 / 304.8, 4: 1, 5: 10, 6: 1000, 7: 1e6, 8: 1 / 0.0254, 10: 914.4, 13: 0.001 })[doc.units] ?? 1;
}
export const UNIT_NAMES = { 0: 'unitless', 1: 'inches', 2: 'feet', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 13: 'microns' };

/** Read DXF bytes in a module worker (the window stays responsive), or synchronously where there is no Worker.
 *  onProgress(fraction 0..1); `signal` (AbortSignal) stops the worker and rejects with Error{code:'CANCELLED'}.
 *  A whole, unshared buffer is transferred to the worker (the caller's `bytes` are detached afterwards). */
export function readDxfAsync(bytes, { onProgress = null, signal = null } = {}) {
  const cancelled = () => Object.assign(new Error('Opening was cancelled.'), { code: 'CANCELLED' });
  if (signal?.aborted) return Promise.reject(cancelled());
  if (typeof Worker === 'undefined') return Promise.resolve().then(() => readDxf(bytes, { onProgress }));
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./dxfWorker.js', import.meta.url), { type: 'module', name: 'dxf-reader' });
    const finish = () => { w.terminate(); signal?.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(cancelled()); };
    signal?.addEventListener('abort', abort);
    w.onmessage = ({ data }) => {
      if (data.progress !== undefined) { onProgress?.(data.progress / 100); return; }
      finish();
      if (data.error) reject(Object.assign(new Error(data.error.message), data.error.code ? { code: data.error.code } : {}));
      else resolve(data.doc);
    };
    w.onerror = (e) => { finish(); reject(new Error(`The DXF reader stopped: ${e.message || 'worker error'}`)); };
    const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && !(typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer);
    const view = whole ? bytes : bytes.slice();
    w.postMessage({ bytes: view }, [view.buffer]);
  });
}

/** Load a DWG/DXF. Returns {doc, format, notes[]}; throws Error with a user-readable message.
 *  opts: {onProgress(fraction), signal} for the DXF read (see readDxfAsync). */
export async function loadDrawing(api, name, bytes, { onProgress = null, signal = null } = {}) {
  const ext = extOf(name);
  let dxfBytes = bytes, format = 'dxf';
  const notes = [];
  let warnings = [];
  if (ext === 'dwg' || looksLikeDwg(bytes)) {
    format = 'dwg';
    if (!api.isElectron) throw new Error('Opening DWG files needs the desktop app (it includes the free LibreDWG converter). In this browser preview, please open a DXF file.');
    const av = await api.dwgAvailable();
    if (!av.available) throw new Error(`The DWG converter is not available: ${av.reason ?? 'unknown reason'}. DXF files can still be opened.`);
    try {
      const res = await api.dwgToDxf(bytes);
      dxfBytes = res.dxfBytes;
      warnings = Array.isArray(res.warnings) ? res.warnings : [];
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
    if (err.code === 'BINARY_DXF') throw new Error('This is a binary DXF file, which is not supported. Save it as an ASCII DXF, or open the DWG instead.');
    if (err.code === 'BAD_DXF') throw new Error('This file is not a valid DXF drawing.');
    throw err;
  }
  if (warnings.length) notes.push('The DWG file has checksum/format errors (reported by the converter); the drawing was recovered — check it before relying on it.');
  const rep = doc.header?.repairedValues;
  if (rep) notes.push(`${rep} damaged text value${rep === 1 ? ' was' : 's were'} repaired (split over several lines in the file).`);
  const sk = Object.entries(doc.skipped || {});
  if (sk.length) notes.push(`Not displayed (unsupported object types): ${sk.map(([k, v]) => `${v} ${k}`).join(', ')}.`);
  return { doc, format, notes, warnings };
}
function looksLikeDwg(b) { return b.length > 6 && b[0] === 0x41 && b[1] === 0x43 && b[2] === 0x31 && b[3] >= 0x30 && b[3] <= 0x39; } // "AC10.."

export function dxfBytesOf(doc, opts) { return enc.encode(writeDxf(doc, opts)); }

/** Write the document as DXF. path === null opens the save dialog. */
export async function saveDxf(api, doc, { path, name }) {
  const bytes = dxfBytesOf(doc);
  const res = path ? await api.writeFile(path, bytes) : await api.saveFile({ defaultPath: `${baseName(name)}.dxf`, filters: [{ name: 'AutoCAD DXF', extensions: ['dxf'] }], bytes });
  if (!res) return null;
  return { path: res.path ?? null, report: doc.lastWriteReport };
}

/** Write the document as DWG through LibreDWG and verify it by reading the result back. */
/** `confirmDifferences(verification)` is asked (when the read-back differs) BEFORE the save dialog; return false to abort. */
export async function saveDwg(api, doc, { name, version = 'r2000', confirmDifferences }) {
  if (!api.isElectron) throw new Error('Saving DWG needs the desktop app.');
  const av = await api.dwgAvailable();
  if (!av.available) throw new Error(`The DWG converter is not available: ${av.reason ?? 'unknown reason'}.`);
  const dxf = dxfBytesOf(doc, { dimensionsAsGeometry: true });
  const { dwgBytes } = await api.dxfToDwg(dxf, version);
  let verification;
  try {
    const back = readDxf((await api.dwgToDxf(dwgBytes)).dxfBytes);
    verification = compareDocuments(doc, back);
  } catch (err) { verification = { ok: false, error: String(err.message || err) }; }
  if (!verification.ok && confirmDifferences && !(await confirmDifferences(verification))) return null;
  const res = await api.saveFile({ defaultPath: `${baseName(name)}.dwg`, filters: [{ name: 'AutoCAD DWG', extensions: ['dwg'] }], bytes: dwgBytes });
  if (!res) return null;
  return { path: res.path ?? null, verification, report: doc.lastWriteReport };
}

export function verificationMessage(v) {
  if (v.error) return `The DWG was written, but it could not be read back to check it (${v.error}). Please open it in your CAD program to confirm, or save as DXF.`;
  if (v.ok) return 'The saved DWG was read back and matches the drawing.';
  const bad = Object.keys(v.mismatched || {});
  return `The saved DWG differs from your drawing for: ${bad.join(', ') || 'some objects'}. DWG writing is experimental (text rotation and some hatch edges can be lost). Saving as DXF is lossless for everything this program supports.`;
}

export async function exportSvgBytes(doc, scene, opts = {}) {
  return enc.encode(exportSvg(doc, { scene, unitsPerMm: unitsPerMm(doc), monochrome: !!opts.monochrome, background: opts.background ?? '#ffffff' }));
}
export async function exportPdfBytes(doc, scene, opts = {}) {
  return exportPdf(doc, { scene, pageSize: opts.pageSize ?? 'A3', orientation: opts.orientation ?? 'auto', margin: opts.margin ?? 10, monochrome: !!opts.monochrome, lineweights: opts.lineweights !== false, scale: opts.scale ?? null, region: opts.region ?? null, centre: opts.centre !== false, unicodeFont: opts.unicodeFont ?? null, layout: opts.layout ?? null, modelScene: opts.modelScene ?? null });
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
