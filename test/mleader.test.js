import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { buildScene } from '../src/core/render.js';
import { newDocument, addEntity } from '../src/core/model.js';
import { makeMLeader } from '../src/core/mleader.js';
import { bboxOf } from '../src/core/geom.js';
import { compareDocuments } from '../src/core/verify.js';
import { ezdxfAvailable, validateWithEzdxf } from './helpers.js';

const skip = !ezdxfAvailable() && 'ezdxf not installed';
const GEN = `import ezdxf, sys
from ezdxf.render import mleader
from ezdxf.math import Vec2
doc = ezdxf.new('R2000')
ml = doc.modelspace().add_multileader_mtext("Standard")
ml.set_content("SUPPLY AIR", char_height=2.5, alignment=mleader.TextAlignment.left)
ml.add_leader_line(mleader.ConnectionSide.left, [Vec2(0, 0)])
ml.add_leader_line(mleader.ConnectionSide.left, [Vec2(0, 20), Vec2(5, 15)])
ml.build(insert=Vec2(20, 10))
doc.saveas(sys.argv[1])`;
const BACK = `import ezdxf, json, sys
doc = ezdxf.readfile(sys.argv[1])
out = []
for m in doc.modelspace().query("MULTILEADER"):
    ctx = m.context
    out.append({"text": ctx.mtext.default_content if ctx.mtext else None,
                "lines": [[[round(v.x, 6), round(v.y, 6)] for v in ln.vertices] for ld in ctx.leaders for ln in ld.lines]})
print(json.dumps(out))`;

