import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { newDocument } from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import {
  addMarkup, listMarkups, setMarkupStatus, deleteMarkup, markupData, markupsCsv, setMarkupsVisible, MARKUP_LAYER,
} from '../src/core/markup.js';
import { ezdxfAvailable, validateWithEzdxf } from './helpers.js';

const meta = { author: 'Ahmad', date: '2026-10-08' };

test('markup circle: dashed red shape + leader + comment text on ASH-MARKUP; one undo step', () => {
  const s = new Session(newDocument());
  const ents = addMarkup(s, 'circle', { c: { x: 10, y: 10 }, r: 4 }, { ...meta, comment: 'Check damper access' });
  assert.deepEqual(ents.map((e) => e.type), ['CIRCLE', 'LINE', 'MTEXT']);
  const [shape, , text] = ents;
  assert.equal(shape.layer, MARKUP_LAYER);
  assert.equal(shape.color, 1);
  assert.equal(shape.linetype, 'DASHED');
  assert.match(text.text, /Check damper access/);
  const layer = s.doc.layers.get(MARKUP_LAYER);
  assert.deepEqual([layer.color, layer.linetype, layer.plot], [1, 'DASHED', true]);
  const [m] = listMarkups(s.doc);
  assert.deepEqual([m.no, m.kind, m.comment, m.status, m.author, m.ids.length], [1, 'circle', 'Check damper access', 'Open', 'Ahmad', 3]);
  s.undo();
  assert.equal(listMarkups(s.doc).length, 0);
});

test('ASH_MARKUP XDATA round-trips through writeDxf/parseDxf incl. status, author, date, comment', () => {
  const s = new Session(newDocument());
  const long = 'Relocate VCD for access; '.repeat(12).trim();
  addMarkup(s, 'circle', { c: { x: 0, y: 0 }, r: 2 }, { ...meta, comment: 'Check damper access, "east" side' });
  addMarkup(s, 'rect', { p1: { x: 10, y: 0 }, p2: { x: 20, y: 5 } }, { ...meta, comment: long });
  addMarkup(s, 'text', { p: { x: 30, y: 0 } }, { ...meta, comment: 'Note: see spec 23 31 13' });
  setMarkupStatus(s, listMarkups(s.doc)[0].uid, 'Closed');
  const back = parseDxf(writeDxf(s.doc));
  const strip = (l) => l.map(({ ids, bbox, uid, ...r }) => r);
  assert.deepEqual(strip(listMarkups(back)), strip(listMarkups(s.doc)));
  const got = listMarkups(back);
  assert.deepEqual(got.map((m) => [m.no, m.status, m.author, m.date]), [[1, 'Closed', 'Ahmad', '2026-10-08'], [2, 'Open', 'Ahmad', '2026-10-08'], [3, 'Open', 'Ahmad', '2026-10-08']]);
  assert.equal(got[1].comment, long);
  assert.equal(back.layers.get(MARKUP_LAYER).linetype, 'DASHED');
  assert.deepEqual(back.linetypes.get('DASHED').pattern, [0.5, -0.25]);
});

test('delete, status, hide and CSV', () => {
  const s = new Session(newDocument());
  addMarkup(s, 'circle', { c: { x: 0, y: 0 }, r: 2 }, { ...meta, comment: 'a, b' });
  addMarkup(s, 'rect', { p1: { x: 5, y: 5 }, p2: { x: 8, y: 9 } }, { ...meta, comment: 'Check damper access' });
  const [a, b] = listMarkups(s.doc);
  assert.equal(setMarkupStatus(s, b.uid, 'Closed'), 3);
  assert.equal(markupData(s.doc.entities.find((e) => e.id === b.ids[0])).status, 'Closed');
  assert.equal(markupsCsv(listMarkups(s.doc)), 'No,Comment,Author,Date,Status\r\n1,"a, b",Ahmad,2026-10-08,Open\r\n2,Check damper access,Ahmad,2026-10-08,Closed\r\n');
  assert.equal(deleteMarkup(s, a.uid), 3);
  assert.deepEqual(listMarkups(s.doc).map((m) => m.no), [2]);
  setMarkupsVisible(s, false);
  assert.equal(s.doc.layers.get(MARKUP_LAYER).visible, false);
});

test('ezdxf reads the ASH_MARKUP XDATA and the DASHED layer linetype; audit clean', { skip: !ezdxfAvailable() && 'ezdxf not installed' }, (t) => {
  const s = new Session(newDocument());
  addMarkup(s, 'circle', { c: { x: 10, y: 10 }, r: 4 }, { ...meta, comment: 'Check damper access' });
  const dir = mkdtempSync(path.join(tmpdir(), 'ashmarkup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'markup.dxf');
  writeFileSync(file, writeDxf(s.doc));
  const audit = validateWithEzdxf(file);
  assert.equal(audit.audit_errors, 0, JSON.stringify(audit.audit_messages));
  const py = 'import ezdxf, json, sys\ndoc = ezdxf.readfile(sys.argv[1])\n'
    + 'c = doc.modelspace().query("CIRCLE")[0]\n'
    + 'print(json.dumps({"xd": [v for _, v in c.get_xdata("ASH_MARKUP")], "lt": doc.layers.get("ASH-MARKUP").dxf.linetype, "pat": len(doc.linetypes.get("DASHED").pattern_tags.tags) > 0, "plot": doc.layers.get("ASH-MARKUP").dxf.plot}))';
  const r = spawnSync(ezdxfAvailable(), ['-c', py, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.equal(got.lt, 'DASHED');
  assert.equal(got.pat, true);
  assert.equal(got.plot, 1);
  for (const want of ['role=shape', 'kind=circle', 'author=Ahmad', 'date=2026-10-08', 'status=Open', 'comment=Check damper access']) assert.ok(got.xd.includes(want), `${want} in ${got.xd}`);
});
