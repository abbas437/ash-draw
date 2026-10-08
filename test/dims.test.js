import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as M from '../src/core/model.js';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { defaultDimStyle, DIMVARS } from '../src/core/dimsStyle.js';
import {
  buildDimension, formatLinear, continueDimension, baselineDimension, createDimension, regenerateDimension,
} from '../src/core/dims.js';
import { ezdxfAvailable, validateWithEzdxf } from './helpers.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const ISO = defaultDimStyle('ISO-25');
const P = (x, y) => ({ x, y });

test('linear horizontal (0,0)-(100,0) at y=20, ISO-25', () => {
  const r = buildDimension({ kind: 'linear', p1: P(0, 0), p2: P(100, 0), at: P(50, 20), angle: 0 }, ISO);
  assert.equal(r.measurement, 100);
  assert.equal(r.text, '100');
  const lines = r.entities.filter((e) => e.type === 'LINE');
  const dimLine = lines.filter((l) => l.p1.y === 20 && l.p2.y === 20);
  assert.equal(dimLine.length, 1);
  near(dimLine[0].p1.x, 0); near(dimLine[0].p2.x, 100);
  const ext = lines.filter((l) => l.p1.x === l.p2.x).sort((a, b) => a.p1.x - b.p1.x);
  assert.equal(ext.length, 2);
  for (const [l, x] of [[ext[0], 0], [ext[1], 100]]) { near(l.p1.x, x); near(l.p1.y, ISO.DIMEXO); near(l.p2.y, 20 + ISO.DIMEXE); }
  const arrows = r.entities.filter((e) => e.type === 'SOLID');
  assert.equal(arrows.length, 2);
  assert.deepEqual(arrows.map((a) => a.pts[0].x).sort((a, b) => a - b), [0, 100]);
  assert.ok(arrows[0].pts.every((p) => p.x >= -1e-9 && p.x <= 100 + 1e-9), 'arrows inside the extension lines');
});

test('DIMTAD places the text above, centred or below the dimension line', () => {
  const def = { kind: 'linear', p1: P(0, 0), p2: P(100, 0), at: P(50, 20), angle: 0 };
  const above = buildDimension(def, ISO);
  near(above.textMid.x, 50); near(above.textMid.y, 20 + ISO.DIMGAP + ISO.DIMTXT / 2);
  const centred = buildDimension(def, { ...ISO, DIMTAD: 0 });
  near(centred.textMid.y, 20);
  // centred text breaks the dimension line
  assert.equal(centred.entities.filter((e) => e.type === 'LINE' && e.p1.y === 20).length, 2);
  const below = buildDimension(def, { ...ISO, DIMTAD: 4 });
  near(below.textMid.y, 20 - ISO.DIMGAP - ISO.DIMTXT / 2);
});

test('aligned, angular, radius, diameter, override and units', () => {
  assert.equal(buildDimension({ kind: 'aligned', p1: P(0, 0), p2: P(3, 4), at: P(-4, 3) }, ISO).text, '5');
  assert.equal(buildDimension({ kind: 'aligned', p1: P(0, 0), p2: P(3, 4), at: P(-4, 3) }, defaultDimStyle('Standard')).text, '5.0000');
  const ang = buildDimension({ kind: 'angular', l1: [P(0, 0), P(10, 0)], l2: [P(0, 0), P(0, 10)], at: P(5, 5) }, ISO);
  near(ang.measurement, Math.PI / 2); assert.equal(ang.text, '90°');
  assert.equal(buildDimension({ kind: 'angular3', vertex: P(0, 0), p1: P(10, 0), p2: P(0, 10), at: P(-5, -5) }, ISO).text, '270°');
  assert.equal(buildDimension({ kind: 'radius', center: P(0, 0), p: P(25, 0) }, ISO).text, 'R25');
  assert.equal(buildDimension({ kind: 'diameter', center: P(0, 0), p: P(0, 25) }, ISO).text, 'Ø50');
  assert.equal(buildDimension({ kind: 'linear', p1: P(0, 0), p2: P(10, 0), at: P(0, 5), text: 'L=<> mm' }, ISO).text, 'L=10 mm');
  assert.equal(buildDimension({ kind: 'linear', p1: P(0, 0), p2: P(10, 0), at: P(0, 5) }, { ...ISO, DIMLFAC: 2 }).text, '20');
  const st = defaultDimStyle('Standard');
  assert.equal(formatLinear(1230.5, { ...st, DIMLUNIT: 4 }), '102\'-6 1/2"');
  assert.equal(formatLinear(1234.5, { ...st, DIMLUNIT: 4 }), '102\'-10 1/2"');
  assert.equal(formatLinear(1234.5, { ...st, DIMLUNIT: 3, DIMDEC: 2 }), '102\'-10.50"');
  assert.equal(formatLinear(12.345, { ...ISO }), '12,35');
  assert.equal(formatLinear(12.3, { ...st, DIMRND: 0.25, DIMDEC: 2 }), '12.25');
});

