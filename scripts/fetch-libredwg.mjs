#!/usr/bin/env node
// Puts the LibreDWG 0.14.8597 (nightly) Windows x64 converter executables (and the DLLs they
// import) into build/libredwg/, together with the GPL-3.0 text and a source notice.
//
// Two archives are accepted:
//  - the upstream release zip, refused unless its SHA-256 matches the pin below (developer default);
//  - the patched build made by tools/libredwg-win/build-patched.sh from the pinned upstream source
//    tarball plus tools/libredwg-win/libredwg-llp64-bitpos.patch (what release builds ship). It is
//    accepted only if the patch it carries is byte-identical to the repository's and its
//    libiconv-2.dll is the upstream one. Those binaries are MODIFIED versions of LibreDWG; the
//    notice written next to them names the tarball, the patch and the build scripts as the
//    Corresponding Source.
//
// LibreDWG is GPL-3.0-or-later. ASH Draw Studio (MIT) never links or loads it:
// the app launches these executables as separate child processes.
//
// Usage:
//   node scripts/fetch-libredwg.mjs                  download the upstream zip (cached in .cache/) and extract
//   node scripts/fetch-libredwg.mjs --from <zip>     use a local zip (upstream, or the patched build)
//   ASH_LIBREDWG_ZIP=<zip> npm run fetch:libredwg    same as --from (also picked up by `npm run dist`)
//   node scripts/fetch-libredwg.mjs --source <dir>   also download + verify the source tarball into <dir>
//                                                    and copy the patch there (release assets)
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const LIBREDWG = Object.freeze({
  // 0.14.8597 is the upstream "libredwg windows nightly" pre-release. It is pinned (not 0.13.3) because
  // 0.13.3 cannot read AutoCAD 2018 (R2018) DWGs: "read_R2004_section_info out of range".
  version: '0.14.8597',
  zipName: 'libredwg-0.14.8597-win64.zip',
  zipUrl: 'https://github.com/LibreDWG/libredwg/releases/download/0.14.8597/libredwg-0.14.8597-win64.zip',
  zipSha256: '7fee5c67c4f451f0542c0d6a3b12e91e99b15faf363fbf8b98ad84bac17ddfa2',
  sourceName: 'libredwg-0.14.8597.tar.xz',
  // GitHub only: ftp.gnu.org carries no tarballs for nightlies.
  sourceUrlGithub: 'https://github.com/LibreDWG/libredwg/releases/download/0.14.8597/libredwg-0.14.8597.tar.xz',
  sourceReleasePage: 'https://github.com/LibreDWG/libredwg/releases/tag/0.14.8597',
  sourceSha256: 'af2646681858a78d756cfb9e0eeb6901f61be3d09ae8f56a98e94b1490dec4ed',
  // Import closure determined with `objdump -p`: dwg2dxf.exe and dxf2dwg.exe import
  // libredwg-0.dll (+ KERNEL32.dll, msvcrt.dll from Windows); libredwg-0.dll imports
  // libiconv-2.dll (+ KERNEL32.dll, msvcrt.dll). libpcre2-*.dll are imported only by
  // dwggrep.exe, so they are not bundled. libiconv-2.dll is LGPL-2.1-or-later.
  files: ['dwg2dxf.exe', 'dxf2dwg.exe', 'libredwg-0.dll', 'libiconv-2.dll'],
  // libiconv-2.dll from the upstream zip; the patched build reuses it byte-for-byte.
  libiconvSha256: 'ff31fa811f9c07cc7fdaa68c9e8bca3a7b4fdf6e0a079a58175ea58ba139c7ae',
  // Patched build (tools/libredwg-win/build-patched.sh): upstream source + one patch for the
  // LLP64 "buffer underflow past 256 MiB" bug in src/bits.c bit_advance_position().
  toolsDir: 'tools/libredwg-win',
  patchName: 'libredwg-llp64-bitpos.patch',
  patchDate: '2026-10-14',
  patchedZipName: 'libredwg-0.14.8597-llp64-win64.zip',
  buildScripts: ['build-patched.sh', 'build-win64.sh', 'package-win64.sh', 'deps/libiconv-2/'],
  // Release assets published next to sourceName (.github/workflows/build.yml).
  releasePatchName: 'libredwg-0.14.8597-llp64-bitpos.patch',
  releaseToolsName: 'libredwg-0.14.8597-win64-build-tools.tar.gz',
  repoUrl: 'https://github.com/abbas437/ash-draw',
});

