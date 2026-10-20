import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { loadDrawing, isEmptyConversion, objectsRead, conversionSummary } from '../renderer/files.js';

// a DWG opened from a granted path: main converts it from the path (dwg:open) and hands the DXF back as a URL that
// the reader fetches; neither the DWG nor the DXF bytes go through the window's IPC
test('loadDrawing: a DWG path is converted by main and its DXF read from the returned URL', async () => {
  const dxf = fixture('basic_r2000.dxf');
  const calls = [];
  const api = {
    isElectron: true,
    dwgAvailable: async () => ({ available: true }),
    dwgOpen: async (src) => { calls.push(src); return { url: `data:application/octet-stream;base64,${Buffer.from(dxf).toString('base64')}`, warnings: [] }; },
    dwgToDxf: async () => { throw new Error('the DXF must not come back through dwg:toDxf'); },
  };
  const { doc, format } = await loadDrawing(api, 'plan.dwg', null, { path: '/drawings/plan.dwg' });
  assert.equal(format, 'dwg');
  assert.deepEqual(calls, ['/drawings/plan.dwg']);
  assert.ok(doc.entities.length > 0);
});

// cancelling while main converts: the hand-off is never fetched, so the window gives it back (dwg:release) instead of
// main holding the DXF until it expires
test('loadDrawing: a DWG open cancelled during conversion releases the hand-off', async () => {
  const ac = new AbortController();
  const released = [];
  const api = {
    isElectron: true,
    dwgAvailable: async () => ({ available: true }),
    dwgOpen: async () => { ac.abort(); return { url: 'app://drawstudio/_open/' + 'a'.repeat(48), warnings: [] }; },
    dwgRelease: async (url) => { released.push(url); },
  };
  await assert.rejects(loadDrawing(api, 'plan.dwg', null, { path: '/d/plan.dwg', signal: ac.signal }), { code: 'CANCELLED' });
  assert.deepEqual(released, ['app://drawstudio/_open/' + 'a'.repeat(48)]);
});

test('isEmptyConversion: a DWG over 100 KB that reads as no objects (layout viewports do not count) is a failed open', () => {
  const doc = (model, layout) => ({ entities: Array(model).fill({ type: 'LINE' }), layouts: [{ entities: [{ type: 'VIEWPORT' }, ...Array(layout).fill({ type: 'TEXT' })] }] });
  assert.equal(objectsRead(doc(2, 3)), 5);
  assert.equal(isEmptyConversion(121 * 1024 * 1024, doc(0, 0)), true);
  assert.equal(isEmptyConversion(101 * 1024, doc(0, 0)), true);
  assert.equal(isEmptyConversion(100 * 1024, doc(0, 0)), false, 'small DWGs can be empty drawings');
  assert.equal(isEmptyConversion(121 * 1024 * 1024, doc(0, 1)), false, 'paper-space objects count');
  assert.equal(isEmptyConversion(121 * 1024 * 1024, doc(1, 0)), false);
  assert.equal(isEmptyConversion(5e6, { entities: [] }), true, 'no layouts');
});

