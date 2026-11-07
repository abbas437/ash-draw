// Plot style tables (.ctb): reading (our writer, hand-built real-format bytes, ezdxf's writer), built-in tables, errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePlotStyleTable, writePlotStyleTable, BUILTIN_TABLES, STANDARD_LINEWEIGHTS } from '../src/core/plotStyle.js';

const HEADER = 'PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec';
/** real-format file bytes of `text`: header, adler32 / sizes (uint32 LE), zlib (node's deflate, not our writer) */
function fileOf(text, { z = deflateSync(Buffer.from(`${text}\0`, 'latin1')) } = {}) {
  const out = Buffer.alloc(60 + z.length);
  out.write(HEADER, 0, 'latin1');
  out.writeUInt32LE(0, 48); out.writeUInt32LE(text.length + 1, 52); out.writeUInt32LE(z.length, 56);
  z.copy(out, 60);
  return new Uint8Array(out);
}
const STYLE = (i, body) => ` ${i}{\n  name="Color_${i + 1}\n  localized_name="Color_${i + 1}\n  description="\n${body} }`;
const REAL = [
  'description="Contractor pens', 'aci_table_available=TRUE', 'scale_factor=1.0', 'apply_factor=FALSE', 'custom_lineweight_display_units=0',
  'aci_table{', ' 0="Color_1', ' 1="Color_2', ' 2="Color_3', '}',
  'plot_style{',
  STYLE(0, '  color=-1023410176\n  mode_color=-1023410176\n  color_policy=1\n  physical_pen_number=0\n  virtual_pen_number=0\n  screen=100\n  linepattern_size=0.5\n  linetype=31\n  adaptive_linetype=TRUE\n  lineweight=10\n  fill_style=73\n  end_style=4\n  join_style=5\n'),
  STYLE(1, '  color=-1006632961\n  mode_color=-1006632961\n  color_policy=3\n  screen=50\n  linetype=1\n  lineweight=0\n  fill_style=64\n  end_style=2\n  join_style=1\n'),
  STYLE(2, '  color=-1040187137\n  mode_color=-1040187137\n  color_policy=0\n  screen=100\n  linetype=31\n  lineweight=27\n'),
  '}',
  'custom_lineweight_table{', ...STANDARD_LINEWEIGHTS.map((v, i) => ` ${i}=${v.toFixed(2)}`), ' 27=0.0076200000000 (+7.Z+"8V?S_LC )', '}', '',
].join('\n');

test('real-format CTB bytes (node zlib): header, colours, lineweight table, policy bits, appendix', () => {
  const t = parsePlotStyleTable(fileOf(REAL));
  assert.equal(t.kind, 'ctb');
  assert.equal(t.description, 'Contractor pens');
  assert.equal(t.scaleFactor, 1);
  assert.equal(t.applyGlobalScale, false);
  assert.equal(t.styles.length, 255);
  const [s1, s2, s3] = t.styles;
  assert.deepEqual([s1.name, s1.color, s1.lineweight, s1.linetype, s1.grayscale, s1.dither, s1.screening], ['Color_1', [0, 0, 0], 0.35, null, false, true, 100]);
  assert.deepEqual([s2.color, s2.lineweight, s2.linetype, s2.grayscale, s2.dither, s2.screening, s2.fill, s2.lineEnd, s2.lineJoin], [null, null, 1, true, true, 50, 64, 2, 1]);
  assert.deepEqual(s3.color, [0, 0, 255], '0xC20000FF');
  assert.equal(s3.lineweight, 0.00762, 'custom lineweight with the "(...)" appendix');
  assert.deepEqual(t.styles[200].color, null, 'a style missing from the file is "use object"');
});

test('writePlotStyleTable round-trips through parsePlotStyleTable', () => {
  const styles = Array.from({ length: 255 }, () => ({}));
  styles[0] = { color: [0, 0, 0], lineweight: 0.35 };
  styles[4] = { color: [10, 20, 30], screening: 40, grayscale: true, dither: false, linetype: 3, lineweight: 0.123, description: 'cyan pen' };
  const t = parsePlotStyleTable(writePlotStyleTable({ kind: 'ctb', description: 'Mine', scaleFactor: 2, applyGlobalScale: true, styles }));
  assert.deepEqual([t.kind, t.description, t.scaleFactor, t.applyGlobalScale], ['ctb', 'Mine', 2, true]);
  assert.deepEqual([t.styles[0].color, t.styles[0].lineweight, t.styles[0].dither], [[0, 0, 0], 0.35, true]);
  const s = t.styles[4];
  assert.deepEqual([s.color, s.screening, s.grayscale, s.dither, s.linetype, s.lineweight, s.description], [[10, 20, 30], 40, true, false, 3, 0.12, 'cyan pen']);
  assert.deepEqual([t.styles[1].color, t.styles[1].lineweight, t.styles[1].linetype, t.styles[1].screening], [null, null, null, 100]);
  const stb = parsePlotStyleTable(writePlotStyleTable({ kind: 'stb', styles: [{ name: 'Normal' }, { name: 'Thick', lineweight: 0.7, color: [255, 0, 0] }] }));
  assert.deepEqual([stb.kind, stb.styles.map((x) => x.name), stb.styles[1].lineweight, stb.styles[1].color], ['stb', ['Normal', 'Thick'], 0.7, [255, 0, 0]]);
});