const OUT_DIR = path.join(ROOT, 'build', 'libredwg');
const CACHE_DIR = path.join(ROOT, '.cache');
const PATCH_FILE = path.join(ROOT, LIBREDWG.toolsDir, LIBREDWG.patchName);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Minimal ZIP reader (stored + deflate), enough for the upstream archive. */
export function readZipEntries(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    entries.set(name, { method, crc, csize, usize, local });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

export function extractEntry(buf, entry, name) {
  const { local, method, csize, usize, crc } = entry;
  if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt local header for ${name}`);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const raw = buf.subarray(start, start + csize);
  let data;
  if (method === 0) data = Buffer.from(raw);
  else if (method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`unsupported zip compression method ${method} for ${name}`);
  if (data.length !== usize) throw new Error(`size mismatch for ${name}`);
  if ((zlib.crc32(data) >>> 0) !== crc) throw new Error(`CRC mismatch for ${name}`);
  return data;
}

/**
 * Checks a LibreDWG Windows archive and extracts LIBREDWG.files from it. Accepts the pinned
 * upstream zip, or a patched build carrying a copy of `patch` (the repository's patch file,
 * byte-identical) and the upstream libiconv-2.dll. Anything else is refused.
 * @returns {{patched: boolean, zipSha256: string, files: [string, Buffer][]}}
 */
export function verifyArchive(zip, { patch, pins = LIBREDWG } = {}) {
  const zipSha256 = sha256(zip);
  const entries = readZipEntries(zip);
  const get = (name) => {
    const e = entries.get(name);
    if (!e) throw new Error(`${name} not found in the LibreDWG archive`);
    return extractEntry(zip, e, name);
  };
  const patched = zipSha256 !== pins.zipSha256;
  if (patched) {
    if (!entries.has(pins.patchName)) {
      throw new Error(`SHA-256 mismatch for ${pins.zipName}: expected ${pins.zipSha256}, got ${zipSha256}, `
        + `and it is not a patched build (no ${pins.patchName}). Refusing to use it.`);
    }
    if (!patch || !get(pins.patchName).equals(patch)) {
      throw new Error(`${pins.patchName} in the archive differs from ${pins.toolsDir}/${pins.patchName}. Refusing to use it.`);
    }
  }
  const files = pins.files.map((name) => [name, get(name)]);
  if (patched) {
    const iconv = files.find(([n]) => n === 'libiconv-2.dll');
    if (iconv && sha256(iconv[1]) !== pins.libiconvSha256) {
      throw new Error(`libiconv-2.dll in the patched archive is not the upstream one (SHA-256 ${sha256(iconv[1])}). Refusing to use it.`);
    }
  }
  return { patched, zipSha256, files };
}

/** README-SOURCE.txt for build/libredwg: what the binaries are, their source and the written offer. */
export function readmeSource(fileHashes, { patched = false, zipSha256 = LIBREDWG.zipSha256 } = {}) {
  const L = LIBREDWG;
  const hashes = fileHashes.map(([n, h]) => `  ${h}  ${n}`).join('\n');
  const what = patched ? `The files in this folder are a MODIFIED version of GNU LibreDWG version
${L.version}. ASH Technical & Project Management Services (ASH PMCS) built them
on ${L.patchDate} (date of the modification) from the unmodified upstream source
release with one patch applied, ${L.patchName} (a copy is in this
folder). The patch fixes a 64-bit Windows bug in src/bits.c: once a drawing's
decompressed data passed 256 MiB, reads were reported as "buffer underflow" and
restarted from byte 0, so large drawings converted to nearly empty files.

Archive: ${L.patchedZipName}
  SHA-256 of that archive: ${zipSha256}

Files (SHA-256):
${hashes}

libiconv-2.dll is taken byte-for-byte from the official upstream LibreDWG Windows
x64 release archive (${L.zipUrl},
SHA-256 ${L.zipSha256}).` : `The files in this folder are UNMODIFIED upstream binaries from GNU LibreDWG
version ${L.version}, taken byte-for-byte from the official Windows x64 release
archive:

  ${L.zipUrl}
  SHA-256 of that archive: ${L.zipSha256}

Files (SHA-256):
${hashes}`;
  const source = patched ? `The complete corresponding source code for these binaries consists of:

  1. The LibreDWG ${L.version} release source tarball, available at no charge from
       ${L.sourceReleasePage}
       ${L.sourceUrlGithub}
       (SHA-256 of ${L.sourceName}: ${L.sourceSha256})
  2. The patch ${L.patchName} (in this folder, and in
     ${L.toolsDir}/ of the ASH Draw Studio source, ${L.repoUrl}).
  3. The build scripts in ${L.toolsDir}/ (${L.buildScripts.join(', ')}),
     which cross-compile the patched source with the mingw-w64 toolchain of
     Ubuntu (apt-get install mingw-w64).

All three are also attached to each tagged ASH Draw Studio release on the page
from which the installer is distributed, as ${L.sourceName},
${L.releasePatchName} and ${L.releaseToolsName}.` : `The complete corresponding source code for these binaries is the LibreDWG
${L.version} release, available at no charge from:

  ${L.sourceReleasePage}
  ${L.sourceUrlGithub}
  (SHA-256 of ${L.sourceName}: ${L.sourceSha256})

The same source tarball is also attached to each tagged ASH Draw Studio release
on the page from which the installer is distributed.`;
  const offered = patched
    ? `of LibreDWG ${L.version} as listed above (source tarball, patch and build scripts)`
    : `of LibreDWG ${L.version}`;
  return `LibreDWG ${L.version} (nightly build) - binaries bundled with ASH Draw Studio
==============================================================

What these files are
--------------------
${what}

LibreDWG is free software, Copyright (C) Free Software Foundation, Inc., licensed
under the GNU General Public License version 3 or (at your option) any later
version (GPL-3.0-or-later). The full licence text is in the file COPYING in this
folder. These programs come with ABSOLUTELY NO WARRANTY.

libiconv-2.dll is GNU libiconv (Copyright (C) Free Software Foundation, Inc.), licensed
under the GNU Lesser General Public License version 2.1 or later. It is an unmodified
separate DLL that is only used by libredwg-0.dll; you may replace it with any
compatible build of libiconv 2.x.

How ASH Draw Studio uses them
-----------------------------
ASH Draw Studio is a separate program licensed under the MIT licence. It does not
link to, load or embed LibreDWG. When you open or save a DWG file, ASH Draw Studio
runs dwg2dxf.exe or dxf2dwg.exe as an independent child process with a temporary
input file and reads back the converted output file. You may replace these
executables with any other build of LibreDWG you prefer.

Corresponding source code
-------------------------
${source}

Written offer
-------------
For at least three (3) years from the date you received this copy, and for as
long as ASH Draw Studio distributes these binaries, ASH Technical & Project
Management Services (ASH PMCS) will give any third party, on request, a complete
machine-readable copy of the corresponding source code ${offered}
for no more than the cost of physically performing the transfer. Requests can be
made by opening an issue at https://github.com/abbas437/ash-draw/issues.
`;
}

async function verifiedSource(destDir) {
  const buf = await download(LIBREDWG.sourceUrlGithub);
  const got = sha256(buf);
  if (got !== LIBREDWG.sourceSha256) {
    throw new Error(`SHA-256 mismatch for ${LIBREDWG.sourceName}: expected ${LIBREDWG.sourceSha256}, got ${got}`);
  }
  await fs.mkdir(destDir, { recursive: true });
  const out = path.join(destDir, LIBREDWG.sourceName);
  await fs.writeFile(out, buf);
  console.log(`source tarball verified -> ${path.relative(ROOT, out)}`);
  // The patch is part of the Corresponding Source of the patched build; publish it next to the tarball.
  const patchOut = path.join(destDir, LIBREDWG.releasePatchName);
  await fs.copyFile(PATCH_FILE, patchOut);
  console.log(`patch -> ${path.relative(ROOT, patchOut)}`);
}

async function main(argv) {
  const fromIdx = argv.indexOf('--from');
  const srcIdx = argv.indexOf('--source');
  let zip;
  const from = fromIdx >= 0 ? argv[fromIdx + 1] : process.env.ASH_LIBREDWG_ZIP;
  if (fromIdx >= 0 && !from) throw new Error('--from needs a path to the zip');
  if (from) {
    zip = await fs.readFile(from);
    console.log(`using local archive ${from}`);
  } else {
    const cached = path.join(CACHE_DIR, LIBREDWG.zipName);
    zip = await fs.readFile(cached).catch(() => null);
    if (!zip || sha256(zip) !== LIBREDWG.zipSha256) {
      console.log(`downloading ${LIBREDWG.zipUrl}`);
      zip = await download(LIBREDWG.zipUrl);
      if (sha256(zip) === LIBREDWG.zipSha256) {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await fs.writeFile(cached, zip);
      }
    } else {
      console.log(`using cached ${path.relative(ROOT, cached)}`);
    }
  }

  const patch = await fs.readFile(PATCH_FILE);
  const { patched, zipSha256, files: extracted } = verifyArchive(zip, { patch });
  console.log(patched
    ? `patched build (${LIBREDWG.patchName} matches ${LIBREDWG.toolsDir}), SHA-256 ${zipSha256}`
    : `upstream archive, SHA-256 OK ${zipSha256}`);

  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });
  for (const [name, data] of extracted) await fs.writeFile(path.join(OUT_DIR, name), data);
  await fs.copyFile(path.join(ROOT, 'scripts', 'libredwg', 'COPYING'), path.join(OUT_DIR, 'COPYING'));
  if (patched) await fs.copyFile(PATCH_FILE, path.join(OUT_DIR, LIBREDWG.patchName));
  await fs.writeFile(
    path.join(OUT_DIR, 'README-SOURCE.txt'),
    readmeSource(extracted.map(([n, d]) => [n, sha256(d)]), { patched, zipSha256 }).replace(/\n/g, '\r\n'),
  );
  console.log(`extracted ${extracted.map(([n]) => n).join(', ')} + COPYING${patched ? ` + ${LIBREDWG.patchName}` : ''}`
    + ` + README-SOURCE.txt -> ${path.relative(ROOT, OUT_DIR)}`);

  if (srcIdx >= 0) {
    const dir = argv[srcIdx + 1];
    if (!dir) throw new Error('--source needs a destination directory');
    await verifiedSource(path.resolve(dir));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`fetch-libredwg: ${err.message}`);
    process.exit(1);
  });
}
