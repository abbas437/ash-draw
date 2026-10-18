// $TILEMODE and the active layout: a drawing opens in the space it was saved in (AutoCAD / TrueView behaviour).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readDxf, parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { newDocument } from '../src/core/model.js';
import { fixture, ezdxfAvailable } from './helpers.js';

const SCRATCH = fileURLToPath(new URL('../.cache/test-tilemode/', import.meta.url));
mkdirSync(SCRATCH, { recursive: true });

/** layouts_r2000.dxf (Layout1 is *Paper_Space) with $TILEMODE set to `v` */
const withTilemode = (v) => fixture('layouts_r2000.dxf').toString('latin1').replace(/\$TILEMODE\r?\n\s*70\r?\n\s*1\r?\n/, `$TILEMODE\n 70\n${v}\n`);
const hvar = (text, name) => { const l = text.split(/\r?\n/).map((s) => s.trim()); const i = l.indexOf(name); return i < 0 ? undefined : l[i + 2]; };
const titles = (doc) => doc.layouts.map((lo) => [lo.name, lo.tab, lo.entities.filter((e) => e.type === 'TEXT').map((t) => t.text)]);

test('read: $TILEMODE 0/1 and the layout read from *Paper_Space', () => {
  assert.ok(/\$TILEMODE\n 70\n0\n/.test(withTilemode(0)), 'fixture edited');
  const d0 = parseDxf(withTilemode(0));
  assert.equal(d0.header.tilemode, 0);
  assert.equal(d0.header.activeLayout, 'Layout1');
  const d1 = readDxf(fixture('layouts_r2000.dxf'));
  assert.equal(d1.header.tilemode, 1);
  assert.equal(d1.header.activeLayout, 'Layout1');
  assert.equal(newDocument().header.tilemode, undefined, 'a new drawing has no saved space');
});

test('write: $TILEMODE and the shown layout as *Paper_Space; tab order, names and contents unchanged', () => {
  const doc = parseDxf(withTilemode(0));
  const before = titles(parseDxf(writeDxf(doc))); // as written with the first layout active (71 renumbered 1..n)
  doc.header.activeLayout = 'Layout2'; // the layout shown at save time
  const text = writeDxf(doc);
  assert.equal(hvar(text, '$TILEMODE'), '0');
  const back = parseDxf(text);
  assert.equal(back.header.tilemode, 0);
  assert.equal(back.header.activeLayout, 'Layout2');
  assert.equal(back.layouts.find((l) => l.name === 'Layout2').block, '*Paper_Space');
  assert.equal(back.layouts.find((l) => l.name === 'Layout1').block, '*Paper_Space0');
  assert.deepEqual(titles(back), before, 'layout order (71), names and entity lists');
  assert.equal(back.entities.filter((e) => e.type === 'TEXT').length, 0, 'paper text stays out of model space');
  assert.equal(new Set(text.match(/\*Paper_Space\d*/g)).size, 2, 'one *Paper_Space and one *Paper_Space0');

  // Model shown: TILEMODE 1, the previously active layout stays *Paper_Space
  back.header.tilemode = 1;
  const t1 = writeDxf(back), b1 = parseDxf(t1);
  assert.equal(hvar(t1, '$TILEMODE'), '1');
  assert.equal(b1.header.tilemode, 1);
  assert.equal(b1.header.activeLayout, 'Layout2');
  assert.deepEqual(titles(b1), before);

  // unknown active layout: the first; never read: TILEMODE 1
  const nd = newDocument();
  const tn = writeDxf(nd);
  assert.equal(hvar(tn, '$TILEMODE'), '1');
  assert.equal(parseDxf(tn).header.activeLayout, 'Layout1');
});

test('write: ezdxf sees the saved space and active layout (when available)', { skip: !ezdxfAvailable() }, () => {
  const doc = readDxf(fixture('layouts_r2000.dxf'));
  doc.header.tilemode = 0; doc.header.activeLayout = 'Layout2';
  const file = path.join(SCRATCH, 'active2.dxf');
  writeFileSync(file, writeDxf(doc));
  const r = spawnSync(ezdxfAvailable(), ['-c', `
import ezdxf, json, sys
d = ezdxf.readfile(sys.argv[1])
a = d.audit()
print(json.dumps({'tilemode': d.header.get('$TILEMODE'), 'active': d.layouts.active_layout().name, 'names': d.layouts.names_in_taborder(), 'errors': len(a.errors),
  'texts': {n: [e.dxf.text for e in d.layouts.get(n) if e.dxftype() == 'TEXT'] for n in ['Layout1', 'Layout2']}}))`, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { tilemode: 0, active: 'Layout2', names: ['Model', 'Layout1', 'Layout2'], errors: 0, texts: { Layout1: ['TITLE Layout1'], Layout2: ['TITLE Layout2'] } });
});
