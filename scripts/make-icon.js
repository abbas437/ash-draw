#!/usr/bin/env node
// Generates build/icon.png (512x512, original artwork) from an inline SVG using sharp.
// electron-builder converts it to the Windows .ico at build time.
// Design: deep ink-green rounded square, stone drafting sheet with a measured grid,
// brass compass arc (pivot, radius line, arc and pencil point) and a small brass
// "ASH" wordmark. No third-party marks or imagery, no stylised letterform.
// sharp is not a project dependency; it is resolved from SHARP_PATH or the sandbox's
// global tools folder. Re-run only when the artwork changes; the PNG is committed.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire('/opt/npm-tools/node_modules/');
const sharp = require(process.env.SHARP_PATH || 'sharp');

// Drafting sheet and grid.
const sheet = { x: 88, y: 72, w: 336, h: 296 };
const grid = [];
for (let i = 1; i < sheet.w / 28; i++) {
  const x = sheet.x + i * 28;
  grid.push(`<line x1="${x}" y1="${sheet.y + 6}" x2="${x}" y2="${sheet.y + sheet.h - 6}" stroke-width="${i % 4 ? 2 : 4}"/>`);
}
for (let j = 1; j < sheet.h / 28; j++) {
  const y = sheet.y + j * 28;
  grid.push(`<line x1="${sheet.x + 6}" y1="${y}" x2="${sheet.x + sheet.w - 6}" y2="${y}" stroke-width="${j % 4 ? 2 : 4}"/>`);
}

// Compass arc: pivot C, radius r, swept from 8 deg to 78 deg (screen y up).
const C = { x: 144, y: 332 };
const r = 224;
const at = (deg) => {
  const a = (deg * Math.PI) / 180;
  return { x: +(C.x + r * Math.cos(a)).toFixed(2), y: +(C.y - r * Math.sin(a)).toFixed(2) };
};
const p0 = at(8);
const p1 = at(78);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1d4a3c"/><stop offset="1" stop-color="#0f2c23"/>
    </linearGradient>
    <linearGradient id="brass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e0bb68"/><stop offset="1" stop-color="#a77c2c"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="104" fill="url(#bg)"/>
  <rect x="${sheet.x}" y="${sheet.y}" width="${sheet.w}" height="${sheet.h}" rx="20" fill="#e6dfcf"/>
  <g stroke="#c8bea7">${grid.join('')}</g>
  <line x1="${C.x}" y1="${C.y}" x2="${p0.x}" y2="${p0.y}" stroke="#123329" stroke-width="8" stroke-linecap="round"/>
  <line x1="${C.x}" y1="${C.y}" x2="${p1.x}" y2="${p1.y}" stroke="#123329" stroke-width="6" stroke-linecap="round" stroke-dasharray="14 12"/>
  <path d="M ${p0.x} ${p0.y} A ${r} ${r} 0 0 0 ${p1.x} ${p1.y}" fill="none" stroke="url(#brass)" stroke-width="20" stroke-linecap="round"/>
  <circle cx="${C.x}" cy="${C.y}" r="22" fill="url(#brass)"/>
  <circle cx="${C.x}" cy="${C.y}" r="8" fill="#123329"/>
  <circle cx="${p1.x}" cy="${p1.y}" r="14" fill="#123329"/>
  <text x="256" y="446" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700"
        font-size="58" letter-spacing="14" fill="url(#brass)">ASH</text>
</svg>`;

const out = join(root, 'build', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
const info = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
console.log(`make-icon: wrote build/icon.png ${info.width}x${info.height}`);