const EMPTY_DXF = '  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n';
const dataUrl = (s) => `data:application/octet-stream;base64,${Buffer.from(s).toString('base64')}`;
test('loadDrawing: a large DWG that converts to an empty drawing is refused with the ODA suggestion, never shown empty', async () => {
  const api = (res) => ({ isElectron: true, dwgAvailable: async () => ({ available: true }), dwgOpen: async () => ({ url: dataUrl(EMPTY_DXF), warnings: [], ...res }) });
  const err = await loadDrawing(api({ dwgSize: 121 * 1024 * 1024, errorCount: 5000, log: 'ERROR: [x]\n', converter: 'LibreDWG' }), 'big.dwg', null, { path: '/d/big.dwg' }).then(() => null, (e) => e);
  assert.ok(err);
  assert.equal(err.odaHint, true);
  assert.match(err.message, /^The built-in converter produced an incomplete drawing from this DWG: the 121\.0 MB file read as a drawing with no objects and reported 5,000 errors\./);
  assert.match(err.message, /Install the free ODA File Converter[^[]* \[ERROR: \(x\)\]$/);
  // ODA itself gave nothing: no ODA suggestion
  const oda = await loadDrawing(api({ dwgSize: 2e6, converter: 'ODA' }), 'big.dwg', null, { path: '/d/big.dwg' }).then(() => null, (e) => e);
  assert.ok(oda && !oda.odaHint);
  assert.match(oda.message, /^The ODA File Converter produced an incomplete drawing/);
  // a small DWG may really be empty; a DXF is never checked
  const small = await loadDrawing(api({ dwgSize: 50 * 1024, converter: 'LibreDWG' }), 'small.dwg', null, { path: '/d/small.dwg' });
  assert.deepEqual([small.conversion.converter, small.conversion.objects], ['LibreDWG', 0]);
  const dxf = await loadDrawing({ isElectron: true }, 'empty.dxf', new TextEncoder().encode(EMPTY_DXF));
  assert.equal(dxf.conversion, null);
});

test('loadDrawing returns the conversion quality of a DWG; conversionSummary words it for the status bar', async () => {
  const dxf = fixture('basic_r2000.dxf');
  const api = { isElectron: true, dwgAvailable: async () => ({ available: true }), dwgOpen: async () => ({ url: dataUrl(dxf), warnings: [], dwgSize: 900_000, header: 'AC1027', errorCount: 12, log: 'ERROR: a\n', converter: 'LibreDWG', engine: 'libredwg' }) };
  const { doc, conversion } = await loadDrawing(api, 'plan.dwg', null, { path: '/d/plan.dwg' });
  assert.deepEqual({ ...conversion, skipped: undefined }, { converter: 'LibreDWG', errorCount: 12, log: 'ERROR: a\n', objects: doc.entities.length, skipped: undefined, dwgHeader: 'AC1027' });
  const s = conversionSummary({ ...conversion, objects: 1234, skipped: { '3DSOLID': 3 } });
  assert.equal(s.text, 'LibreDWG · 12 converter errors');
  assert.match(s.title, /Objects read: 1,234\.\nObject types not shown: 3 3DSOLID\.\nConverter errors: 12\./);
  assert.equal(conversionSummary({ converter: 'LibreDWG', errorCount: 0, objects: 1, skipped: {} }).text, 'LibreDWG · no converter errors');
  assert.equal(conversionSummary({ converter: 'LibreDWG', errorCount: 1, objects: 1, skipped: {} }).text, 'LibreDWG · 1 converter error');
  const o = conversionSummary({ converter: 'ODA', errorCount: 0, log: '', objects: 1, skipped: {} });
  assert.equal(o.text, 'ODA File Converter · no messages');
  assert.match(o.title, /Object types not shown: none/);
  assert.equal(conversionSummary({ converter: 'ODA', errorCount: 0, log: 'Auditing drawing.dwg\n', objects: 1, skipped: {} }).text, 'ODA File Converter · log');
});

test('loadDrawing: Cancel while a DWG converts asks main to kill that conversion and reports the open as cancelled', async () => {
  let job = null, cancelled = null, fail;
  const api = {
    isElectron: true, dwgAvailable: async () => ({ available: true }),
    dwgOpen: (_src, j) => { job = j; return new Promise((_r, rej) => { fail = rej; }); },
    dwgCancel: async (j) => { cancelled = j; fail(new Error("Error invoking remote method 'dwg:open': Error: The DWG conversion was cancelled.")); },
  };
  const ac = new AbortController();
  const open = loadDrawing(api, 'plan.dwg', null, { path: '/d/plan.dwg', signal: ac.signal }).then(() => null, (e) => e);
  await new Promise((r) => setTimeout(r, 0));
  assert.match(job, /^open-/);
  ac.abort();
  const err = await open;
  assert.equal(cancelled, job);
  assert.equal(err.code, 'CANCELLED');
});