test('continue and baseline produce the next definitions', () => {
  const prev = { kind: 'linear', p1: P(0, 0), p2: P(100, 0), at: P(50, 20), angle: 0 };
  assert.deepEqual(continueDimension(prev, P(150, 0)), { kind: 'linear', p1: P(100, 0), p2: P(150, 0), at: P(50, 20), angle: 0 });
  const b = baselineDimension(prev, P(150, 0), ISO);
  assert.deepEqual(b.p1, P(0, 0)); assert.deepEqual(b.p2, P(150, 0)); near(b.at.y, 20 + ISO.DIMDLI);
  const below = baselineDimension({ ...prev, at: P(50, -20) }, P(150, 0), ISO);
  near(below.at.y, -20 - ISO.DIMDLI);
  const a3 = { kind: 'angular3', vertex: P(0, 0), p1: P(10, 0), p2: P(0, 10), at: P(5, 5) };
  const c = continueDimension(a3, P(-10, 0));
  assert.deepEqual(c.p1, P(0, 10));
  assert.equal(buildDimension(c, ISO).text, '90°');
  const bl = baselineDimension(a3, P(-10, 0), ISO);
  assert.equal(buildDimension(bl, ISO).text, '180°');
});

test('DIMSTYLE variables survive write and read', () => {
  const doc = M.newDocument();
  const custom = {
    ...defaultDimStyle('ARCH'), DIMPOST: '<> mm', DIMSCALE: 50, DIMASZ: 3, DIMTXT: 2, DIMEXO: 1, DIMEXE: 2, DIMGAP: 0.5, DIMDLI: 7,
    DIMDEC: 3, DIMLUNIT: 4, DIMRND: 0.5, DIMTAD: 4, DIMJUST: 2, DIMTIH: 1, DIMTOH: 1, DIMCLRD: 1, DIMCLRE: 3, DIMCLRT: 5,
    DIMBLK: '_ARCHTICK', DIMTXSTY: 'Romans', DIMLFAC: 0.5, DIMADEC: 1, DIMAUNIT: 1, DIMTOFL: 0, DIMZIN: 3, DIMAZIN: 2, DIMDSEP: 46,
  };
  M.addTextStyle(doc, { name: 'Romans', font: 'romans', height: 0, widthFactor: 1, oblique: 0 });
  doc.dimStyles = new Map([['ARCH', custom], ['ISO-25', defaultDimStyle('ISO-25')]]);
  const back = readDxf(Buffer.from(writeDxf(doc)));
  for (const n of ['ARCH', 'ISO-25']) {
    const got = back.dimStyles.get(n);
    assert.ok(got, n);
    const want = doc.dimStyles.get(n);
    for (const k of Object.keys(DIMVARS)) assert.equal(String(got[k]).toUpperCase(), String(want[k]).toUpperCase(), `${n}.${k}`);
  }
  assert.ok(back.blocks.has('_ARCHTICK'), 'arrow block written for DIMBLK');
});

