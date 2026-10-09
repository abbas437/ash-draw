import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDxf, readDxf } from '../src/core/dxfRead.js';
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

test('a BLOCK with flags 0 but a .dwg path in group 1 (LibreDWG) is an xref, written back with bit 4', () => {
  const text = [
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '8', '0', '2', 'X1', '70', '     0', '10', '0', '20', '0', '30', '0', '3', 'X1', '1', 'sub\\ref.DWG',
    '0', 'ENDBLK', '8', '0',
    '0', 'BLOCK', '8', '0', '2', 'PLAIN', '70', '0', '10', '0', '20', '0', '3', 'PLAIN', '1', '',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '1', '21', '1',
    '0', 'ENDBLK', '8', '0',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', '0', 'INSERT', '8', '0', '2', 'X1', '10', '0', '20', '0', '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const doc = parseDxf(text);
  const xs = listXrefs(doc);
  assert.deepEqual(xs.map((x) => [x.name, x.path, x.inserts]), [['X1', 'sub\\ref.DWG', 1]]);
  const out = writeDxf(doc);
  assert.match(out, /AcDbBlockBegin\r?\n\s*2\r?\nX1\r?\n\s*70\r?\n\s*4\r?\n/);
  const back = parseDxf(out);
  assert.equal(back.blocks.get('X1').xref.flags & 4, 4);
  assert.deepEqual(listXrefs(back).map((x) => [x.name, x.path]), [['X1', 'sub\\ref.DWG']]);
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

test('XATTACH: unique block names, one undo step, addLayer keeps xrefDep', async () => {
  const { Session } = await import('../src/core/edit.js');
  const { addLayer, addBlock, newDocument, addEntity } = await import('../src/core/model.js');
  const { attachXref, uniqueXrefName } = await import('../src/core/xref.js');
  const { instantiate } = await import('../src/core/blocks.js');
  const { relativePath } = await import('../renderer/xrefs.js');
  assert.equal(addLayer(newDocument(), { name: 'X|L', xrefDep: 'X' }).xrefDep, 'X');
  assert.equal('xrefDep' in addLayer(newDocument(), { name: 'L' }), false);

  const host = newDocument();
  assert.equal(uniqueXrefName(host, 'C:\\w\\sub\\att.dxf'), 'ATT');
  addBlock(host, 'ATT', { x: 0, y: 0 }, []);
  addBlock(host, 'att_2', { x: 0, y: 0 }, []);
  assert.equal(uniqueXrefName(host, '/w/att.dwg'), 'ATT_3');
  assert.equal(uniqueXrefName(host, 'a:b.dxf'), 'A_B');
  host.blocks.clear();

  const x = newDocument();
  addLayer(x, { name: 'WALL' });
  addBlock(x, 'DOOR', { x: 0, y: 0 }, []);
  addEntity(x, { type: 'LINE', layer: 'WALL', p1: { x: 0, y: 0 }, p2: { x: 5, y: 0 } });
  const s = new Session(host);
  const layers0 = [...host.layers.keys()];
  s.transact('Attach xref', (tx) => {
    const blk = attachXref(tx, 'ATT', relativePath('/w/host.dxf', '/w/sub/att.dxf'), x, '/w/sub/att.dxf');
    tx.add(instantiate(blk, { x: 1, y: 2 }, {}));
  });
  assert.equal(host.blocks.get('ATT').xref.path, './sub/att.dxf');
  assert.equal(relativePath(null, '/w/sub/att.dxf'), '/w/sub/att.dxf', 'unsaved host: absolute');
  assert.ok(host.layers.get('ATT|WALL').xrefDep === 'ATT' && host.blocks.get('ATT|DOOR').xrefDep === 'ATT');
  assert.deepEqual(listXrefs(host).map((r) => [r.name, r.status, r.inserts]), [['ATT', 'Loaded', 1]]);
  s.undo();
  assert.equal(host.entities.length, 0);
  assert.equal(host.blocks.size, 0, 'block and NAME|... blocks gone');
  assert.deepEqual([...host.layers.keys()], layers0, 'no ATT| layers left');
  s.redo();
  assert.ok(host.layers.get('ATT|WALL').xrefDep === 'ATT', 'redo keeps xrefDep');
  unloadXref(host, 'ATT');
  assert.deepEqual([...host.layers.keys()], layers0, 'unload after redo still drops the xref layers');
});
