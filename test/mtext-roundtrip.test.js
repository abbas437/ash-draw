// MTEXT read -> write -> read: every property the reader keeps comes back the same, for MTEXT written by ezdxf (R2000 and
// R2018, one layer per case) and by the app; compareDocuments (the DWG save check) reports no MTEXT mismatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { compareDocuments } from '../src/core/verify.js';
import * as M from '../src/core/model.js';
import { ezdxfAvailable } from './helpers.js';

const skip = !ezdxfAvailable() && 'ezdxf not installed';

const GEN = String.raw`
import sys, math, ezdxf
out = sys.argv[1]
ESC_LONG = ('x' * 249) + '\\P' + ('y' * 248) + '\\U+0645' + ('z' * 247) + '{\\H2x;big}' + ('w' * 240) + '\\S1/2;'
c = {}
for a in range(1, 10): c[f'ATT{a}'] = ('attach', dict(attachment_point=a))
for f in (1, 3, 5): c[f'DIR{f}'] = ('flow', dict(flow_direction=f))
c['W0'] = ('no width', dict(width=0))
c['W50'] = ('width 50 text that wraps', dict(width=50))
c['LS05'] = ('a\\Pb', dict(line_spacing_factor=0.5, line_spacing_style=1))
c['LS25X'] = ('a\\Pb', dict(line_spacing_factor=2.5, line_spacing_style=2))
c['BGACI'] = ('bg aci', {}); c['BGRGB'] = ('bg rgb', {}); c['BGCANVAS'] = ('bg canvas', {})
c['COLS'] = ('col a', {})
c['ROT50'] = ('rot 50', dict(rotation=30)); c['ROT50NEG'] = ('rot -90', dict(rotation=-90))
c['ROT359'] = ('rot 359.999999', dict(rotation=359.999999)); c['ROTTINY'] = ('rot -1e-9', dict(rotation=-1e-9))
c['DIR11'] = ('dir 11', dict(text_direction=(math.cos(0.7), math.sin(0.7), 0)))
c['DIR11NEAR0'] = ('dir 11 ~0', dict(text_direction=(1, -1e-12, 0)))
c['ROTBOTH'] = ('50 and 11', dict(rotation=45, text_direction=(0, 1, 0)))
c['H7'] = ('height', dict(char_height=7.25)); c['STYLE'] = ('style', dict(style='MyArial'))
c['INLINE'] = ('{\\fArial|b1|i0|c0|p34;bold}\\P\\H2.5x;big\\C1;red\\c16711680;blue\\S1/2;\\S3#4;\\S+0.1^ -0.2;\\Ldone\\l\\~%%c%%d', {})
c['LONG'] = (''.join(f'word{i:03d} ' for i in range(120)), {})
c['ESCLONG'] = (ESC_LONG, {})
c['CARET'] = ('a^b ^ c\\S1^ 2;^A', {})
c['TAB'] = ('tab\there\tand there', {})
c['ARABIC'] = ('\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645 ' * 30, {})
c['OCSMIR'] = ('mirrored', dict(extrusion=(0, 0, -1)))
c['OCSMIRROT'] = ('mirrored rot', dict(extrusion=(0, 0, -1), rotation=30, attachment_point=4))
c['OCSTILT'] = ('tilted', dict(extrusion=(0.3, 0.2, 0.9), rotation=10))
c['DEFH'] = ('defined height', dict(defined_height=12.5, width=40))
c['EMPTY'] = ('', {}); c['BACKSLASH'] = ('a\\\\b \\{c\\}', {})
for ver in ('R2000', 'R2018'):
    d = ezdxf.new(ver)
    d.styles.new('MyArial', dxfattribs={'font': 'arial.ttf'})
    m = d.modelspace()
    for i, (name, (text, extra)) in enumerate(c.items()):
        d.layers.add(name)
        attrs = dict(layer=name, insert=(i * 10.0, i * 3.0, 0), char_height=2.5)
        attrs.update(extra)
        if name == 'COLS' and ver != 'R2000':
            m.add_mtext_static_columns([text, 'second column'], width=20, gutter_width=2, height=30, dxfattribs=attrs)
            continue
        mt = m.add_mtext(text, dxfattribs=attrs)
        if name.startswith('BG'):
            mt.set_bg_color({'BGACI': 2, 'BGRGB': (10, 200, 30), 'BGCANVAS': 'canvas'}[name], scale=1.5)
    d.saveas(f'{out}/mtext_{ver}.dxf')
`;