test('a CTB written by ezdxf (third-party writer) parses', (t) => {
  const py = spawnSync('python3', ['-c', 'import ezdxf.addons.acadctb'], { encoding: 'utf8' });
  if (py.error || py.status !== 0) { t.skip(`python3 with ezdxf is not available: ${py.error?.message ?? py.stderr.trim()}`); return; }
  const dir = mkdtempSync(path.join(tmpdir(), 'ctb-ezdxf-'));
  try {
    const file = path.join(dir, 'pens.ctb');
    const script = [
      'import sys', 'from ezdxf.addons import acadctb',
      'ctb = acadctb.new_ctb()', 'ctb.description = "ezdxf pens"',
      's = ctb[1]', 's.color = (0, 0, 0)', 's.set_lineweight(0.35)',
      's = ctb[2]', 's.screen = 30', 's.grayscale = True', 's.dithering = False', 's.linetype = 2',
      's = ctb[5]', 's.color = (12, 34, 56)', 's.set_lineweight(0.77)',
      'ctb.save(sys.argv[1])',
    ].join('\n');
    const run = spawnSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const tb = parsePlotStyleTable(new Uint8Array(readFileSync(file)));
    assert.equal(tb.kind, 'ctb');
    assert.equal(tb.description, 'ezdxf pens');
    assert.deepEqual([tb.styles[0].color, tb.styles[0].lineweight], [[0, 0, 0], 0.35]);
    assert.deepEqual([tb.styles[1].color, tb.styles[1].screening, tb.styles[1].grayscale, tb.styles[1].dither, tb.styles[1].linetype], [null, 30, true, false, 2]);
    assert.deepEqual([tb.styles[4].color, tb.styles[4].lineweight], [[12, 34, 56], 0.77]);
    assert.deepEqual([tb.styles[6].color, tb.styles[6].lineweight, tb.styles[6].linetype], [null, null, null]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BUILTIN_TABLES: acad, monochrome, grayscale', () => {
  assert.deepEqual(Object.keys(BUILTIN_TABLES).sort(), ['acad.ctb', 'grayscale.ctb', 'monochrome.ctb']);
  for (const [name, tb] of Object.entries(BUILTIN_TABLES)) {
    assert.equal(tb.kind, 'ctb', name);
    assert.equal(tb.styles.length, 255, name);
    assert.ok(tb.styles.every((s) => s.lineweight === null && s.linetype === null && s.screening === 100), name);
    assert.deepEqual(parsePlotStyleTable(writePlotStyleTable(tb)).styles, tb.styles, `${name} survives write + parse`);
  }
  assert.ok(BUILTIN_TABLES['acad.ctb'].styles.every((s) => s.color === null && !s.grayscale));
  assert.ok(BUILTIN_TABLES['monochrome.ctb'].styles.every((s) => s.color.join() === '0,0,0'));
  assert.ok(BUILTIN_TABLES['grayscale.ctb'].styles.every((s) => s.color === null && s.grayscale));
});

test('bad input throws a clear error', () => {
  const good = writePlotStyleTable(BUILTIN_TABLES['acad.ctb']);
  const bad = (bytes, re) => assert.throws(() => parsePlotStyleTable(bytes), re);
  bad(new TextEncoder().encode('AutoCAD Binary DXF\r\n\x1a\0'.padEnd(80, ' ')), /bad header/);
  bad(good.subarray(0, 40), /bad header/);
  bad(good.subarray(0, 61), /truncated/);
  bad(good.subarray(0, good.length - 100), /truncated/);
  const flipped = good.slice(); flipped[flipped.length - 2] ^= 0xff;
  bad(flipped, /checksum|damaged/);
  const notZlib = good.slice(); notZlib[60] = 0x12;
  bad(notZlib, /damaged/);
  bad(new Uint8Array((1 << 20) + 1), /too large/);
  bad(fileOf('x'.repeat(1 << 20)), /too large/);
  bad(fileOf('description="no styles\naci_table_available=TRUE\n'), /no plot_style/);
  bad(fileOf('plot_style{\n 0{\n  name="x\n'), /ends inside/);
  bad('not bytes', /expected file bytes/);
});

test('scene styles carry the plotted ACI index (style.aci): BYLAYER, BYBLOCK in an INSERT, ACI 7, true colour', async () => {
  const { newDocument, addLayer, addBlock, addEntity, makeLine, makeInsert } = await import('../src/core/model.js');
  const { buildScene } = await import('../src/core/render.js');
  const doc = newDocument();
  addLayer(doc, { name: 'G', color: 3 });
  addBlock(doc, 'B', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 }, { color: 0, layer: '0' })]);
  addEntity(doc, makeLine({ x: 0, y: 1 }, { x: 1, y: 1 }, { color: 256, layer: 'G' }));
  addEntity(doc, makeInsert('B', { x: 0, y: 2 }, { color: 5 }));
  addEntity(doc, makeLine({ x: 0, y: 3 }, { x: 1, y: 3 }, { color: 7 }));
  addEntity(doc, makeLine({ x: 0, y: 4 }, { x: 1, y: 4 }, { color: { r: 10, g: 20, b: 30 } }));
  addEntity(doc, makeInsert('B', { x: 0, y: 5 }, { color: { r: 1, g: 2, b: 3 } }));
  const items = buildScene(doc).items.filter((it) => it.kind === 'path');
  const at = (y) => items.find((it) => Math.abs(it.bbox.miny - y) < 1e-9).style;
  assert.deepEqual([1, 2, 3, 4, 5].map((y) => at(y).aci), [3, 5, 7, null, null]);
  assert.deepEqual(at(2).color.rgb, [0, 0, 255], 'resolveColor result unchanged');
  assert.ok(!JSON.stringify(at(1)).includes('aci'), 'not enumerable: scene digests unchanged');
});
