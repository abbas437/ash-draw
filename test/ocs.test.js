// OCS (extrusion 210/220/230) handling of the DXF reader, checked against ezdxf's own OCS -> WCS results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { bboxOf, explode, distanceToEntity, boxOfPoints, DEG } from '../src/core/geom.js';
import { ezdxfAvailable } from './helpers.js';

// Each case is one entity on its own layer. `pts`: ezdxf's WCS flattening (Z dropped); `p`/`rot`: text placement.
const PY = String.raw`
import ezdxf, json, sys, math
from ezdxf import path as P
from ezdxf.math import Vec3
doc = ezdxf.new('R2010')
msp = doc.modelspace()
DN = (0, 0, -1)
TILT = (0.1418, -0.0245, 0.9896)
def ax(layer, ex, **kw):
    d = dict(layer=layer, extrusion=ex); d.update(kw); return d
msp.add_circle((10, 5, 1), 3, dxfattribs=ax('CIRCLE', DN))
msp.add_arc((20, 5, 1), 4, 10, 100, dxfattribs=ax('ARC', DN))
lw = msp.add_lwpolyline([(30, 0, 0, 0, 0.5), (36, 0), (36, 5)], format='xyseb', dxfattribs=ax('LWPOLYLINE', DN))
lw.dxf.elevation = 2
msp.add_polyline2d([(40, 0), (46, 0), (46, 5)], dxfattribs=ax('POLYLINE', DN))
msp.add_ellipse((60, 5, 0), major_axis=(4, 1, 0), ratio=0.5, start_param=0.3, end_param=2.0, dxfattribs=ax('ELLIPSE', DN))
msp.add_solid([(70, 0), (74, 0), (70, 3), (74, 2)], dxfattribs=ax('SOLID', DN))
h = msp.add_hatch(color=1, dxfattribs=ax('HATCH', DN))
h.dxf.elevation = (0, 0, 3)
ep = h.paths.add_edge_path()
ep.add_line((100, 0), (110, 0))
ep.add_arc((110, 5), 5, -90, 90)
ep.add_ellipse((105, 10), major_axis=(-5, 0), ratio=0.4, start_angle=0, end_angle=180)
ep.add_line((100, 10), (100, 0))
t = msp.add_hatch(color=2, dxfattribs=ax('HATCH_TILT', TILT))
t.dxf.elevation = (0, 0, 250)
t.paths.add_polyline_path([(2780000, -155000), (2780050, -155000), (2780050, -154970), (2780000, -154970)], is_closed=True)
msp.add_circle((5, 5, 7), 2, dxfattribs=ax('CIRCLE_TILT', (0.3, 0.2, 0.93)))
msp.add_arc((15, 25, 2), 3, 30, 200, dxfattribs=ax('ARC_TILT', TILT))
blk = doc.blocks.new('LBLK')
blk.add_lwpolyline([(0, 0), (5, 0), (5, 1)])
blk.add_arc((0, 0), 2, 0, 90)
msp.add_blockref('LBLK', (80, 10, 0), dxfattribs=ax('INSERT', DN, rotation=30))
msp.add_text('AB', height=2, rotation=20, dxfattribs=ax('TEXT', DN, insert=(90, 5, 0)))
msp.add_mtext('AB', dxfattribs=ax('MTEXT', DN, insert=(95, 5, 0), char_height=2, rotation=30))
out = {}
for e in msp:
    L = e.dxf.layer
    if e.dxftype() == 'INSERT':
        pts = [v for ve in e.virtual_entities() for v in P.make_path(ve).flattening(0.001)]
    elif e.dxftype() == 'TEXT':
        p = e.ocs().to_wcs(e.dxf.insert); d = e.ocs().to_wcs(Vec3.from_deg_angle(e.dxf.rotation))
        out[L] = dict(p=[p.x, p.y], dir=[d.x, d.y]); continue
    elif e.dxftype() == 'MTEXT':
        p = e.dxf.insert; d = e.get_text_direction()  # MTEXT is no OCS entity; ezdxf maps 50 through the OCS as here
        out[L] = dict(p=[p.x, p.y], dir=[d.x, d.y]); continue
    else:
        pts = list(P.make_path(e).flattening(0.001)) if e.dxftype() != 'HATCH' else [v for pp in P.make_path(e).sub_paths() for v in pp.flattening(0.001)]
    out[L] = dict(pts=[[v.x, v.y] for v in pts])
doc.saveas(sys.argv[1])
print(json.dumps(out))
`;

