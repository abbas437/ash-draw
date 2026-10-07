#!/usr/bin/env node
// Copies browser-ready ES modules of the runtime dependencies into renderer/vendor/.
//   pdf-lib.esm.js     <- pdf-lib/dist/pdf-lib.esm.min.js (self-contained ESM)
//   fontkit.esm.js     <- @pdf-lib/fontkit/dist/fontkit.umd.min.js (UMD, pako bundled) wrapped as ESM
// The fontkit .es.js build is NOT used because it imports the bare specifier "pako".
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'renderer', 'vendor');

const pkg = async (name) => JSON.parse(await fs.readFile(path.join(NM, name, 'package.json'), 'utf8'));
const stripMap = (s) => s.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');

function wrapUmd(code, header, pick) {
  return `${header}
// UMD bundle evaluated against a private CommonJS-style module object; no globals are created.
const module = { exports: {} };
const exports = module.exports;
${stripMap(code)}
const __lib = ${pick};
export default __lib;
`;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  const pdf = await pkg('pdf-lib');
  const pdfCode = await fs.readFile(path.join(NM, 'pdf-lib/dist/pdf-lib.esm.min.js'), 'utf8');
  if (/^\s*import\s|from\s*["'][^./]/m.test(pdfCode.slice(0, 2000))) throw new Error('pdf-lib ESM bundle has bare imports');
  await fs.writeFile(path.join(OUT, 'pdf-lib.esm.js'),
    `// pdf-lib ${pdf.version} (${pdf.license}) - see THIRD-PARTY-NOTICES.md\n${stripMap(pdfCode)}`);

  const fk = await pkg('@pdf-lib/fontkit');
  const fkCode = await fs.readFile(path.join(NM, '@pdf-lib/fontkit/dist/fontkit.umd.min.js'), 'utf8');
  await fs.writeFile(path.join(OUT, 'fontkit.esm.js'), wrapUmd(fkCode,
    `// @pdf-lib/fontkit ${fk.version} (${fk.license}; bundles pako, MIT AND Zlib) - see THIRD-PARTY-NOTICES.md`,
    'module.exports.default ?? module.exports',
  ));

  const files = await fs.readdir(OUT);
  console.log(`vendor: ${files.sort().join(', ')} -> ${path.relative(ROOT, OUT)}`);
}

main().catch((err) => { console.error(`vendor: ${err.message}`); process.exit(1); });
