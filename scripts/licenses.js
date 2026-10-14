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

const HAND_WRITTEN = `## LibreDWG 0.14.8597 (GPL-3.0-or-later) - separate program, not part of the MIT-licensed app

The Windows build ships LibreDWG 0.14.8597 executables
\`dwg2dxf.exe\`, \`dxf2dwg.exe\` and their library \`libredwg-0.dll\`, plus GNU libiconv's \`libiconv-2.dll\`
(LGPL-2.1-or-later, an unmodified separate DLL from the upstream archive, used only by libredwg), in
\`resources/libredwg/\`. Release builds ship LibreDWG converters built from the upstream 0.14.8597 source
with one patch (\`tools/libredwg-win/libredwg-llp64-bitpos.patch\`, fixing false "buffer underflow" errors
past 256 MiB on 64-bit Windows); \`resources/libredwg/README-SOURCE.txt\` next to the converters states which
build a given copy contains. ASH Draw Studio does not link to or load LibreDWG; it runs
these programs as separate child processes (\`execFile\`, no shell) to convert DWG
files to and from DXF through temporary files. LibreDWG is licensed under the GNU
General Public License version 3 or later; the full text is shipped as
\`resources/libredwg/COPYING\`, and \`resources/libredwg/README-SOURCE.txt\` contains
the source-code locations and a written offer.

- Upstream binaries (the patched build reuses their \`libiconv-2.dll\`): https://github.com/LibreDWG/libredwg/releases/download/0.14.8597/libredwg-0.14.8597-win64.zip
  (SHA-256 7fee5c67c4f451f0542c0d6a3b12e91e99b15faf363fbf8b98ad84bac17ddfa2)
- Corresponding source: https://github.com/LibreDWG/libredwg/releases/tag/0.14.8597 and
  https://github.com/LibreDWG/libredwg/releases/download/0.14.8597/libredwg-0.14.8597.tar.xz, plus the
  patch and build scripts in \`tools/libredwg-win/\` (also attached to each release as
  \`libredwg-0.14.8597-llp64-bitpos.patch\` and \`libredwg-0.14.8597-win64-build-tools.tar.gz\`)
- Copyright (C) Free Software Foundation, Inc. No warranty.

This is the one deliberate exception to the permissive-licence allow-list, which
applies to npm packages only.

## Electron and Chromium

The application runtime is Electron (MIT, Copyright (c) Electron contributors,
Copyright (c) 2013-2020 GitHub Inc.), which embeds Chromium, Node.js and their
dependencies under their own licences. Electron ships the complete notices with every
build as \`LICENSE.electron.txt\` and \`LICENSES.chromium.html\` in the installation folder.

## Noto Sans, Noto Sans Arabic, Noto Sans Math (OFL-1.1) - PDF text fonts

\`renderer/assets/fonts/\` holds subsets (made with fontTools \`pyftsubset\`, outlines and OpenType layout unchanged) of
the unhinted Noto Sans Regular (Latin, Greek, Cyrillic, punctuation, currency and letterlike symbols), Noto Sans
Arabic Regular (whole font) and Noto Sans Math Regular (arrows, mathematical operators, technical symbols, geometric
shapes) from https://github.com/notofonts/notofonts.github.io (\`fonts/<family>/unhinted/ttf/\`). The PDF export embeds
the glyphs it uses for text outside the WinAnsi character set. The subsets keep the original names (no Reserved Font
Name is declared).

\`\`\`text
Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)
Copyright 2022 The Noto Project Authors (https://github.com/notofonts/arabic)
Copyright 2022 The Noto Project Authors (https://github.com/notofonts/math)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
\`\`\`

## Hershey Fonts - Roman Simplex glyph data (public domain font; distribution notice below)

\`src/core/hersheyFutural.js\` holds the glyphs of \`futural.jhf\` (ASCII 32-127, about 5 KB) from the
Hershey Fonts distribution (https://github.com/kamalmostafa/hershey-fonts), used as the stroke substitute
for AutoCAD SHX fonts (see docs/FONTS.md). Distribution notice:

\`\`\`text
This distribution of the Hershey Fonts may be used by anyone for any purpose, commercial or otherwise,
providing that:
  1. The following acknowledgements must be distributed with the font data:
     - The Hershey Fonts were originally created by Dr. A. V. Hershey while working at the U. S.
       National Bureau of Standards.
     - The format of the Font data in this distribution was originally created by
       James Hurt, Cognition, Inc., 900 Technology Park Drive, Billerica, MA 01821
       (mit-eddie!ci-dandelion!hurt)
  2. The font data in this distribution may be converted into any other format *EXCEPT* the format
     distributed by the U.S. NTIS (which organization holds the rights to the distribution and use of
     the font data in that particular format).
\`\`\`
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
