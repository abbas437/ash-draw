// scripts/fetch-libredwg.mjs: archive acceptance (upstream pin vs patched build) and the source notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { LIBREDWG, readmeSource, verifyArchive } from '../scripts/fetch-libredwg.mjs';

const PATCH = readFileSync(new URL(`../${LIBREDWG.toolsDir}/${LIBREDWG.patchName}`, import.meta.url));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Minimal stored (uncompressed) zip writer for synthetic archives. */
function makeZip(files) {
  const locals = []; const central = []; let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name); const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); central.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length / 2, 8); eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const ICONV = Buffer.from('fake libiconv');
const pins = { ...LIBREDWG, libiconvSha256: sha256(ICONV) };
const converters = () => ({
  'dwg2dxf.exe': Buffer.from('a'), 'dxf2dwg.exe': Buffer.from('b'), 'libredwg-0.dll': Buffer.from('c'), 'libiconv-2.dll': ICONV,
});

test('patched build: accepted when it carries the repository patch, all four files extracted', () => {
  const r = verifyArchive(makeZip({ ...converters(), [LIBREDWG.patchName]: PATCH }), { patch: PATCH, pins });
  assert.equal(r.patched, true);
  assert.deepEqual(r.files.map(([n]) => n), LIBREDWG.files);
});

test('non-upstream zip without the patch is refused', () => {
  assert.throws(() => verifyArchive(makeZip(converters()), { patch: PATCH, pins }), /SHA-256 mismatch.*not a patched build/);
});

test('patched build whose patch differs from the repository copy is refused', () => {
  const zip = makeZip({ ...converters(), [LIBREDWG.patchName]: Buffer.concat([PATCH, Buffer.from('\n')]) });
  assert.throws(() => verifyArchive(zip, { patch: PATCH, pins }), /differs from/);
});

test('patched build missing a converter file is refused', () => {
  const files = { ...converters(), [LIBREDWG.patchName]: PATCH };
  delete files['dxf2dwg.exe'];
  assert.throws(() => verifyArchive(makeZip(files), { patch: PATCH, pins }), /dxf2dwg\.exe not found/);
});

test('patched build with a non-upstream libiconv-2.dll is refused', () => {
  const zip = makeZip({ ...converters(), 'libiconv-2.dll': Buffer.from('other'), [LIBREDWG.patchName]: PATCH });
  assert.throws(() => verifyArchive(zip, { patch: PATCH, pins }), /libiconv-2\.dll .* not the upstream one/);
});

test('source notice for the patched build names the tarball, the patch and the build scripts', () => {
  const txt = readmeSource([['dwg2dxf.exe', '0'.repeat(64)]], { patched: true, zipSha256: '1'.repeat(64) });
  assert.match(txt, /MODIFIED version of GNU LibreDWG/);
  assert.ok(!txt.includes('UNMODIFIED'));
  assert.match(txt, new RegExp(LIBREDWG.patchDate));
  for (const s of [LIBREDWG.patchName, LIBREDWG.sourceName, LIBREDWG.sourceSha256, `${LIBREDWG.toolsDir}/`,
    'build-win64.sh', 'build-patched.sh', LIBREDWG.releasePatchName, LIBREDWG.releaseToolsName, '1'.repeat(64)]) {
    assert.ok(txt.includes(s), `notice mentions ${s}`);
  }
});

test('source notice for the upstream zip still says unmodified', () => {
  const txt = readmeSource([['dwg2dxf.exe', '0'.repeat(64)]]);
  assert.match(txt, /UNMODIFIED upstream binaries/);
  assert.ok(!txt.includes(LIBREDWG.patchName));
});

test('the repository patch is the LLP64 bit_advance_position fix', () => {
  const p = PATCH.toString('utf8');
  assert.match(p, /^\+\s+else if \(advance < 0 && pos < -\(size_t\)advance\)$/m);
  assert.match(p, /^-\s+else if \(\(long\)\(pos \+ advance\) < 0\)$/m);
});