test('created dimensions are stored, saved and regenerated', () => {
  const doc = M.newDocument();
  const e = createDimension(doc, { kind: 'linear', p1: P(0, 0), p2: P(100, 0), at: P(50, 20), angle: 0 });
  assert.ok(doc.blocks.get(e.block).entities.length >= 6);
  const back = readDxf(Buffer.from(writeDxf(doc)));
  const d = back.entities.find((x) => x.type === 'DIMENSION');
  assert.equal(d.style, 'ISO-25');
  assert.deepEqual(d.def.p2, P(100, 0));
  assert.ok(back.blocks.get(d.block).entities.some((x) => x.type === 'MTEXT' && x.text === '100'));
  // a read dimension keeps its block until regenerated
  d.def.p2 = P(80, 0);
  assert.ok(back.blocks.get(d.block).entities.some((x) => x.type === 'MTEXT' && x.text === '100'));
  regenerateDimension(back, d);
  assert.ok(back.blocks.get(d.block).entities.some((x) => x.type === 'MTEXT' && x.text === '80'));
  assert.equal(d.raw, null);
});

test('every dimension type is read by ezdxf as a real dimension', { skip: !ezdxfAvailable() && 'ezdxf not installed' }, (t) => {
  const doc = M.newDocument();
  const defs = [
    { kind: 'linear', p1: P(0, 0), p2: P(100, 0), at: P(50, 20), angle: 0 },
    { kind: 'linear', p1: P(0, 0), p2: P(30, 40), at: P(-20, 0), angle: 90 },
    { kind: 'aligned', p1: P(0, 0), p2: P(30, 40), at: P(-8, 6) },
    { kind: 'angular', l1: [P(200, 0), P(210, 0)], l2: [P(200, 0), P(200, 10)], at: P(205, 5) },
    { kind: 'angular3', vertex: P(300, 0), p1: P(310, 0), p2: P(300, 10), at: P(305, 5) },
    { kind: 'radius', center: P(400, 0), p: P(425, 0) },
    { kind: 'diameter', center: P(500, 0), p: P(500, 25) },
  ];
  const ours = defs.map((d) => createDimension(doc, d));
  const dir = mkdtempSync(path.join(tmpdir(), 'ashdims-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'dims.dxf');
  writeFileSync(file, writeDxf(doc));
  const audit = validateWithEzdxf(file);
  assert.equal(audit.audit_errors, 0, JSON.stringify(audit.audit_messages));
  assert.equal(audit.counts.DIMENSION, defs.length);
  const py = [
    'import ezdxf, json, sys',
    'doc = ezdxf.readfile(sys.argv[1])',
    'out = []',
    'for d in doc.modelspace().query("DIMENSION"):',
    '    out.append(dict(block=d.dxf.geometry in doc.blocks, dimtype=d.dimtype, actual=d.dxf.actual_measurement, measured=float(d.get_measurement()), d1314=(d.dxf.defpoint3 - d.dxf.defpoint2).magnitude, style=d.dxf.dimstyle))',
    'print(json.dumps(out))',
  ].join('\n');
  const r = spawnSync(ezdxfAvailable(), ['-c', py, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.length, ours.length);
  got.forEach((g, i) => {
    assert.ok(g.block, `${i} block`);
    assert.equal(g.dimtype, ours[i].dimType, `${i} dimtype`);
    near(g.actual, ours[i].measurement, 1e-9);
    // ezdxf reports angles in degrees; for aligned (type 1) its get_measurement() projects on angle 0, so use 13->14
    if (ours[i].dimType === 1) near(g.d1314, ours[i].measurement, 1e-9);
    else near(g.measured, ours[i].dimType === 2 || ours[i].dimType === 5 ? ours[i].measurement * 180 / Math.PI : ours[i].measurement, 1e-6);
    assert.equal(g.style, 'ISO-25');
  });
});
