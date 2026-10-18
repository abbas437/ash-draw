// Unit tests for the ODA File Converter bridge and the engine fallback, using a stub converter (an executable Node script).
// Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOdaBridge, createDwgService, emptyReferencedBlocks, findOdaConverter, implausibleConversion, odaArgs, odaVersion, ODA_DWG_VERSIONS, ODA_HINT, ODA_TIMEOUT_MS } from './odaConverter.js';
import { DWG_SAVE_VERSIONS } from '../src/core/dwgpref.js';

const skip = process.platform === 'win32' ? 'the stub converter is a shebang script' : false;
const KNOWN_DXF = '  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n  8\n0\n 10\n0\n 20\n0\n 11\n10\n 21\n10\n  0\nENDSEC\n  0\nEOF\n';

// The stub records its argv and the input folder listing to <stub dir>/calls.json, then behaves as `body` says.
async function stub(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-oda stub $(x);'));
  const exeDir = path.join(dir, 'ODAFileConverter 25.12.0');
  await fs.mkdir(exeDir);
  const exe = path.join(exeDir, 'ODAFileConverter');
  await fs.writeFile(exe, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(path.join(dir, 'calls.json'))}, JSON.stringify({ argv: a, input: fs.readdirSync(a[0]) }));
${body}
`);
  await fs.chmod(exe, 0o755);
  const tmpRoot = path.join(dir, 'tmp root');
  await fs.mkdir(tmpRoot);
  return { dir, exe, tmpRoot, calls: async () => JSON.parse(await fs.readFile(path.join(dir, 'calls.json'), 'utf8')), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}
const WRITE_DXF = `fs.writeFileSync(path.join(a[1], a[6].replace(/\\.dwg$/i, '.dxf')), ${JSON.stringify(KNOWN_DXF)});`;
const dwg = new TextEncoder().encode('AC1032 fake dwg');

test('ODA converter: argument array order, fixed input name, output picked up, temp folder removed', { skip }, async () => {
  const s = await stub(WRITE_DXF);
  try {
    const b = createOdaBridge(s.exe, { tmpRoot: s.tmpRoot });
    const { dxfBytes } = await b.toDxf(dwg);
    assert.equal(Buffer.from(dxfBytes).toString(), KNOWN_DXF);
    const { argv, input } = await s.calls();
    assert.equal(argv.length, 7);
    assert.match(argv[0], /ash-oda-[^/]+\/in$/);
    assert.match(argv[1], /ash-oda-[^/]+\/out$/);
    assert.deepEqual(argv.slice(2), ['ACAD2018', 'DXF', '0', '1', 'drawing.dwg']);
    assert.ok(argv[0].startsWith(s.tmpRoot), 'temp folders live under tmpRoot (path with spaces passed as one argument)');
    assert.deepEqual(input, ['drawing.dwg']);
    assert.deepEqual(await fs.readdir(s.tmpRoot), []);
    assert.equal(b.version, '25.12.0');
    assert.equal(ODA_TIMEOUT_MS, 600_000);
  } finally { await s.cleanup(); }
});

test('ODA converter: failure without output reports the .err file and cleans up', { skip }, async () => {
  const s = await stub(`fs.writeFileSync(path.join(a[1], 'drawing.dwg.err'), 'Error: bad section'); process.exit(0);`);
  try {
    await assert.rejects(createOdaBridge(s.exe, { tmpRoot: s.tmpRoot }).toDxf(dwg), /produced no DXF: Error: bad section/);
    assert.deepEqual(await fs.readdir(s.tmpRoot), []);
  } finally { await s.cleanup(); }
  const t = await stub('process.exit(3);');
  try {
    await assert.rejects(createOdaBridge(t.exe, { tmpRoot: t.tmpRoot }).toDxf(dwg), /ODA File Converter failed \(exit code 3\)/);
    assert.deepEqual(await fs.readdir(t.tmpRoot), []);
  } finally { await t.cleanup(); }
});

test('ODA converter: timeout kills it, reports it and cleans up', { skip }, async () => {
  const s = await stub('setTimeout(() => {}, 10000);');
  try {
    const t0 = Date.now();
    await assert.rejects(createOdaBridge(s.exe, { tmpRoot: s.tmpRoot, timeoutMs: 400 }).toDxf(dwg), /timed out after 0 s/);
    assert.ok(Date.now() - t0 < 5000);
    assert.deepEqual(await fs.readdir(s.tmpRoot), []);
  } finally { await s.cleanup(); }
});

test('auto-detect picks the newest ODAFileConverter version folder that has the exe', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-progfiles-'));
  try {
    const mk = async (name, exe = true) => { await fs.mkdir(path.join(root, 'ODA', name), { recursive: true }); if (exe) await fs.writeFile(path.join(root, 'ODA', name, 'ODAFileConverter.exe'), ''); };
    await mk('ODAFileConverter 21.9.0'); await mk('ODAFileConverter 25.4.0'); await mk('ODAFileConverter 25.12.0');
    await mk('ODAFileConverter 26.1.0', false); await mk('Teigha 99.0.0');
    const found = await findOdaConverter([path.join(root, 'missing'), root]);
    assert.equal(found, path.join(root, 'ODA', 'ODAFileConverter 25.12.0', 'ODAFileConverter.exe'));
    assert.equal(odaVersion(found), '25.12.0');
    assert.equal(await findOdaConverter([path.join(root, 'missing')]), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// fake engines for the fallback order
const fakeLibre = (ok) => ({ calls: 0, available: async () => ({ available: true, version: '0.13.3' }), async toDxf() { this.calls++; if (!ok) throw new Error('ERROR: read_R2004_section_info out of range'); return { dxfBytes: new Uint8Array([1]) }; } });
const service = (libre, cfg, exe, odaOk = true) => {
  const used = [];
  const svc = createDwgService({ libre, getConfig: () => cfg, detectOda: async () => exe, makeOda: (p) => ({ async toDxf() { used.push(p); if (!odaOk) throw new Error('ODA crashed'); return { dxfBytes: new Uint8Array([2]) }; } }) });
  return { svc, used };
};

test('fallback: Automatic uses LibreDWG first and ODA when it fails; each falls back to the other', async () => {
  let lib = fakeLibre(false);
  let { svc, used } = service(lib, { mode: 'auto' }, '/x/ODAFileConverter.exe');
  assert.equal((await svc.toDxf(dwg)).engine, 'oda'); // LibreDWG fails -> ODA
  assert.deepEqual(used, ['/x/ODAFileConverter.exe']);
  lib = fakeLibre(true);
  ({ svc, used } = service(lib, { mode: 'auto' }, '/x/ODAFileConverter.exe', false));
  const r = await svc.toDxf(dwg); // ODA fails -> LibreDWG
  assert.equal(r.engine, 'libredwg');
  assert.equal(lib.calls, 1);
  assert.equal((await svc.available()).engine, 'libredwg'); // Automatic: the built-in converter is tried first
});

test('fallback: ODA missing and LibreDWG fails -> error with the install hint; Built-in never runs ODA', async () => {
  const { svc } = service(fakeLibre(false), { mode: 'auto' }, null);
  const err = await svc.toDxf(dwg).then(() => null, (e) => e);
  assert.ok(err?.message.startsWith(ODA_HINT), err?.message);
  assert.match(err.message, /read_R2004_section_info/);
  assert.equal(err.odaHint, true);
  const b = service(fakeLibre(false), { mode: 'libredwg' }, '/x/ODAFileConverter.exe');
  await assert.rejects(b.svc.toDxf(dwg), /Install the free ODA File Converter[\s\S]*Preferences/);
  assert.deepEqual(b.used, []);
  const both = service(fakeLibre(false), { mode: 'auto' }, '/x/ODAFileConverter.exe', false);
  await assert.rejects(both.svc.toDxf(dwg), /could not be converted \(LibreDWG: ERROR[^;]*; ODA File Converter: ODA crashed/);
});

test('ODA path setting must name ODAFileConverter[.exe]; ODA mode without ODA is unavailable', async () => {
  const { svc, used } = service(fakeLibre(true), { mode: 'oda', odaPath: '/bin/sh' }, '/x/ODAFileConverter.exe');
  const av = await svc.available();
  assert.equal(av.available, false);
  assert.match(av.reason, /not found at \/bin\/sh/);
  await assert.rejects(svc.toDxf(dwg), /Install the free ODA File Converter/);
  assert.deepEqual(used, []);
});

const MB = 1024 * 1024;
// the reviewer's 115 MB AutoCAD 2018 DWG came back from LibreDWG as 0.2 MB of DXF with 666,694 ERROR lines (an empty drawing);
// real drawings that convert fine give 5-15x their size of DXF, some with a few thousand ERROR lines
test('implausibleConversion: a near-empty or error-flooded conversion is rejected, normal ones are not', () => {
  const failing = implausibleConversion({ dwgBytes: 115 * MB, dxfBytes: 0.2 * MB, errorCount: 666_694 });
  assert.match(failing, /115\.0 MB DWG file gave only 0\.2 MB of drawing data and reported 666,694 errors/);
  assert.ok(implausibleConversion({ dwgBytes: 115 * MB, dxfBytes: 0.2 * MB, errorCount: 0 }), 'size alone');
  assert.match(implausibleConversion({ dwgBytes: 1 * MB, dxfBytes: 8 * MB, errorCount: 100_001 }), /reported 100,001 errors/);
  assert.equal(implausibleConversion({ dwgBytes: 0.9 * MB, dxfBytes: 12 * MB, errorCount: 0 }), null);
  assert.equal(implausibleConversion({ dwgBytes: 66 * MB, dxfBytes: 336 * MB, errorCount: 8_933 }), null);
  assert.equal(implausibleConversion({ dwgBytes: 2 * MB, dxfBytes: 15 * MB, errorCount: 1_376 }), null);
  assert.equal(implausibleConversion({ dwgBytes: 1.5 * MB, dxfBytes: 0.1 * MB, errorCount: 0 }), null, 'small DWGs: the size rule does not apply');
  assert.equal(implausibleConversion({ dwgBytes: 4 * MB, dxfBytes: 2.1 * MB, errorCount: 100_000 }), null, 'at the limits');
});

test('implausible LibreDWG output is a failed open: ODA tried next when installed, else the install hint with sizes and errors', async () => {
  const big = new Uint8Array(3 * MB);
  const tinyLibre = { calls: 0, available: async () => ({ available: true, version: '0.13.3' }), async toDxf() { this.calls++; return { dxfBytes: new Uint8Array(1000), errorCount: 200_000, log: 'ERROR: bad [section]\nERROR: x\n', converter: 'LibreDWG' }; } };
  // ODA installed but failing first (Automatic): LibreDWG's empty result must not be shown either
  const both = service(tinyLibre, { mode: 'auto' }, '/x/ODAFileConverter.exe', false);
  await assert.rejects(both.svc.toDxf(big), /could not be converted \(LibreDWG: produced an incomplete drawing[^;]*; ODA File Converter: ODA crashed/);
  // ODA installed and working: it is used
  const ok = service(tinyLibre, { mode: 'auto' }, '/x/ODAFileConverter.exe');
  const r = await ok.svc.toDxf(new Uint8Array(10));
  assert.equal(r.converter, 'ODA');
  // no ODA: the error names what went wrong in plain words and carries the hint (and the log, without brackets)
  for (const mode of ['auto', 'libredwg']) {
    const err = await service(tinyLibre, { mode }, null).svc.toDxf(big).then(() => null, (e) => e);
    assert.ok(err, mode);
    assert.equal(err.odaHint, true);
    assert.match(err.message, /^The built-in converter produced an incomplete drawing from this DWG: a 3\.0 MB DWG file gave only less than 0\.1 MB of drawing data and reported 200,000 errors\./);
    assert.match(err.message, /Install the free ODA File Converter/);
    assert.match(err.message, / \[[^[]*ERROR: bad \(section\)[^[]*\]$/);
  }
  // a plausible result passes through with the counts
  const fine = { available: async () => ({ available: true, version: '0.13.3' }), async toDxf() { return { dxfBytes: new Uint8Array(20 * MB), errorCount: 12, log: 'ERROR: a', converter: 'LibreDWG' }; } };
  const f = await service(fine, { mode: 'auto' }, null).svc.toDxf(big);
  assert.deepEqual([f.converter, f.engine, f.errorCount, f.log], ['LibreDWG', 'libredwg', 12, 'ERROR: a']);
});

test('odaArgs: DXF read and DWG write argument arrays, versions mapped to ODA names', () => {
  assert.deepEqual(odaArgs('/i', '/o', 'DXF'), ['/i', '/o', 'ACAD2018', 'DXF', '0', '1', 'drawing.dwg']);
  const want = { acad2018: 'ACAD2018', acad2013: 'ACAD2013', acad2010: 'ACAD2010', acad2007: 'ACAD2007', acad2004: 'ACAD2004', acad2000: 'ACAD2000' };
  for (const [id, oda] of Object.entries(want)) assert.deepEqual(odaArgs('/i', '/o', 'DWG', id), ['/i', '/o', oda, 'DWG', '0', '1', 'drawing.dxf']);
  assert.deepEqual(Object.keys(ODA_DWG_VERSIONS), DWG_SAVE_VERSIONS.map((v) => v.id), 'the renderer offers exactly the versions main accepts');
  for (const bad of ['r2000', 'ACAD2018', 'acad2021', undefined]) assert.throws(() => odaArgs('/i', '/o', 'DWG', bad), RangeError);
  assert.throws(() => odaArgs('/i', '/o', 'DXB'), RangeError);
});

test('ODA converter fromDxf: writes drawing.dxf, asks for DWG in the version, picks up the .dwg, cleans up', { skip }, async () => {
  const s = await stub(`fs.writeFileSync(path.join(a[1], 'drawing.dwg'), 'AC1027 out');`);
  try {
    const { dwgBytes } = await createOdaBridge(s.exe, { tmpRoot: s.tmpRoot }).fromDxf(new TextEncoder().encode(KNOWN_DXF), 'acad2013');
    assert.equal(Buffer.from(dwgBytes).toString(), 'AC1027 out');
    const { argv, input } = await s.calls();
    assert.deepEqual(argv.slice(2), ['ACAD2013', 'DWG', '0', '1', 'drawing.dxf']);
    assert.deepEqual(input, ['drawing.dxf']);
    assert.deepEqual(await fs.readdir(s.tmpRoot), []);
  } finally { await s.cleanup(); }
  const t = await stub(`fs.writeFileSync(path.join(a[1], 'drawing.dxf.err'), 'Error: bad DXF');`);
  try {
    await assert.rejects(createOdaBridge(t.exe, { tmpRoot: t.tmpRoot }).fromDxf(new Uint8Array([1]), 'acad2018'), /produced no DWG: Error: bad DXF/);
    await assert.rejects(createOdaBridge(t.exe, { tmpRoot: t.tmpRoot }).fromDxf(new Uint8Array([1]), 'r2000'), RangeError);
    assert.deepEqual(await fs.readdir(t.tmpRoot), []);
  } finally { await t.cleanup(); }
});

test('DWG write routing: ODA versions go to ODA (error without it), r2000/r14 to LibreDWG', async () => {
  const calls = [];
  const libre = { available: async () => ({ available: true, version: '0.13.3' }), fromDxf: async (b, v) => { calls.push(['libre', v]); return { dwgBytes: new Uint8Array([7]) }; } };
  const mk = (cfg, exe) => createDwgService({ libre, getConfig: () => cfg, detectOda: async () => exe, makeOda: (p) => ({ fromDxf: async (b, v) => { calls.push(['oda', p, v]); return { dwgBytes: new Uint8Array([8]) }; } }) });
  const dxf = new Uint8Array([1]);
  const auto = mk({ mode: 'auto' }, '/x/ODAFileConverter.exe');
  assert.deepEqual(await auto.fromDxf(dxf, 'acad2018'), { dwgBytes: new Uint8Array([8]), engine: 'oda' });
  assert.deepEqual(await auto.fromDxf(dxf, 'r2000'), { dwgBytes: new Uint8Array([7]), engine: 'libredwg' });
  assert.deepEqual(calls, [['oda', '/x/ODAFileConverter.exe', 'acad2018'], ['libre', 'r2000']]);
  assert.deepEqual((await auto.dwgWriteEngines()).oda, true);
  assert.deepEqual((await auto.available()).write, { oda: true, odaVersions: Object.keys(ODA_DWG_VERSIONS), libredwg: true });
  calls.length = 0;
  for (const svc of [mk({ mode: 'auto' }, null), mk({ mode: 'libredwg' }, '/x/ODAFileConverter.exe')]) {
    await assert.rejects(svc.fromDxf(dxf, 'acad2013'), /Saving DWG 2013 needs the ODA File Converter[\s\S]*Install the free ODA File Converter/);
    assert.equal((await svc.dwgWriteEngines()).oda, false);
    assert.equal((await svc.available()).write.oda, false);
  }
  assert.deepEqual(calls, [], 'nothing ran');
});

test('ODA converter: the temp folder is removed with retries, and a failed removal does not hide the conversion error', { skip }, async (t) => {
  const s = await stub('process.exit(3);');
  try {
    const seen = [];
    const rm = t.mock.method(fs, 'rm', async (p, o) => { seen.push(o); throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); });
    await assert.rejects(createOdaBridge(s.exe, { tmpRoot: s.tmpRoot }).toDxf(dwg), /ODA File Converter failed \(exit code 3\)/);
    rm.mock.restore();
    assert.deepEqual(seen, [{ recursive: true, force: true, maxRetries: 5, retryDelay: 200 }]);
  } finally { await s.cleanup(); }
});

test('ODA time limit grows with the drawing: 10 min floor, 15 s per MB, 1 h cap', async () => {
  const { odaTimeoutFor, ODA_TIMEOUT_MS } = await import('./odaConverter.js');
  const MiB = 1024 * 1024;
  assert.equal(odaTimeoutFor(1 * MiB), ODA_TIMEOUT_MS);
  assert.equal(odaTimeoutFor(115.4 * MiB), 116 * 15_000); // the reviewer's 115 MB drawing: 29 min
  assert.equal(odaTimeoutFor(1000 * MiB), 60 * 60_000);
});

// DXF text from [code, value] pairs, codes right-aligned to 3 like AutoCAD writes them
const dxf = (pairs, eol = '\n') => pairs.map(([c, v]) => `${String(c).padStart(3)}${eol}${v}${eol}`).join('');
const blk = (name, ...ents) => [[0, 'BLOCK'], [5, '1F'], [8, '0'], [2, name], [70, 0], [10, 0], [20, 0], [30, 0], [3, name], ...ents.flat(), [0, 'ENDBLK'], [8, '0']];
const ins = (name) => [[0, 'INSERT'], [8, 'A-WALL'], [2, name], [10, 5], [20, 5]];
const line = [[0, 'LINE'], [8, 'A-WALL'], [10, 0], [20, 0], [11, 1], [21, 1]];
const blocksDxf = (eol) => dxf([
  [0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1032'], [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'BLOCKS'],
  ...blk('*Model_Space'), ...blk('*Paper_Space'),
  // 'room tag' (inserted as ROOM TAG) and 'BUILDING F -GF-ARC' (inserted only from inside another block) have
  // no definition: lost by the converter
  ...blk('door', line), // referenced, not empty
  ...blk('unused'), // empty, never inserted
  ...blk('placeholder'), // empty but DEFINED and inserted: a genuinely empty block, not a loss
  ...blk('level-floor', line, ins('BUILDING F -GF-ARC')),
  [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'ENTITIES'], ...ins('ROOM TAG'), ...ins('placeholder'), ...ins('door'), ...ins('level-floor'), ...ins('*Paper_Space'), ...line, [0, 'ENDSEC'],
  [0, 'EOF'],
], eol);

test('emptyReferencedBlocks: inserted blocks with no definition, case-insensitive, nested INSERTs, CRLF; defined empty and * blocks ignored', () => {
  for (const eol of ['\n', '\r\n']) {
    const bytes = new TextEncoder().encode(blocksDxf(eol));
    assert.deepEqual(emptyReferencedBlocks(bytes), { count: 2, names: ['BUILDING F -GF-ARC', 'ROOM TAG'] }, JSON.stringify(eol));
    assert.deepEqual(emptyReferencedBlocks(Buffer.from(bytes), 1), { count: 2, names: ['BUILDING F -GF-ARC'] }, 'Buffer input, name limit');
  }
  assert.deepEqual(emptyReferencedBlocks(new TextEncoder().encode(KNOWN_DXF)), { count: 0, names: [] });
  assert.deepEqual(emptyReferencedBlocks(new Uint8Array(0)), { count: 0, names: [] });
  // a view into a larger buffer is read from its own offset
  const full = new TextEncoder().encode(`junk\n${blocksDxf('\n')}`);
  assert.equal(emptyReferencedBlocks(full.subarray(5)).count, 2);
});

const libreDxf = (text) => ({ calls: 0, available: async () => ({ available: true, version: '0.13.3' }), async toDxf() { this.calls++; return { dxfBytes: new TextEncoder().encode(text), errorCount: 3, log: 'ERROR: a', converter: 'LibreDWG' }; } });
test('empty referenced blocks from LibreDWG: ODA used when it works, else the LibreDWG drawing with a warning', async () => {
  const text = blocksDxf('\n');
  // ODA installed and working: its result is used
  const ok = service(libreDxf(text), { mode: 'auto' }, '/x/ODAFileConverter.exe');
  const r = await ok.svc.toDxf(dwg);
  assert.deepEqual([r.engine, r.converter, r.warnings], ['oda', 'ODA', undefined]);
  assert.deepEqual(ok.used, ['/x/ODAFileConverter.exe']);
  // no ODA: the LibreDWG drawing, with a warning that suggests installing ODA
  for (const mode of ['auto', 'libredwg']) {
    const lib = libreDxf(text);
    const n = await service(lib, { mode }, null).svc.toDxf(dwg);
    assert.deepEqual([n.engine, n.converter, n.errorCount, n.log, lib.calls], ['libredwg', 'LibreDWG', 3, 'ERROR: a', 1], mode);
    assert.equal(n.warnings.length, 1);
    assert.match(n.warnings[0], /^2 blocks are missing from the built-in converter's output \(e\.g\. BUILDING F -GF-ARC, ROOM TAG\) — walls, tags or symbols may be missing\. Install the free ODA File Converter/);
    assert.equal(/Preferences/.test(n.warnings[0]), mode === 'libredwg', mode);
  }
  // ODA installed but failing: the LibreDWG drawing, the warning says ODA failed and does not suggest the install
  const failing = service(libreDxf(text), { mode: 'auto' }, '/x/ODAFileConverter.exe', false);
  const f = await failing.svc.toDxf(dwg);
  assert.equal(f.engine, 'libredwg');
  assert.match(f.warnings[0], /blocks are missing from the built-in converter's output[\s\S]*ODA File Converter was tried as well but could not convert this DWG \(ODA crashed\)/);
  assert.doesNotMatch(f.warnings[0], /Install/);
  assert.deepEqual(failing.used, ['/x/ODAFileConverter.exe']);
  // earlier LibreDWG warnings are kept
  const warned = { ...libreDxf(text), async toDxf() { return { dxfBytes: new TextEncoder().encode(text), warnings: ['Warning: x'] }; } };
  assert.deepEqual((await service(warned, { mode: 'auto' }, null).svc.toDxf(dwg)).warnings.map((w) => w.slice(0, 9)), ['Warning: ', '2 blocks ']);
});

test('clean LibreDWG output: ODA is not run and no warning is added; ODA output is not scanned', async () => {
  const clean = service(libreDxf(dxf([[0, 'SECTION'], [2, 'BLOCKS'], ...blk('door', line), [0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES'], ...ins('door'), [0, 'ENDSEC'], [0, 'EOF']])), { mode: 'auto' }, '/x/ODAFileConverter.exe');
  const r = await clean.svc.toDxf(dwg);
  assert.deepEqual([r.engine, r.warnings, clean.used], ['libredwg', undefined, []]);
  const text = blocksDxf('\n');
  const odaOnly = createDwgService({ libre: libreDxf(text), getConfig: () => ({ mode: 'oda' }), detectOda: async () => '/x/ODAFileConverter.exe', makeOda: () => ({ toDxf: async () => ({ dxfBytes: new TextEncoder().encode(text) }) }) });
  const o = await odaOnly.toDxf(dwg);
  assert.deepEqual([o.engine, o.warnings], ['oda', undefined]);
});

test('emptyReferencedBlocks: INSERTs of blocks with no definition at all count (LibreDWG leaves some out of BLOCKS)', () => {
  const dxf = ['0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', '*Model_Space', '0', 'ENDBLK',
    '0', 'BLOCK', '2', 'door', '0', 'LINE', '0', 'ENDBLK',
    '0', 'BLOCK', '2', '*U4', '0', 'INSERT', '2', 'room tag', '0', 'ENDBLK',
    '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '2', 'door', '0', 'INSERT', '2', 'Room Tag', '0', 'INSERT', '2', 'BUILDING F -GF-ARC', '0', 'INSERT', '2', '*U13', '0', 'INSERT', '2', '*U4',
    '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
  assert.deepEqual(emptyReferencedBlocks(new TextEncoder().encode(dxf)), { count: 3, names: ['room tag', 'BUILDING F -GF-ARC', '*U13'] });
});

test('emptyReferencedBlocks: attached xrefs (flag 4, overlay 12) and xref-dependent blocks (16) are empty by nature, not lost; a missing definition still counts', () => {
  const dxf = ['0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'SITE-PLAN', '70', '4', '1', '..\\x\\site.dwg', '0', 'ENDBLK',
    '0', 'BLOCK', '2', 'GRID', '70', '44', '1', 'grid.dwg', '0', 'ENDBLK',
    '0', 'BLOCK', '2', 'SITE-PLAN|DOOR', '70', '48', '0', 'ENDBLK',
    '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '2', 'SITE-PLAN', '0', 'INSERT', '2', 'GRID', '0', 'INSERT', '2', 'SITE-PLAN|DOOR', '0', 'INSERT', '2', 'tag',
    '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
  assert.deepEqual(emptyReferencedBlocks(new TextEncoder().encode(dxf)), { count: 1, names: ['tag'] });
});
