// DWG <-> DXF through the bundled LibreDWG converter programs.
// Skipped unless the converters are available: set ASH_LIBREDWG_DIR to a folder holding dwg2dxf / dxf2dwg
// (the Windows build downloads them into build/libredwg), or have them on PATH.
// ASH_SAMPLE_DWG_DIR (optional) points at a folder of *.dwg files that are read end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import * as M from '../src/core/model.js';
import { compareDocuments } from '../src/core/verify.js';
import { fixture, ezdxfAvailable, validateWithEzdxf } from './helpers.js';

const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);
function tool(name) {
  const dir = process.env.ASH_LIBREDWG_DIR;
  if (dir && existsSync(path.join(dir, exe(name)))) return path.join(dir, exe(name));
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}
const DWG2DXF = tool('dwg2dxf');
const DXF2DWG = tool('dxf2dwg');
const have = !!(DWG2DXF && DXF2DWG);

function run(bin, args) {
  return spawnSync(bin, args, { encoding: 'utf8', timeout: 120000, env: { ...process.env, PATH: `${path.dirname(bin)}${path.delimiter}${process.env.PATH}` } });
}

for (const name of ['basic_r2000.dxf', 'blocks_r2000.dxf', 'text_r2000.dxf', 'polylines_r2000.dxf', 'splines_r2000.dxf', 'colors_r2000.dxf', 'dims_r2000.dxf']) {
  test(`DXF -> DWG -> DXF keeps the drawing: ${name}`, { skip: !have && 'LibreDWG converters not available' }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ash-draw-dwg-'));
    try {
      const src = readDxf(fixture(name));
      writeFileSync(path.join(dir, 'a.dxf'), writeDxf(src, { dimensionsAsGeometry: true }));
      let r = run(DXF2DWG, ['-y', '-o', path.join(dir, 'a.dwg'), path.join(dir, 'a.dxf')]);
      assert.equal(r.status, 0, `dxf2dwg: ${r.stderr}`);
      r = run(DWG2DXF, ['-y', '-o', path.join(dir, 'b.dxf'), path.join(dir, 'a.dwg')]);
      assert.equal(r.status, 0, `dwg2dxf: ${r.stderr}`);
      const back = readDxf(readFileSync(path.join(dir, 'b.dxf')));
      const a = M.countByType(src), b = M.countByType(back);
      for (const type of ['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'TEXT', 'MTEXT', 'SPLINE', 'ELLIPSE', 'POINT']) {
        assert.equal(b[type] ?? 0, a[type] ?? 0, `${name}: ${type}`);
      }
      assert.equal(back.entities.length >= src.entities.length - 1, true);
      for (const l of src.layers.keys()) assert.ok([...back.layers.keys()].some((k) => k.toUpperCase() === l.toUpperCase()), `layer ${l}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('geometry survives the DWG round trip numerically', { skip: !have && 'LibreDWG converters not available' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ash-draw-dwg-'));
  try {
    const doc = M.newDocument();
    M.addEntity(doc, M.makeLine({ x: 1.25, y: -3.5 }, { x: 100.125, y: 42 }));
    M.addEntity(doc, M.makeCircle({ x: 10, y: 20 }, 7.5));
    M.addEntity(doc, M.makeArc({ x: 0, y: 0 }, 10, 30, 200));
    M.addEntity(doc, M.makePolyline([{ x: 0, y: 0, bulge: 0.5 }, { x: 10, y: 0 }, { x: 10, y: 10 }], true));
    M.addEntity(doc, M.makeText({ x: 3, y: 4 }, 2.5, 'Duct Ø 400', { rot: 15 }));
    writeFileSync(path.join(dir, 'g.dxf'), writeDxf(doc));
    assert.equal(run(DXF2DWG, ['-y', '-o', path.join(dir, 'g.dwg'), path.join(dir, 'g.dxf')]).status, 0);
    assert.equal(run(DWG2DXF, ['-y', '-o', path.join(dir, 'h.dxf'), path.join(dir, 'g.dwg')]).status, 0);
    const back = readDxf(readFileSync(path.join(dir, 'h.dxf')));
    const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-6, `${x} !~ ${y}`);
    const ln = back.entities.find((e) => e.type === 'LINE');
    near(ln.p1.x, 1.25); near(ln.p1.y, -3.5); near(ln.p2.x, 100.125);
    near(back.entities.find((e) => e.type === 'CIRCLE').r, 7.5);
    const arc = back.entities.find((e) => e.type === 'ARC');
    near(arc.a0, 30); near(arc.a1, 200);
    const pl = back.entities.find((e) => e.type === 'LWPOLYLINE');
    near(pl.vertices[0].bulge, 0.5); assert.equal(pl.closed, true);
    // Known limit of LibreDWG 0.13.x: text rotation / width factor are not kept when writing DWG.
    // The app detects this with compareDocuments() and tells the user; here we only require the wording to survive.
    const tx = back.entities.find((e) => e.type === 'TEXT');
    assert.equal(tx.text, 'Duct \u00D8 400');
    const cmp = compareDocuments(doc, back);
    assert.equal(cmp.mismatched.LINE, undefined);
    assert.equal(cmp.mismatched.CIRCLE, undefined);
    assert.equal(cmp.mismatched.ARC, undefined);
    assert.equal(cmp.mismatched.LWPOLYLINE, undefined);
    assert.deepEqual(cmp.counts.TEXT, [1, 1]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sample DWG files of several versions open and re-save', { skip: !(have && process.env.ASH_SAMPLE_DWG_DIR) && 'set ASH_SAMPLE_DWG_DIR and install LibreDWG to run' }, (t) => {
  const dir = process.env.ASH_SAMPLE_DWG_DIR;
  const files = readdirSync(dir).filter((f) => /\.dwg$/i.test(f));
  assert.ok(files.length > 0);
  const tmp = mkdtempSync(path.join(tmpdir(), 'ash-draw-dwg-'));
  try {
    for (const f of files) {
      const out = path.join(tmp, `${f}.dxf`);
      const r = run(DWG2DXF, ['-y', '-o', out, path.join(dir, f)]);
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
      const doc = readDxf(readFileSync(out));
      assert.ok(doc.entities.length > 0, `${f}: has entities`);
      const resaved = path.join(tmp, `re_${f}.dxf`);
      writeFileSync(resaved, writeDxf(doc, { dimensionsAsGeometry: true }));
      if (ezdxfAvailable()) { const v = validateWithEzdxf(resaved); assert.equal(v.audit_errors, 0, `${f}: ${JSON.stringify(v.audit_messages)}`); }
      const dwg = path.join(tmp, `re_${f}`);
      assert.equal(run(DXF2DWG, ['-y', '-o', dwg, resaved]).status, 0, `${f}: re-save to DWG`);
      assert.ok(existsSync(dwg));
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  void t; void execFileSync;
});