function tmp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ashmleader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const py = (code, ...args) => {
  const r = spawnSync(ezdxfAvailable(), ['-c', code, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const linesOf = (e) => e.leaders.flatMap((l) => l.lines.map((ln) => ln.map((p) => [p.x, p.y])));

test('ezdxf MultiLeader reads: 2 leader lines, text, arrowheads at the tips; drawn as paths, fills and text', { skip }, (t) => {
  const dir = tmp(t);
  const src = path.join(dir, 'ml.dxf');
  py(GEN, src);
  const doc = parseDxf(readFileSync(src, 'utf8'));
  assert.deepEqual(doc.skipped, {});
  const ml = doc.entities.filter((e) => e.type === 'MLEADER');
  assert.equal(ml.length, 1);
  const e = ml[0];
  assert.equal(e.text, 'SUPPLY AIR');
  assert.deepEqual(linesOf(e), [[[0, 0]], [[0, 20], [5, 15]]]);
  assert.deepEqual(e.leaders[0].last, { x: 10, y: 8.75 });
  assert.equal(e.arrowSize, 4);
  const items = buildScene(doc).items;
  const fills = items.filter((it) => it.kind === 'fill');
  assert.equal(fills.length, 2);
  // each arrowhead's first vertex is the leader's tip
  assert.deepEqual(fills.map((f) => [f.ops[1], f.ops[2]]), [[0, 0], [0, 20]]);
  // the content is MTEXT in ezdxf's Standard style (txt font, SHX): drawn with the stroke font from the text position
  assert.equal(items.filter((it) => it.kind === 'text').length, 0);
  const txt = items.find((it) => it.strokeText);
  assert.ok(txt.strokeText.p.x >= 20 && txt.strokeText.p.x < 21 && txt.strokeText.p.y < 10, JSON.stringify(txt.strokeText));
  assert.equal(items.filter((it) => it.kind === 'path' && !it.strokeText).length, 2);
  const b = bboxOf(e, doc);
  assert.ok(b.minx <= 0 && b.maxy >= 20, JSON.stringify(b));

  // write -> ezdxf reads the same text and vertices; audit clean
  const out = path.join(dir, 'out.dxf');
  writeFileSync(out, writeDxf(doc));
  const audit = validateWithEzdxf(out);
  assert.equal(audit.audit_errors, 0, JSON.stringify(audit.audit_messages));
  assert.deepEqual(audit.counts, { MULTILEADER: 1 });
  const back = JSON.parse(py(BACK, out));
  assert.deepEqual(back, [{ text: 'SUPPLY AIR', lines: [[[0, 0]], [[0, 20], [5, 15]]] }]);
  // and our own reader keeps it
  const again = parseDxf(readFileSync(out, 'utf8')).entities.find((x) => x.type === 'MLEADER');
  assert.equal(again.text, 'SUPPLY AIR');
  assert.deepEqual(linesOf(again), linesOf(e));
});

test('a created MLEADER writes a file ezdxf accepts and reads back', { skip }, (t) => {
  const doc = newDocument();
  addEntity(doc, makeMLeader({ x: 0, y: 0 }, { x: 10, y: 5 }, 'EXHAUST\nFAN', { arrowSize: 2, textHeight: 2 }));
  const out = path.join(tmp(t), 'new.dxf');
  writeFileSync(out, writeDxf(doc));
  const audit = validateWithEzdxf(out);
  assert.equal(audit.audit_errors, 0, JSON.stringify(audit.audit_messages));
  const back = JSON.parse(py(BACK, out));
  assert.deepEqual(back, [{ text: 'EXHAUST\\PFAN', lines: [[[0, 0]]] }]);
  const e = parseDxf(readFileSync(out, 'utf8')).entities[0];
  assert.equal(e.type, 'MLEADER');
  assert.equal(e.text, 'EXHAUST\\PFAN');
});

test('DWG read-back check: a multileader is compared as the geometry the DWG save turns it into', () => {
  const doc = newDocument();
  addEntity(doc, makeMLeader({ x: 0, y: 0 }, { x: 20, y: 10 }, 'SUPPLY AIR', { textHeight: 2.5 }));
  // what LibreDWG hands back: the same lines, arrow and text as plain entities
  const back = parseDxf(writeDxf(doc, { dimensionsAsGeometry: true }));
  assert.ok(!back.entities.some((e) => e.type === 'MLEADER'));
  const cmp = compareDocuments(doc, back);
  assert.equal(cmp.ok, true, JSON.stringify(cmp));
  assert.equal(cmp.counts.MLEADER, undefined);
  // a lost piece is still reported
  back.entities = back.entities.filter((e) => e.type !== 'SOLID');
  assert.equal(compareDocuments(doc, back).ok, false);
});

// AutoCAD writes the CONTEXT_DATA text height / arrow size already multiplied by the overall (annotative) scale 40
// (ezdxf: set_content(char_height=0.1) + set_overall_scaling(50) -> context 41 = 5); only style defaults are unscaled.
const mlDxf = (ctx) => ['0', 'SECTION', '2', 'ENTITIES', '0', 'MULTILEADER', '5', '2A', '8', '0', '100', 'AcDbMLeader', '270', '2',
  '300', 'CONTEXT_DATA{', ...ctx, '290', '1', '304', 'OUTSIDE FENCE', '12', '100', '22', '50', '32', '0', '13', '1', '23', '0', '33', '0',
  '302', 'LEADER{', '10', '95', '20', '45', '30', '0', '11', '1', '21', '0', '31', '0', '40', '0.2',
  '304', 'LEADER_LINE{', '10', '90', '20', '40', '30', '0', '305', '}', '303', '}', '301', '}',
  '0', 'ENDSEC', '0', 'EOF', ''].join('\n');

test('a scaled multileader draws its text at the context height, not height x overall scale', () => {
  const doc = parseDxf(mlDxf(['40', '50', '10', '95', '20', '45', '30', '0', '41', '0.1', '140', '0.08', '145', '0.04']));
  const ml = doc.entities[0];
  assert.equal(ml.type, 'MLEADER');
  assert.equal(ml.scale, 50);
  const sc = buildScene(doc);
  const txt = sc.items.filter((it) => it.kind === 'text' || it.strokeText);
  assert.equal(txt.length, 1);
  assert.ok(Math.abs((txt[0].strokeText?.h ?? txt[0].h) - 0.1) < 1e-9, `text height ${txt[0].h}`);
  // arrowhead: 0.08 long at the tip (90,40), not 4
  const arrow = sc.items.find((it) => it.kind === 'fill');
  assert.ok(arrow && arrow.bbox.maxx - arrow.bbox.minx < 0.1, JSON.stringify(arrow?.bbox));
  // the extents stay around the leader and its label (an unscaled 5-unit text would reach x > 130)
  assert.ok(sc.bbox.maxx < 102, JSON.stringify(sc.bbox));
});

test('a multileader without context sizes takes the style defaults times the overall scale', () => {
  const doc = parseDxf(mlDxf(['40', '10', '10', '95', '20', '45', '30', '0']));
  const ml = doc.entities[0];
  assert.equal(ml.textHeight, 25);   // Standard default 2.5 x 10
  assert.equal(ml.arrowSize, 40);    // default 4 x 10
});

test('arrowhead size not overridden (override flags without bit 9): the style size is drawn, not the context value', async () => {
  const { mleaderFromTags } = await import('../src/core/mleader.js');
  const tags = (flags) => [[300, 'CONTEXT_DATA{'], [40, '1'], [10, '0'], [20, '0'], [41, '5'], [140, '400'], [304, 'JNV'], [12, '0'], [22, '0'],
    [302, 'LEADER{'], [10, '0'], [20, '0'], [304, 'LEADER_LINE{'], [10, '-20'], [20, '10'], [305, '}'], [303, '}'], [301, '}'],
    ...(flags === null ? [] : [[90, String(flags)]]), [42, '400']];
  const style = { name: 'Standard', arrowSize: 0.18, textHeight: 0.18, landingGap: 0.09, doglegLen: 0.36 };
  assert.equal(mleaderFromTags(tags(345088), style).arrowSize, 0.18);            // the client drawing's flags: style size
  assert.equal(mleaderFromTags(tags(345088 | 0x200), style).arrowSize, 400);    // overridden: the entity's size
  assert.equal(mleaderFromTags(tags(null), style).arrowSize, 400);              // no flags at all: as before
});

test('an arrowhead longer than its leader segment is left out; one that fits is drawn', async () => {
  const { mleaderParts } = await import('../src/core/mleader.js');
  const ml = (sz) => ({ arrowSize: sz, arrow: true, dogleg: false, text: '', leaders: [{ last: { x: 20, y: 0 }, dir: { x: 1, y: 0 }, doglegLen: 0, lines: [[{ x: 0, y: 0 }]] }] });
  assert.equal(mleaderParts(ml(400)).filter((p) => p.arrowHead).length, 0);
  assert.equal(mleaderParts(ml(2.5)).filter((p) => p.arrowHead).length, 1);
});

test('DWG through ODA: multileaders go out as geometry (ODA drops MULTILEADER from an R2000 DXF) while dimensions stay real', () => {
  const doc = newDocument();
  addEntity(doc, makeMLeader({ x: 0, y: 0 }, { x: 20, y: 10 }, 'SUPPLY AIR', { textHeight: 2.5 }));
  const text = writeDxf(doc, { mleadersAsGeometry: true });
  assert.doesNotMatch(text, /\r?\n0\r?\nMULTILEADER\r?\n/);
  assert.doesNotMatch(text, /MLEADERSTYLE/);
  const back = parseDxf(text);
  assert.ok(back.entities.some((e) => e.type === 'MTEXT' && /SUPPLY AIR/.test(e.text)));
  assert.equal(compareDocuments(doc, back).ok, true);
});

test('Frame text (entity 292 = 1, not the context 292): a box round the text with the landing gap clear; round trip', async () => {
  const { mleaderFromTags } = await import('../src/core/mleader.js');
  const tags = (frame) => [[300, 'CONTEXT_DATA{'], [40, '1'], [10, '0'], [20, '0'], [41, '125'], [140, '250'], [145, '75'], [290, '1'],
    [304, 'ACOUSTIC LINING'], [12, '1000'], [22, '500'], [171, '1'], [292, '0'],
    [302, 'LEADER{'], [10, '900'], [20, '440'], [304, 'LEADER_LINE{'], [10, '0'], [20, '0'], [305, '}'], [303, '}'], [301, '}'],
    [90, '0'], [291, '1'], [292, frame]];
  assert.equal(mleaderFromTags(tags('1')).textFrame, true);
  assert.equal(mleaderFromTags(tags('0')).textFrame, false);
  const doc = newDocument();
  addEntity(doc, { ...mleaderFromTags(tags('1')), type: 'MLEADER', id: 0, layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1 });
  const sc = buildScene(doc);
  const text = sc.items.find((it) => it.kind === 'text');
  const frame = sc.items.filter((it) => it.kind !== 'text').map((it) => it.bbox).find((b) => b && b.maxx > 1500);
  assert.ok(text && frame, 'text and a frame drawn');
  // the frame clears the text by the landing gap (75) at the left and top; it extends right of the text start
  assert.ok(Math.abs(frame.minx - (1000 - 75)) < 1e-6, `frame left ${frame.minx}`);
  assert.ok(Math.abs(frame.maxy - (500 + 75)) < 1e-6, `frame top ${frame.maxy}`);
  assert.ok(frame.miny < 500 - 125, 'frame below the text line');
  const again = parseDxf(writeDxf(doc)).entities[0];
  assert.equal(again.textFrame, true);
  const plain = newDocument();
  addEntity(plain, { ...mleaderFromTags(tags('0')), type: 'MLEADER', id: 0, layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1 });
  assert.ok(!buildScene(plain).items.some((it) => it.bbox && it.bbox.maxx > 1500 && it.kind !== 'text'), 'no frame without Frame text');
});

test('an MLEADER keeps its text style (entity 343) for its text, and writes it back', () => {
  const doc = newDocument();
  doc.textStyles.set('NARROW', { name: 'Narrow', font: 'Arial Narrow', fontFile: 'arialn.ttf', height: 0, widthFactor: 1, oblique: 0 });
  const ml = makeMLeader({ x: 0, y: 0 }, { x: 10, y: 10 }, 'LABEL', { textHeight: 2.5 });
  addEntity(doc, { ...ml, textStyle: 'Narrow', textFrame: true });
  const again = parseDxf(writeDxf(doc)).entities[0];
  assert.equal(again.textStyle, 'Narrow');
  assert.equal(again.textFrame, true);
  const txt = buildScene(doc).items.find((it) => it.kind === 'text');
  assert.equal(txt.font, 'Arial Narrow');
});
