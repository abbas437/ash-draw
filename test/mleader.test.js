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