function makeCase(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ash-ocs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ocs.dxf');
  const r = spawnSync(ezdxfAvailable(), ['-c', PY, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { doc: parseDxf(readFileSync(file, 'utf8')), want: JSON.parse(r.stdout.trim().split('\n').pop()) };
}

const byLayer = (doc, layer) => doc.entities.filter((e) => e.layer === layer);

/** every ezdxf WCS point lies on our geometry, and our geometry covers the same box */
function assertMatches(doc, layer, want, tol = 0.02) {
  const ents = byLayer(doc, layer);
  assert.equal(ents.length, 1, `${layer}: one entity`);
  const parts = ents[0].type === 'INSERT' ? explode(ents[0], doc) : ents;
  for (const [x, y] of want.pts) {
    const d = Math.min(...parts.map((e) => distanceToEntity(e, { x, y }, doc)));
    assert.ok(d < tol, `${layer}: ezdxf point (${x}, ${y}) is ${d} away from the read geometry`);
  }
  const ours = parts.map((e) => bboxOf(e, doc)).reduce((a, b) => ({ minx: Math.min(a.minx, b.minx), miny: Math.min(a.miny, b.miny), maxx: Math.max(a.maxx, b.maxx), maxy: Math.max(a.maxy, b.maxy) }));
  const theirs = boxOfPoints(want.pts.map(([x, y]) => ({ x, y })));
  for (const k of ['minx', 'miny', 'maxx', 'maxy']) assert.ok(Math.abs(ours[k] - theirs[k]) < 1e-2, `${layer}: bbox ${k} ${ours[k]} vs ezdxf ${theirs[k]}`);
}

const GEOM = ['CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'ELLIPSE', 'SOLID', 'HATCH', 'HATCH_TILT', 'CIRCLE_TILT', 'ARC_TILT', 'INSERT'];
const skip = !ezdxfAvailable() && 'ezdxf not installed';

for (const layer of GEOM) {
  test(`OCS: ${layer} lands where ezdxf puts it in WCS`, { skip }, (t) => {
    const { doc, want } = makeCase(t);
    assertMatches(doc, layer, want[layer]);
  });
}

test('OCS: tilted-extrusion HATCH is projected near its WCS location, not at raw OCS coordinates', { skip }, (t) => {
  const { doc } = makeCase(t);
  const b = bboxOf(byLayer(doc, 'HATCH_TILT')[0], doc);
  assert.ok(b.minx < 2.7e6 && b.miny > -1.5e5, `bbox ${JSON.stringify(b)} still at the raw OCS coordinates (2.78e6, -1.55e5)`);
});

test('OCS: mirrored INSERT draws its block mirrored (negative determinant)', { skip }, (t) => {
  const { doc } = makeCase(t);
  const ins = byLayer(doc, 'INSERT')[0];
  assert.ok((ins.sx ?? 1) * (ins.sy ?? 1) < 0, `sx ${ins.sx} sy ${ins.sy}`);
});

test('OCS: mirrored TEXT and MTEXT keep their WCS insertion point and read along the mirrored baseline, reversed', { skip }, (t) => {
  const { doc, want } = makeCase(t);
  for (const layer of ['TEXT', 'MTEXT']) {
    const e = byLayer(doc, layer)[0];
    const w = want[layer];
    assert.ok(Math.hypot(e.p.x - w.p[0], e.p.y - w.p[1]) < 1e-9, `${layer} p`);
    // backwards text is kept readable: the baseline runs opposite to the (mirrored) WCS direction
    const a = e.rot * DEG;
    assert.ok(Math.hypot(Math.cos(a) + w.dir[0], Math.sin(a) + w.dir[1]) < 1e-9, `${layer} rot ${e.rot}`);
  }
  assert.equal(byLayer(doc, 'TEXT')[0].hAlign, 2, 'left-justified backwards text keeps its footprint as right-justified');
  assert.equal(byLayer(doc, 'MTEXT')[0].attach, 3);
});

test('OCS: LINE and SPLINE are WCS (extrusion only orients thickness)', () => {
  const dxf = ['0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '1', '20', '2', '30', '0', '11', '3', '21', '4', '31', '0', '210', '0', '220', '0', '230', '-1',
    '0', 'SPLINE', '8', '0', '210', '0', '220', '0', '230', '-1', '70', '8', '71', '1', '72', '4', '73', '2',
    '40', '0', '40', '0', '40', '1', '40', '1', '10', '5', '20', '6', '30', '0', '10', '7', '20', '8', '30', '0',
    '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
  const doc = parseDxf(dxf);
  const [line, spl] = doc.entities;
  assert.deepEqual([line.p1, line.p2], [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  assert.deepEqual(spl.ctrl, [{ x: 5, y: 6 }, { x: 7, y: 8 }]);
});

test('OCS: DXF round trip writes WCS geometry and keeps every position', { skip }, (t) => {
  const { doc, want } = makeCase(t);
  const back = parseDxf(writeDxf(doc));
  for (const layer of GEOM) assertMatches(back, layer, want[layer]);
});
