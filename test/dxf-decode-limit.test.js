// readDxf must not decode a drawing as one string (V8 strings stop at ~512 M characters; 500 MB DXFs exist).
// Only readDxf is imported so this also runs against the former whole-string reader (where it fails).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDxf } from '../src/core/dxfRead.js';

const enc = (s) => new TextEncoder().encode(s);
const HEAD = (ver, cp = 'ANSI_1252') => `  0\r\nSECTION\r\n  2\r\nHEADER\r\n  9\r\n$ACADVER\r\n  1\r\n${ver}\r\n  9\r\n$DWGCODEPAGE\r\n  3\r\n${cp}\r\n  0\r\nENDSEC\r\n`;

test('readDxf never hands TextDecoder more than one line (no whole-file string)', () => {
  // a ~3 MB drawing, old version header (exercises the UTF-8 validity scan too) with non-ASCII values throughout
  const lines = [HEAD('AC1015'), '  0\r\nSECTION\r\n  2\r\nENTITIES\r\n'];
  for (let i = 0; i < 40000; i++) lines.push(`  0\r\nLINE\r\n  8\r\nLäyer${i % 7}\r\n 10\r\n${i}.25\r\n 20\r\n0.5\r\n 11\r\n${i + 1}\r\n 21\r\n7.0\r\n`);
  lines.push('  0\r\nENDSEC\r\n  0\r\nEOF\r\n');
  const bytes = enc(lines.join(''));
  assert.ok(bytes.length > 2_000_000);
  const Real = globalThis.TextDecoder;
  let maxIn = 0, calls = 0;
  globalThis.TextDecoder = class extends Real {
    decode(input, opts) { calls++; maxIn = Math.max(maxIn, input?.byteLength ?? 0); return super.decode(input, opts); }
  };
  let doc;
  try { doc = readDxf(bytes); } finally { globalThis.TextDecoder = Real; }
  assert.equal(doc.entities.length, 40000);
  assert.equal(doc.entities[3].layer, 'Läyer3');
  assert.ok(calls > 0, 'the spy saw the decoder calls');
  assert.ok(maxIn <= 8192, `largest single decode was ${maxIn} bytes`);
});
