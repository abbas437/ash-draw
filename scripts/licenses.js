#!/usr/bin/env node
// Production-dependency licence scan -> THIRD-PARTY-NOTICES.md.
// Walks "dependencies" transitively from package.json (devDependencies are not shipped)
// and fails if any package's licence is outside the allow-list. LibreDWG is not an npm
// package; it is the single deliberate exception, documented in a hand-written section.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'OFL-1.1',
  'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0',
  // Zlib: permissive; required by pako ("MIT AND Zlib"), which pdf-lib and fontkit depend on.
  'Zlib']);

const readJson = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  return 'UNKNOWN';
}

/** Minimal SPDX expression check: OR needs one allowed side, AND needs all. */
export function isAllowed(expr) {
  const e = expr.trim().replace(/^\((.*)\)$/, '$1').trim();
  if (/\sOR\s/.test(e)) return e.split(/\s+OR\s+/).some(isAllowed);
  if (/\sAND\s/.test(e)) return e.split(/\s+AND\s+/).every(isAllowed);
  return ALLOWED.has(e);
}

async function resolvePkgDir(name, fromDir) {
  for (let d = fromDir; ; d = path.dirname(d)) {
    const cand = path.join(d, 'node_modules', name);
    try { await fs.access(path.join(cand, 'package.json')); return cand; } catch { /* keep walking */ }
    if (d === ROOT || d === path.dirname(d)) break;
  }
  throw new Error(`production dependency ${name} is not installed (run npm ci)`);
}

async function licenseText(dir) {
  const files = (await fs.readdir(dir)).filter((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  if (files.length) return (await fs.readFile(path.join(dir, files[0]), 'utf8')).trim();
  return null;
}

const MIT_TEMPLATE = (holder) => `Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const HAND_WRITTEN = `## LibreDWG 0.13.3 (GPL-3.0-or-later) - separate program, not part of the MIT-licensed app

The Windows build ships the **unmodified** upstream LibreDWG 0.13.3 executables
\`dwg2dxf.exe\`, \`dxf2dwg.exe\` and their library \`libredwg-0.dll\` in
\`resources/libredwg/\`. ASH Draw Studio does not link to or load LibreDWG; it runs
these programs as separate child processes (\`execFile\`, no shell) to convert DWG
files to and from DXF through temporary files. LibreDWG is licensed under the GNU
General Public License version 3 or later; the full text is shipped as
\`resources/libredwg/COPYING\`, and \`resources/libredwg/README-SOURCE.txt\` contains
the source-code locations and a written offer.

- Upstream binaries: https://github.com/LibreDWG/libredwg/releases/download/0.13.3/libredwg-0.13.3-win64.zip
  (SHA-256 b5133f8b6bd71b7e682a06ef5f99c93b40d628a791c30a31924a80d258c87173)
- Corresponding source: https://github.com/LibreDWG/libredwg/releases/tag/0.13.3 and
  https://ftp.gnu.org/gnu/libredwg/libredwg-0.13.3.tar.xz
- Copyright (C) Free Software Foundation, Inc. No warranty.

This is the one deliberate exception to the permissive-licence allow-list, which
applies to npm packages only.

## Electron and Chromium

The application runtime is Electron (MIT, Copyright (c) Electron contributors,
Copyright (c) 2013-2020 GitHub Inc.), which embeds Chromium, Node.js and their
dependencies under their own licences. Electron ships the complete notices with every
build as \`LICENSE.electron.txt\` and \`LICENSES.chromium.html\` in the installation folder.
`;

async function main() {
  const rootPkg = await readJson(path.join(ROOT, 'package.json'));
  const seen = new Map();
  const queue = Object.keys(rootPkg.dependencies ?? {}).map((n) => [n, ROOT]);
  while (queue.length) {
    const [name, from] = queue.shift();
    const dir = await resolvePkgDir(name, from);
    if (seen.has(dir)) continue;
    const pkg = await readJson(path.join(dir, 'package.json'));
    seen.set(dir, { name: pkg.name, version: pkg.version, license: licenseOf(pkg), dir, author: pkg.author });
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push([dep, dir]);
  }

  const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const bad = list.filter((p) => !isAllowed(p.license));
  for (const p of list) console.log(`${isAllowed(p.license) ? 'ok ' : 'BAD'} ${p.name}@${p.version} ${p.license}`);
  if (bad.length) {
    console.error(`licenses: ${bad.length} production dependenc${bad.length === 1 ? 'y has' : 'ies have'} a licence outside the allow-list: ${bad.map((p) => `${p.name}@${p.version} (${p.license})`).join(', ')}`);
    process.exit(1);
  }

  let md = `# Third-party notices\n\nASH Draw Studio is MIT-licensed (see LICENSE). It includes the following third-party\nsoftware. This file is generated by \`npm run licenses\`; do not edit by hand.\n\n## npm production dependencies\n\n| Package | Version | Licence |\n|---|---|---|\n`;
  md += list.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`).join('\n') + '\n\n';
  for (const p of list) {
    let text = await licenseText(p.dir);
    if (!text) {
      const holder = typeof p.author === 'string' ? p.author : p.author?.name ?? `the ${p.name} authors`;
      text = `(No licence file in the published package; package.json declares ${p.license}.)\n\n${p.license === 'MIT' ? MIT_TEMPLATE(holder) : ''}`.trim();
    }
    md += `### ${p.name} ${p.version} - ${p.license}\n\n\`\`\`text\n${text}\n\`\`\`\n\n`;
  }
  md += HAND_WRITTEN;
  await fs.writeFile(path.join(ROOT, 'THIRD-PARTY-NOTICES.md'), md);
  console.log(`licenses: ${list.length} production packages OK -> THIRD-PARTY-NOTICES.md`);
}

main().catch((err) => { console.error(`licenses: ${err.message}`); process.exit(1); });
