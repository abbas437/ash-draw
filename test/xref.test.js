import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { buildScene } from '../src/core/render.js';
import { listXrefs, loadXref, unloadXref, xrefCandidates } from '../src/core/xref.js';
import { ezdxfAvailable, validateWithEzdxf } from './helpers.js';

test('xref path search order: relative to the host folder, the path itself, the file name in the host folder', () => {
  const P = path.posix;
  assert.deepEqual(xrefCandidates('/w/host.dxf', 'sub/a.dxf', P), ['/w/sub/a.dxf', '/w/a.dxf']);
  assert.deepEqual(xrefCandidates('/w/host.dxf', '..\\other\\a.dxf', P), ['/other/a.dxf', '/w/a.dxf']);
  assert.deepEqual(xrefCandidates('/w/host.dxf', '/elsewhere/a.dxf', P), ['/elsewhere/a.dxf', '/w/a.dxf']);
  assert.deepEqual(xrefCandidates('/w/host.dxf', 'a.dxf', P), ['/w/a.dxf']);
  const W = path.win32;
  assert.deepEqual(xrefCandidates('C:\\w\\host.dwg', 'D:\\proj\\a.dwg', W), ['D:\\proj\\a.dwg', 'C:\\w\\a.dwg']);
  assert.deepEqual(xrefCandidates('C:\\w\\host.dwg', '.\\x\\a.dwg', W), ['C:\\w\\x\\a.dwg', 'C:\\w\\a.dwg']);
});

test('ezdxf host with an xref to a sibling DXF: read, load, render, write back', (t) => {
  const py = ezdxfAvailable();
  if (!py) return t.skip('ezdxf not installed');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ash-xref-'));
  try {
    const mk = spawnSync(py, ['-c', `
import ezdxf, sys
d = sys.argv[1]
c = ezdxf.new('R2000'); c.layers.add('WALL', color=3)
c.modelspace().add_line((0, 0), (100, 0), dxfattribs={'layer': 'WALL'})
c.blocks.new('DOOR').add_circle((0, 0), 5)
c.modelspace().add_blockref('DOOR', (50, 50))
c.saveas(d + '/child.dxf')
h = ezdxf.new('R2000')
h.add_xref_def('child.dxf', 'CHILD')
h.add_xref_def('gone.dxf', 'GONE')
h.modelspace().add_blockref('CHILD', (10, 10))
h.modelspace().add_blockref('GONE', (500, 500))
h.saveas(d + '/host.dxf')
`, dir], { encoding: 'utf8' });
    assert.equal(mk.status, 0, mk.stderr);
    const doc = readDxf(readFileSync(path.join(dir, 'host.dxf')));
    const xr = listXrefs(doc);
    assert.deepEqual(xr.map((x) => [x.name, x.path, x.status]), [['CHILD', 'child.dxf', 'Not found'], ['GONE', 'gone.dxf', 'Not found']]);
    assert.equal(doc.entities.filter((e) => e.type === 'INSERT').length, 2);

    // not loaded: the path in red at the insertion point
    const red = buildScene(doc).items.filter((it) => it.kind === 'text' && it.style.color.rgb.join() === '255,0,0');
    assert.deepEqual(red.map((it) => [it.lines[0], it.p.x, it.p.y]), [['child.dxf', 10, 10], ['gone.dxf', 500, 500]]);

    loadXref(doc, 'CHILD', readDxf(readFileSync(path.join(dir, 'child.dxf'))), path.join(dir, 'child.dxf'));
    assert.equal(listXrefs(doc)[0].status, 'Loaded');
    assert.ok(doc.layers.has('CHILD|WALL'));
    assert.equal(doc.layers.get('CHILD|WALL').color, 3);
    assert.ok(doc.blocks.has('CHILD|DOOR'));
    const scene = buildScene(doc);
    const line = scene.items.find((it) => it.kind === 'path' && it.style.layerName === 'CHILD|WALL');
    assert.ok(line, 'xref line drawn through the INSERT');
    assert.deepEqual([line.bbox.minx, line.bbox.miny, line.bbox.maxx], [10, 10, 110]);

    // write: the xref stays an external block with its path; its content and layers are not written
    const out = path.join(dir, 'out.dxf');
    writeFileSync(out, writeDxf(doc));
    const v = validateWithEzdxf(out);
    assert.equal(v.audit_errors, 0, JSON.stringify(v.audit_messages));
    assert.ok(!v.layers.includes('CHILD|WALL'));
    const chk = spawnSync(py, ['-c', `
import ezdxf, sys, json
d = ezdxf.readfile(sys.argv[1])
b = d.blocks.get('CHILD')
print(json.dumps([b.block.dxf.flags & 4, b.block.dxf.get('xref_path'), len(b), d.blocks.get('CHILD|DOOR') is None]))
`, out], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(chk.stdout), [4, 'child.dxf', 0, true]);
    const back = readDxf(readFileSync(out));
    assert.deepEqual(listXrefs(back).map((x) => [x.name, x.path]), [['CHILD', 'child.dxf'], ['GONE', 'gone.dxf']]);

    unloadXref(doc, 'CHILD');
    assert.ok(!doc.layers.has('CHILD|WALL') && !doc.blocks.has('CHILD|DOOR'));
    assert.equal(listXrefs(doc)[0].status, 'Unloaded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