const SKIP_KEYS = new Set(['id', 'handle', 'parent']);
/** every property of each MTEXT (by layer) of `a` against `b`: [] when all are the same */
function diffs(a, b) {
  const out = [];
  const mb = new Map(b.entities.filter((e) => e.type === 'MTEXT').map((e) => [e.layer, e]));
  for (const e of a.entities.filter((x) => x.type === 'MTEXT')) {
    const o = mb.get(e.layer);
    if (!o) { out.push(`${e.layer}: missing`); continue; }
    for (const k of new Set([...Object.keys(e), ...Object.keys(o)])) {
      if (SKIP_KEYS.has(k)) continue;
      const x = k === 'rot' ? +e[k].toFixed(9) % 360 : e[k], y = k === 'rot' ? +o[k].toFixed(9) % 360 : o[k];
      if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${e.layer}.${k}: ${JSON.stringify(x)?.slice(0, 60)} -> ${JSON.stringify(y)?.slice(0, 60)}`);
    }
  }
  return out;
}
const roundTrip = (doc) => readDxf(Buffer.from(writeDxf(doc)));

let files;
function ezFiles(t) {
  if (files) return files;
  const dir = mkdtempSync(path.join(tmpdir(), 'ashmtextrt-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(ezdxfAvailable(), ['-c', GEN, dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  files = Object.fromEntries(['R2000', 'R2018'].map((v) => [v, readDxf(readFileSync(path.join(dir, `mtext_${v}.dxf`)))]));
  return files;
}

for (const ver of ['R2000', 'R2018']) {
  test(`ezdxf ${ver} MTEXT: every kept property survives write -> read, and the save check reports no MTEXT difference`, { skip }, (t) => {
    const a = ezFiles(t)[ver];
    assert.equal(a.entities.filter((e) => e.type === 'MTEXT').length, 41);
    const b = roundTrip(a);
    assert.deepEqual(diffs(a, b), []);
    const cmp = compareDocuments(a, b);
    assert.equal(cmp.mismatched.MTEXT, undefined, JSON.stringify(cmp));
  });
}

test('ezdxf MTEXT: a \\U+ code split over two group-3 chunks is decoded; tabs are kept', { skip }, (t) => {
  for (const ver of ['R2000', 'R2018']) {
    const by = (l) => ezFiles(t)[ver].entities.find((e) => e.layer === l);
    const esc = by('ESCLONG').text;
    assert.ok(!esc.includes('\\U+0645') && esc.includes('y\u0645z'), ver);
    assert.equal(by('TAB').text, 'tab\there\tand there');
    assert.equal(roundTrip(ezFiles(t)[ver]).entities.find((e) => e.layer === 'TAB').text, 'tab\there\tand there');
  }
});

test('ezdxf R2018 column MTEXT: the embedded column object does not replace the MTEXT position, direction or spacing', { skip }, (t) => {
  const e = ezFiles(t).R2018.entities.find((x) => x.layer === 'COLS');
  const i = ezFiles(t).R2000.entities.findIndex((x) => x.layer === 'COLS');
  assert.deepEqual([e.p, e.rot, e.lineSpacing, e.width], [{ x: i * 10, y: i * 3 }, 0, 1, 20]);
});

test('app-written MTEXT: every kept property survives write -> read -> write -> read', () => {
  const doc = M.newDocument();
  const long = Array.from({ length: 90 }, (_, i) => `\u0645\u0631\u062d\u0628\u0627 ${i}\\P`).join('') + 'x'.repeat(237) + '\\S1^ 2;';
  const specs = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((attach) => ({ attach })),
    { width: 0 }, { width: 50 }, { rot: 30 }, { rot: 270 }, { rot: 359.9999999 }, { rot: 1e-9 }, { lineSpacing: 0.5 }, { lineSpacing: 2.5 },
    { style: 'STANDARD' }, { text: '{\\fArial|b1;bold}\\P\\H2.5x;big\\C1;red\\c16711680;blue\\S1/2;\\S3#4;\\S+0.1^ -0.2;' },
    { text: long }, { text: 'tab\there ^ caret ^A' }, { text: 'a\nb' }, { text: '' }, { text: 'a\\\\b \\{c\\}' },
  ];
  specs.forEach((s, i) => {
    M.addEntity(doc, M.makeMText({ x: i, y: 2 * i }, 2.5 + i / 10, s.text ?? `case ${i}`, { ...s, layer: `L${i}` }));
  });
  const a = roundTrip(doc);
  assert.equal(a.entities.length, specs.length);
  const b = roundTrip(a);
  assert.deepEqual(diffs(a, b), []);
  assert.equal(compareDocuments(a, b).ok, true);
  // and against the model: the same properties (a newline is written as \P)
  for (const e of doc.entities) e.text = e.text.replace(/\n/g, '\\P');
  assert.deepEqual(diffs(doc, a).filter((d) => !/\.(color|lineweight|linetype|ltscale|transparency): /.test(d)), []);
});

test('compareDocuments: an MTEXT rotation of 359.9999999 matches one of 0.0000001 (normalised after rounding)', () => {
  const mk = (rot) => { const d = M.newDocument(); M.addEntity(d, M.makeMText({ x: 0, y: 0 }, 2.5, 'r', { rot })); return d; };
  assert.equal(compareDocuments(mk(359.9999999), mk(0.0000001)).ok, true);
  assert.equal(compareDocuments(mk(359.9999999), mk(0)).ok, true);
  assert.equal(compareDocuments(mk(10), mk(10.01)).ok, false);
});
