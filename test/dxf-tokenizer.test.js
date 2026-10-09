// Byte-level DXF tokenizer: same tokens as the former whole-string tokenizer, and never one huge decode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tokenizeDxf, readDxf } from '../src/core/dxfRead.js';
import { FIX, fixture } from './helpers.js';

// ---- reference: the tokenizer as it was before the byte-level rewrite (whole file -> one string -> lines) ----------
const CODEPAGE_LABEL = { ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_932: 'shift_jis' };
function refDecode(bytes) {
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const body = start ? bytes.subarray(start) : bytes;
  const peek = new TextDecoder('latin1').decode(body.subarray(0, 8192));
  const ver = /\$ACADVER\s+1\s+(AC\d+)/.exec(peek)?.[1] ?? '';
  const cp = /\$DWGCODEPAGE\s+3\s+([^\r\n]+)/.exec(peek)?.[1]?.trim().toUpperCase();
  if (ver >= 'AC1021' || start) return new TextDecoder('utf-8').decode(body);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { /* not UTF-8 */ }
  return new TextDecoder((cp && CODEPAGE_LABEL[cp]) || 'windows-1252').decode(body);
}
const isStringCode = (c) => c < 10 || (c >= 100 && c <= 102) || c === 105 || (c >= 300 && c <= 369) || (c >= 390 && c <= 399) || (c >= 410 && c <= 419) || (c >= 430 && c <= 439) || (c >= 470 && c <= 481) || c === 999 || (c >= 1000 && c <= 1009);
function refTokens(bytes) {
  const text = refDecode(bytes);
  const codes = [], vals = [];
  let repaired = 0, lastJoined = -1, pos = 0;
  const n = text.length;
  const nextLine = () => {
    if (pos > n) return null;
    let e = text.indexOf('\n', pos);
    if (e < 0) e = n;
    let line = text.slice(pos, e);
    pos = e + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    return line;
  };
  for (;;) {
    const c = nextLine();
    if (c === null) break;
    if (c.trim() === '' && pos > n) break;
    const last = codes.length - 1;
    if (last >= 0 && !/^\s*-?\d+\s*$/.test(c) && isStringCode(codes[last]) && codes[last] !== 0) {
      vals[last] += c;
      if (lastJoined !== last) { repaired++; lastJoined = last; }
      continue;
    }
    const v = nextLine();
    if (v === null) break;
    const code = parseInt(c, 10);
    if (Number.isNaN(code)) throw Object.assign(new Error(`Not a DXF file (bad group code "${c.slice(0, 20)}" near line ${codes.length * 2 + 1}).`), { code: 'BAD_DXF' });
    codes.push(code); vals.push(v);
  }
  return { codes, vals, repaired };
}
const newTokens = (bytes) => {
  const tk = tokenizeDxf(bytes);
  return { codes: [...tk.codes], vals: Array.from({ length: tk.count }, (_, i) => tk.val(i)), repaired: tk.repaired };
};
const same = (bytes, what) => {
  let ref, err;
  try { ref = refTokens(bytes); } catch (e) { err = e; }
  if (err) { assert.throws(() => tokenizeDxf(bytes), (e) => e.code === err.code && e.message === err.message, what); return; }
  assert.deepEqual(newTokens(bytes), ref, what);
};
const enc = (s) => new TextEncoder().encode(s);
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const HEAD = (ver, cp = 'ANSI_1252') => `  0\r\nSECTION\r\n  2\r\nHEADER\r\n  9\r\n$ACADVER\r\n  1\r\n${ver}\r\n  9\r\n$DWGCODEPAGE\r\n  3\r\n${cp}\r\n  0\r\nENDSEC\r\n`;

test('tokens are identical to the former tokenizer on every fixture', () => {
  const files = readdirSync(FIX).filter((f) => f.endsWith('.dxf') && f !== 'binary_sentinel.dxf');
  assert.ok(files.length >= 15);
  for (const f of files) same(new Uint8Array(fixture(f)), f);
});

test('line and decode boundaries: CRLF, bare CR, multi-byte UTF-8, 64/65-byte values, BOM, split values, EOF forms', () => {
  const longA = 'x'.repeat(64), longB = 'y'.repeat(65), arabic = 'السلام عليكم'.repeat(5); // > 64 bytes, non-ASCII
  const body = `${HEAD('AC1032')}  0\r\nSECTION\r\n  2\r\nENTITIES\r\n  0\r\nTEXT\r\n  1\r\n${longA}\r\n  1\r\n${longB}\n  1\r\n${arabic}\r\n  1\r\ncafé\r\r\n  1\r\n€ü\n  1\r\nsplit-va\r\nlue-con\r\ntinued\r\n 10\r\n1.5\r\n  0\r\nENDSEC\r\n  0\r\nEOF\r\n`;
  same(enc(body), 'mixed CRLF/LF/CR');
  same(cat(new Uint8Array([0xef, 0xbb, 0xbf]), enc(body)), 'BOM');
  same(enc(body.replace(/\r\n$/, '')), 'no trailing newline');
  same(enc(`${body}   \r\n`), 'trailing blank line');
  same(enc(body.replace('café', '﻿café')), 'BOM bytes inside a value are kept');
  same(enc(`${body.slice(0, -2)}`), 'ends after a code line without a value');
  same(enc(body.replace(' 10\r\n1.5', ' 1x\r\n1.5')), 'non-integer code after a string value is joined');
  same(enc(body.replace(' 10\r\n1.5\r\n', ' 10\r\n1.5\r\nbad code\r\n')), 'bad group code after a number -> BAD_DXF with line number');
  same(enc(body.replace(' 10\r\n1.5\r\n', ' 10\r\n1.5\r\n  7 \r\nv\r\n')), 'non-ASCII whitespace around a group code');
  same(enc(body.replace(' 10\r\n', '-10\r\n')), 'negative group code');
});

test('old files: UTF-8 when valid, else $DWGCODEPAGE (decided over the whole body, lines decoded one at a time)', () => {
  const pre = enc(`${HEAD('AC1015', 'ANSI_1251')}  0\r\nSECTION\r\n  2\r\nENTITIES\r\n  0\r\nTEXT\r\n  1\r\n`);
  const tail = enc('\r\n  0\r\nENDSEC\r\n  0\r\nEOF\r\n');
  const cyr = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет" in windows-1251, invalid UTF-8
  same(cat(pre, cyr, tail), 'windows-1251');
  same(cat(pre, enc('Привет'), tail), 'UTF-8 in an AC1015 file');
  same(cat(pre, enc('Привет'), enc('\r\n  1\r\n'), cyr, tail), 'one bad line anywhere makes the whole file codepage');
  assert.equal(tokenizeDxf(cat(pre, cyr, tail)).val(10), 'Привет');
});

test('readDxf reports progress from 0 to 1', () => {
  const seen = [];
  readDxf(new Uint8Array(fixture('big_grid_r2000.dxf')), { onProgress: (f) => seen.push(f) });
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= seen[i - 1])), 'monotonic in [0,1]');
  assert.equal(seen.at(-1), 1);
});
