// Raw 32-bit CmColor values (as LibreDWG passes them through from a DWG) in DIMSTYLE / group 62, and MTEXT \C0 / \C256.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { createDimension } from '../src/core/dims.js';
import { buildScene } from '../src/core/render.js';
import { runRgb } from '../src/core/exportSvg.js';
import { decodeColor, resolveColor } from '../src/core/aci.js';
import { fixture } from './helpers.js';

const P = (x, y) => ({ x, y });
const isFixedWhite = (c) => !c.auto && c.rgb.join() === '255,255,255';

test('decodeColor: ACI kept, CmColor ByLayer / ByBlock / ACI / true colour / none decoded, garbage unresolvable', () => {
  assert.equal(decodeColor(5), 5);
  assert.equal(decodeColor(-3), -3);
  assert.equal(decodeColor(-1073741824), 256);          // 0xC0000000 ByLayer
  assert.equal(decodeColor(-1056964608), 0);            // 0xC1000000 ByBlock
  assert.equal(decodeColor(-1023410175), 1);            // 0xC3000001 ACI 1
  assert.equal(decodeColor(-1023410169), 7);            // 0xC3000007 ACI 7
  assert.deepEqual(decodeColor(3254780159), { r: 0, g: 0, b: 255 }); // 0xC20000FF true colour
  assert.equal(decodeColor(-939524096), 0);             // 0xC8000000 none -> ByBlock
  assert.equal(decodeColor(123456), undefined);
  // anything unresolvable draws in the auto foreground, never a fixed white
  assert.deepEqual(resolveColor({ color: 123456 }, null), { rgb: [255, 255, 255], auto: true });
  assert.deepEqual(resolveColor({ color: 1023 }, null), { rgb: [255, 255, 255], auto: true });
  assert.deepEqual(resolveColor({ color: -1023410175 }, null), { rgb: [255, 0, 0], auto: false });
});

test('DIMSTYLE with raw CmColor DIMCLRD/E/T: styles decode, new dimensions are ByBlock / red, never fixed white', () => {
  const doc = readDxf(fixture('cmcolor_dimstyle.dxf'));
  const std = doc.dimStyles.get('Standard'), mona = doc.dimStyles.get('MONA');
  assert.deepEqual([std.DIMCLRD, std.DIMCLRE, std.DIMCLRT], [0, 0, 0]);
  assert.deepEqual([mona.DIMCLRD, mona.DIMCLRE, mona.DIMCLRT], [1, 1, 7]);
  const d1 = createDimension(doc, { kind: 'linear', p1: P(0, 0), p2: P(100, 0), at: P(50, 20), angle: 0 }, 'Standard');
  const d2 = createDimension(doc, { kind: 'linear', p1: P(0, 0), p2: P(100, 0), at: P(50, 40), angle: 0 }, 'MONA');
  const ents = (d) => doc.blocks.get(d.block).entities;
  assert.ok(ents(d1).every((e) => e.color === 0), 'Standard: every part ByBlock');
  assert.ok(ents(d2).every((e) => (e.type === 'MTEXT' ? e.color === 7 : e.color === 1)), 'MONA: lines red, text ACI 7');
  const items = buildScene(doc).items;
  const of = (d) => items.filter((it) => it.id === d.id);
  assert.ok(of(d1).length && of(d1).every((it) => it.style.color.auto), 'Standard dimension follows the foreground (layer 0 = ACI 7)');
  assert.ok(of(d2).some((it) => it.style.color.rgb.join() === '255,0,0'), 'MONA dimension lines are red');
  assert.ok(!items.some((it) => isFixedWhite(it.style.color)), 'no item is a fixed white');
});

test('group 62 with a raw CmColor on an entity and a layer is decoded', () => {
  const doc = readDxf(fixture('cmcolor_dimstyle.dxf'));
  assert.equal(doc.layers.get('RAWBLUE').color, 5);
  assert.equal(doc.layers.get('RAWBLUE').visible, true);
  assert.equal(doc.entities.find((e) => e.type === 'LINE' && e.layer === '0').color, 2);
});

test('MTEXT \\C256 is the layer colour of the MTEXT, \\C0 / no code its own colour', () => {
  const doc = readDxf(fixture('cmcolor_dimstyle.dxf'));
  const it = buildScene(doc).items.find((x) => x.mt);
  const runs = it.mt.paras.flatMap((p) => p.runs);
  const col = (t) => runRgb(runs.find((r) => r.text === t).props.color, it.style).join();
  assert.equal(col('A'), '0,255,0', 'A: the MTEXT colour (ACI 3)');
  assert.equal(col('B'), '255,0,0', 'B after \\C256: layer RED');
});

test('round trip writes ACI 0..256 for raw CmColor DIMCLRD/E/T, group 62 and layers', () => {
  const doc = readDxf(fixture('cmcolor_dimstyle.dxf'));
  doc.dimStyles.get('Standard').DIMCLRT = -1056964608;              // a raw value still in memory is decoded on write
  doc.entities.find((e) => e.type === 'LINE').color = -1023410171;
  const txt = writeDxf(doc);
  const lines = txt.split(/\r?\n/).map((s) => s.trim());
  const vals = (code) => { const out = []; for (let i = 0; i + 1 < lines.length; i += 2) if (lines[i] === String(code)) out.push(Number(lines[i + 1])); return out; };
  for (const c of [62, 176, 177, 178]) assert.ok(vals(c).every((v) => Number.isInteger(v) && v >= -256 && v <= 256), `group ${c}: ${vals(c)}`);
  const back = readDxf(Buffer.from(txt));
  assert.deepEqual(['Standard', 'MONA'].map((n) => { const s = back.dimStyles.get(n); return [s.DIMCLRD, s.DIMCLRE, s.DIMCLRT]; }), [[0, 0, 0], [1, 1, 7]]);
  assert.equal(back.entities.find((e) => e.type === 'LINE' && e.layer === 'RED').color, 5);
  assert.equal(back.layers.get('RAWBLUE').color, 5);
});
