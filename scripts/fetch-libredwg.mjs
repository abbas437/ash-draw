#!/usr/bin/env node
// Fetches the upstream LibreDWG 0.13.3 Windows x64 binaries, verifies the pinned
// SHA-256, and extracts ONLY the converter executables (and the DLLs they import)
// into build/libredwg/, together with the GPL-3.0 text and a source notice.
//
// LibreDWG is GPL-3.0-or-later. ASH Draw Studio (MIT) never links or loads it:
// the app launches these unmodified executables as separate child processes.
//
// Usage:
//   node scripts/fetch-libredwg.mjs                  download (cached in .cache/) and extract
//   node scripts/fetch-libredwg.mjs --from <zip>     use a local copy of the zip (offline)
//   node scripts/fetch-libredwg.mjs --source <dir>   also download + verify the source tarball into <dir>
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const LIBREDWG = Object.freeze({
  version: '0.13.3',
  zipName: 'libredwg-0.13.3-win64.zip',
  zipUrl: 'https://github.com/LibreDWG/libredwg/releases/download/0.13.3/libredwg-0.13.3-win64.zip',
  zipSha256: 'b5133f8b6bd71b7e682a06ef5f99c93b40d628a791c30a31924a80d258c87173',
  sourceName: 'libredwg-0.13.3.tar.xz',
  sourceUrlGithub: 'https://github.com/LibreDWG/libredwg/releases/download/0.13.3/libredwg-0.13.3.tar.xz',
  sourceUrlGnu: 'https://ftp.gnu.org/gnu/libredwg/libredwg-0.13.3.tar.xz',
  sourceReleasePage: 'https://github.com/LibreDWG/libredwg/releases/tag/0.13.3',
  // SHA-256 of the GitHub-hosted 0.13.3 source tarball, recorded 2026-10-07.
  sourceSha256: '83f1f6e78a744777a481ff4520e4cef3f8ac4b2c1c25671077ca12fe81e8816e',
  // Import closure determined with `objdump -p`: dwg2dxf.exe and dxf2dwg.exe import
  // only libredwg-0.dll (+ KERNEL32.dll, msvcrt.dll from Windows); libredwg-0.dll
  // imports only KERNEL32.dll and msvcrt.dll. libpcre2-*.dll are imported only by
  // dwggrep.exe and libiconv-2.dll by nothing we ship, so they are not bundled.
  files: ['dwg2dxf.exe', 'dxf2dwg.exe', 'libredwg-0.dll'],
});

const OUT_DIR = path.join(ROOT, 'build', 'libredwg');
const CACHE_DIR = path.join(ROOT, '.cache');

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

function readmeSource(fileHashes) {
  const L = LIBREDWG;
  return `LibreDWG ${L.version} - binaries bundled with ASH Draw Studio
==============================================================

What these files are
--------------------
The files in this folder are UNMODIFIED upstream binaries from GNU LibreDWG
version ${L.version}, taken byte-for-byte from the official Windows x64 release
archive:

  ${L.zipUrl}
  SHA-256 of that archive: ${L.zipSha256}

Files (SHA-256):
${fileHashes.map(([n, h]) => `  ${h}  ${n}`).join('\n')}

LibreDWG is free software, Copyright (C) Free Software Foundation, Inc., licensed
under the GNU General Public License version 3 or (at your option) any later
version (GPL-3.0-or-later). The full licence text is in the file COPYING in this
folder. These programs come with ABSOLUTELY NO WARRANTY.

How ASH Draw Studio uses them
-----------------------------
ASH Draw Studio is a separate program licensed under the MIT licence. It does not
link to, load or embed LibreDWG. When you open or save a DWG file, ASH Draw Studio
runs dwg2dxf.exe or dxf2dwg.exe as an independent child process with a temporary
input file and reads back the converted output file. You may replace these
executables with any other build of LibreDWG you prefer.

Corresponding source code
-------------------------
The complete corresponding source code for these binaries is the LibreDWG
${L.version} release, available at no charge from:

  ${L.sourceReleasePage}
  ${L.sourceUrlGnu}
  ${L.sourceUrlGithub}
  (SHA-256 of ${L.sourceName}: ${L.sourceSha256})

The same source tarball is also attached to each tagged ASH Draw Studio release
on the page from which the installer is distributed.

Written offer
-------------
For at least three (3) years from the date you received this copy, and for as
long as ASH Draw Studio distributes these binaries, ASH Technical & Project
Management Services (ASH PMCS) will give any third party, on request, a complete
machine-readable copy of the corresponding source code of LibreDWG ${L.version}
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
}

async function main(argv) {
  const fromIdx = argv.indexOf('--from');
  const srcIdx = argv.indexOf('--source');
  let zip;
  if (fromIdx >= 0) {
    const from = argv[fromIdx + 1];
    if (!from) throw new Error('--from needs a path to the zip');
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

  const got = sha256(zip);
  if (got !== LIBREDWG.zipSha256) {
    throw new Error(`SHA-256 mismatch for ${LIBREDWG.zipName}: expected ${LIBREDWG.zipSha256}, got ${got}. Refusing to use it.`);
  }
  console.log(`SHA-256 OK ${got}`);

  const entries = readZipEntries(zip);
  const extracted = LIBREDWG.files.map((name) => {
    const e = entries.get(name);
    if (!e) throw new Error(`${name} not found in ${LIBREDWG.zipName}`);
    return [name, extractEntry(zip, e, name)];
  });

  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });
  for (const [name, data] of extracted) await fs.writeFile(path.join(OUT_DIR, name), data);
  await fs.copyFile(path.join(ROOT, 'scripts', 'libredwg', 'COPYING'), path.join(OUT_DIR, 'COPYING'));
  await fs.writeFile(
    path.join(OUT_DIR, 'README-SOURCE.txt'),
    readmeSource(extracted.map(([n, d]) => [n, sha256(d)])).replace(/\n/g, '\r\n'),
  );
  console.log(`extracted ${extracted.map(([n]) => n).join(', ')} + COPYING + README-SOURCE.txt -> ${path.relative(ROOT, OUT_DIR)}`);

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
