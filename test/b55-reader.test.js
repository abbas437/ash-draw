import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readDxf, parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import * as M from '../src/core/model.js';
import { fixture, FIX } from './helpers.js';

// -- #1 incomplete DXF (cut by a download / e-mail) ---------------------------------------------------------------
function written(n = 10) {
  const doc = M.newDocument();
  for (let i = 0; i < n; i++) M.addEntity(doc, M.makeLine({ x: i, y: 0 }, { x: i, y: 1 }, {}));
  return writeDxf(doc);
}

test('a DXF cut inside ENTITIES is flagged incomplete with the section and the objects read', () => {
  const text = written(10);
  const a = text.indexOf('ENTITIES'), b = text.indexOf('ENDSEC', a);
  // cut two-thirds through ENTITIES, at a line end (no ENDSEC, no EOF after it)
  let cut = a + Math.floor((b - a) * 2 / 3);
  cut = text.indexOf('\n', cut) + 1;
  const doc = parseDxf(text.slice(0, cut));
  assert.equal(doc.header.incomplete?.section, 'ENTITIES');
  assert.ok(doc.header.incomplete.objects > 0 && doc.header.incomplete.objects < 10, `objects ${doc.header.incomplete.objects}`);
  assert.equal(doc.header.incomplete.objects, doc.entities.length);
});

test('a DXF whose sections all end but that has no EOF is incomplete; one cut inside BLOCKS names BLOCKS', () => {
  const text = written(3);
  const noEof = text.slice(0, text.lastIndexOf('EOF')).replace(/\s*0\s*$/, '\n');
  assert.deepEqual(parseDxf(noEof).header.incomplete, { section: null, objects: 3 });
  const blk = text.indexOf('BLOCKS');
  assert.equal(parseDxf(text.slice(0, text.indexOf('\n', blk + 40) + 1)).header.incomplete?.section, 'BLOCKS');
});

test('complete files are not flagged: fixtures, EOF without a trailing newline, LF-only, CRLF, a minimal R12 file', () => {
  for (const name of readdirSync(FIX).filter((n) => n.endsWith('.dxf') && n !== 'binary_sentinel.dxf')) {
    assert.equal(readDxf(fixture(name)).header.incomplete, undefined, name);
  }
  const text = written(2);
  assert.equal(parseDxf(text).header.incomplete, undefined);
  assert.equal(parseDxf(text.replace(/\s+$/, '')).header.incomplete, undefined, 'ends in "0\\nEOF" without a newline');
  assert.equal(parseDxf(text.replace(/\r\n/g, '\n')).header.incomplete, undefined, 'LF only');
  assert.equal(parseDxf(text.replace(/\r?\n/g, '\r\n')).header.incomplete, undefined, 'CRLF');
  // R12-style minimal file: ENTITIES only, no HEADER / TABLES / BLOCKS / OBJECTS
  const r12 = '0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF';
  const d = parseDxf(r12);
  assert.equal(d.entities.length, 1);
  assert.equal(d.header.incomplete, undefined);
});
