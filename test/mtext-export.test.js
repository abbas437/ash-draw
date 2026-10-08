// MTEXT: group 44 round trip, rich SVG / PDF export
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { newDocument, addEntity, makeMText } from '../src/core/model.js';
import { exportSvg } from '../src/core/exportSvg.js';
import { exportPdf } from '../src/core/exportPdf.js';

const docWith = (...ents) => { const d = newDocument(); for (const e of ents) addEntity(d, e); return d; };

test('MTEXT line spacing factor (group 44) round-trips', () => {
  const out = writeDxf(docWith(makeMText({ x: 0, y: 0 }, 2, 'a\\Pb', { lineSpacing: 1.5 }), makeMText({ x: 0, y: 9 }, 2, 'c')));
  const [a, c] = readDxf(Buffer.from(out)).entities;
  assert.equal(a.lineSpacing, 1.5);
  assert.equal(c.lineSpacing, 1);
});

test('SVG: MTEXT runs export as styled text elements with decoration lines', () => {
  const svg = exportSvg(docWith(makeMText({ x: 0, y: 0 }, 2.5, 'plain {\\fArial|b1|i0;Bold} {\\LUnder} {\\C1;red}')));
  assert.match(svg, /<text [^>]*font-weight="bold"[^>]*>Bold<\/text>/);
  assert.match(svg, /<text [^>]*>plain<\/text>/);
  assert.doesNotMatch(svg, /font-weight="bold"[^>]*>plain</);
  assert.match(svg, /<text [^>]*fill="rgb\(255,0,0\)"[^>]*>red<\/text>/);
  const lines = [...svg.matchAll(/<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/g)];
  assert.equal(lines.length, 1, 'one underline');
  assert.ok(+lines[0][3] > +lines[0][1] && lines[0][2] === lines[0][4]);
});

const PDFTOTEXT = '/usr/bin/pdftotext';
test('PDF: MTEXT runs are drawn as text', { skip: !existsSync(PDFTOTEXT) && 'no pdftotext' }, async () => {
  const { bytes, warnings } = await exportPdf(docWith(makeMText({ x: 0, y: 0 }, 2.5, 'Alpha {\\fArial|b1|i1;Beta}\\P{\\LGamma}', { width: 0 })));
  assert.deepEqual(warnings, []);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ash-mtext-'));
  try {
    const f = path.join(tmp, 'm.pdf');
    writeFileSync(f, bytes);
    const r = spawnSync(PDFTOTEXT, [f, '-'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Alpha\s+Beta\s+Gamma/);
    const fonts = spawnSync('/usr/bin/pdffonts', [f], { encoding: 'utf8' }).stdout ?? '';
    if (fonts) assert.match(fonts, /Helvetica-BoldOblique/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
