import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { xlsxBytes, crc32, colName } from '../src/core/xlsx.js';

const SHEET = { name: 'Symbol count', rows: [['Symbol', 'Count', 'Layers'], ['Grille <600> & "x"', 3, 'A; B'], ['Bad\u0001char', 1.5, '']], colWidths: [30, 10, 20] };

/** the stored zip's entries from its central directory: { name: { crc, data } } (checks local headers agree) */
function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = buf.length - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'end of central directory');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let i = 0; i < n; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl));
    assert.equal(method, 0, 'stored');
    assert.equal(dv.getUint32(off, true), 0x04034b50);
    assert.equal(dv.getUint32(off + 14, true), crc);
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    out[name] = { crc, data: buf.subarray(start, start + size) };
    p += 46 + nl + xl + cl;
  }
  return out;
}

test('crc32 and column names', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(colName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
});

test('xlsxBytes: the parts, their CRCs, inline cells, escaped and cleaned text', () => {
  const z = unzip(xlsxBytes([SHEET]));
  assert.deepEqual(Object.keys(z).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  for (const { crc, data } of Object.values(z)) assert.equal(crc32(data), crc);
  const sheet = new TextDecoder().decode(z['xl/worksheets/sheet1.xml'].data);
  assert.match(sheet, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Symbol<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">Grille &lt;600&gt; &amp; &quot;x&quot;<\/t>/);
  assert.match(sheet, /<c r="B2"><v>3<\/v><\/c>/);
  assert.match(sheet, />Badchar</);
  assert.match(sheet, /<col min="1" max="1" width="30" customWidth="1"\/>/);
  assert.match(new TextDecoder().decode(z['xl/workbook.xml'].data), /<sheet name="Symbol count" sheetId="1" r:id="rId1"\/>/);
});

const hasPython = (() => { try { execFileSync('python3', ['-c', 'import zipfile, xml.dom.minidom'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('xlsxBytes: python zipfile reads it (CRC test) and every part is well-formed XML', { skip: !hasPython && 'python3 not available' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-xlsx-'));
  try {
    const file = path.join(dir, 'count.xlsx');
    await fs.writeFile(file, xlsxBytes([SHEET, { name: 'Symbol count', rows: [['Second']] }]));
    const py = 'import sys, zipfile, xml.dom.minidom as m\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nfor n in z.namelist(): m.parseString(z.read(n))\nd = m.parseString(z.read("xl/worksheets/sheet1.xml"))\nprint("|".join(t.firstChild.data if t.firstChild else "" for t in d.getElementsByTagName("t")))\nprint("|".join(v.firstChild.data for v in d.getElementsByTagName("v")))\nprint("|".join(s.getAttribute("name") for s in m.parseString(z.read("xl/workbook.xml")).getElementsByTagName("sheet")))';
    const out = execFileSync('python3', ['-I', '-c', py, file], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(out, ['Symbol|Count|Layers|Grille <600> & "x"|A; B|Badchar', '3|1.5', 'Symbol count|Symbol count_2']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
