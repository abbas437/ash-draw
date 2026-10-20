import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { newDocument } from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import {
  addMarkup, listMarkups, setMarkupStatus, deleteMarkup, markupData, markupsCsv, setMarkupsVisible, MARKUP_LAYER,
  setMarkupCode, renumberMarkups, markupsCrsSheet, markupXData, MARKUP_STATUSES,
} from '../src/core/markup.js';
import { xlsxBytes } from '../src/core/xlsx.js';
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

test('status In progress round-trips (XDATA, DXF, CSV); closing with no code sets code A in one undo step, a chosen code stays', () => {
  const s = new Session(newDocument());
  addMarkup(s, 'circle', { c: { x: 0, y: 0 }, r: 2 }, { ...meta, comment: 'one' });
  addMarkup(s, 'rect', { p1: { x: 5, y: 5 }, p2: { x: 8, y: 9 } }, { ...meta, comment: 'two' });
  addMarkup(s, 'text', { p: { x: 30, y: 0 } }, { ...meta, comment: 'three' });
  const [a, b, c] = listMarkups(s.doc);
  assert.deepEqual(MARKUP_STATUSES, ['Open', 'In progress', 'Closed']);
  setMarkupStatus(s, a.uid, 'In progress');
  assert.deepEqual([listMarkups(s.doc)[0].status, listMarkups(s.doc)[0].code], ['In progress', ''], 'In progress does not set a code');
  const back = listMarkups(parseDxf(writeDxf(s.doc)));
  assert.equal(back[0].status, 'In progress');
  assert.match(markupsCsv(listMarkups(s.doc)), /,In progress\r\n/);
  // closing with an empty code -> A, one undo step covering every part
  const before = s.undoStack?.length;
  setMarkupStatus(s, b.uid, 'Closed');
  assert.deepEqual([listMarkups(s.doc)[1].status, listMarkups(s.doc)[1].code], ['Closed', 'A']);
  if (before !== undefined) assert.equal(s.undoStack.length, before + 1);
  s.undo();
  assert.deepEqual([listMarkups(s.doc)[1].status, listMarkups(s.doc)[1].code], ['Open', ''], 'one undo reverts status and code together');
  // an explicit code is never overwritten
  setMarkupCode(s, c.uid, 'B'); setMarkupStatus(s, c.uid, 'Closed');
  assert.deepEqual([listMarkups(s.doc)[2].status, listMarkups(s.doc)[2].code], ['Closed', 'B']);
  assert.equal(setMarkupStatus(s, c.uid, 'Bogus'), 0);
});

test('delete, status, hide and CSV', () => {
  const s = new Session(newDocument());
  addMarkup(s, 'circle', { c: { x: 0, y: 0 }, r: 2 }, { ...meta, comment: 'a, b' });
  addMarkup(s, 'rect', { p1: { x: 5, y: 5 }, p2: { x: 8, y: 9 } }, { ...meta, comment: 'Check damper access' });
  const [a, b] = listMarkups(s.doc);
  assert.equal(setMarkupStatus(s, b.uid, 'Closed'), 3);
  assert.equal(markupData(s.doc.entities.find((e) => e.id === b.ids[0])).status, 'Closed');
  assert.equal(markupsCsv(listMarkups(s.doc)), '\uFEFFNo,Comment,Author,Date,Status\r\n1,"a, b",Ahmad,2026-10-08,Open\r\n2,Check damper access,Ahmad,2026-10-08,Closed\r\n');
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

test('review code: B round-trips through writeDxf/parseDxf; a markup saved without a code reads as none', () => {
  const s = new Session(newDocument());
  addMarkup(s, 'circle', { c: { x: 0, y: 0 }, r: 2 }, { ...meta, comment: 'Coded' });
  addMarkup(s, 'rect', { p1: { x: 5, y: 5 }, p2: { x: 8, y: 9 } }, { ...meta, comment: 'Old' });
  const [a, b] = listMarkups(s.doc);
  assert.equal(setMarkupCode(s, a.uid, 'B'), 3);
  // an old file: the second markup's XDATA is as written before review codes existed (no code key at all)
  for (const e of s.doc.entities) if (markupData(e).uid === b.uid) assert.ok(!e.xdata.ASH_MARKUP.some(([, v]) => v.startsWith('code=')));
  const back = listMarkups(parseDxf(writeDxf(s.doc)));
  assert.deepEqual(back.map((m) => [m.comment, m.code]), [['Coded', 'B'], ['Old', '']]);
  assert.equal(setMarkupCode(s, a.uid, ''), 3);
  assert.equal(listMarkups(parseDxf(writeDxf(s.doc)))[0].code, '');
  s.undo();
  assert.equal(listMarkups(s.doc)[0].code, 'B', 'a code change is one undo step');
  assert.deepEqual(markupXData({ uid: 'U', no: 1, status: 'Open', code: '' }).ASH_MARKUP.map(([, v]) => v), ['uid=U', 'no=1', 'status=Open', 'comment=']);
});

test('numbering: an explicit start number, renumber in order with the drawn numbers, one undo step', () => {
  const s = new Session(newDocument());
  addMarkup(s, 'circle', { c: { x: 0, y: 0 }, r: 2 }, { ...meta, comment: 'First', no: 5 });
  addMarkup(s, 'text', { p: { x: 9, y: 0 } }, { ...meta, comment: 'Second' });
  addMarkup(s, 'rect', { p1: { x: 5, y: 5 }, p2: { x: 8, y: 9 } }, { ...meta, comment: 'Third', no: 2 });
  const texts = () => s.doc.entities.filter((e) => e.type === 'MTEXT').map((e) => e.text);
  assert.deepEqual(listMarkups(s.doc).map((m) => m.no), [2, 5, 6]);
  assert.deepEqual(texts(), ['5: First', '6: Second', '2: Third']);
  const steps = s.undoStack.length;
  assert.equal(renumberMarkups(s), 3);
  assert.equal(s.undoStack.length, steps + 1);
  assert.deepEqual(listMarkups(s.doc).map((m) => [m.no, m.comment]), [[1, 'Third'], [2, 'First'], [3, 'Second']]);
  assert.deepEqual(texts(), ['2: First', '3: Second', '1: Third']);
  assert.ok(s.doc.entities.every((e) => [1, 2, 3].includes(markupData(e).no)), 'every part carries the new number');
  s.undo();
  assert.deepEqual(texts(), ['5: First', '6: Second', '2: Third']);
  assert.deepEqual(listMarkups(s.doc).map((m) => m.no), [2, 5, 6]);
  assert.equal(renumberMarkups(s, 10), 3);
  assert.deepEqual(texts(), ['11: First', '12: Second', '10: Third']);
});

const hasOpenpyxl = (() => { try { execFileSync('python3', ['-I', '-c', 'import openpyxl'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('Export to CRS: 7 columns, header block, Calibri 11, wrapped comments, Status filled by code, drop-downs; well-formed parts', { skip: !hasOpenpyxl && 'python3 openpyxl not available' }, (t) => {
  const s = new Session(newDocument());
  addMarkup(s, 'circle', { c: { x: 0, y: 0 }, r: 2 }, { ...meta, comment: 'Damper access <600> & "east"' });
  addMarkup(s, 'rect', { p1: { x: 5, y: 5 }, p2: { x: 8, y: 9 } }, { ...meta, comment: 'Duct size to suit' });
  addMarkup(s, 'text', { p: { x: 30, y: 0 } }, { ...meta, comment: 'No code yet' });
  const [a, b] = listMarkups(s.doc);
  setMarkupCode(s, a.uid, 'A'); setMarkupCode(s, b.uid, 'B'); setMarkupStatus(s, b.uid, 'Closed');
  const bytes = xlsxBytes([markupsCrsSheet([{ name: 'Model', markups: listMarkups(s.doc) }], { drawing: 'HVAC-01.dxf', date: '2026-10-20' })]);
  const dir = mkdtempSync(path.join(tmpdir(), 'ashcrs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'HVAC-01-CRS.xlsx');
  writeFileSync(file, bytes);
  const py = ['import sys, json, zipfile, re, xml.dom.minidom as m, openpyxl',
    'z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None',
    'for n in z.namelist(): m.parseString(z.read(n))',
    'over = set(re.findall(r\'PartName="/([^"]+)"\', z.read("[Content_Types].xml").decode()))',
    'missing = [n for n in z.namelist() if n not in over and not n.endswith(".rels") and n != "[Content_Types].xml"]',
    'ws = openpyxl.load_workbook(sys.argv[1]).active',
    'rows = [[c.value for c in r] for r in ws.iter_rows(min_row=5, max_row=ws.max_row, max_col=7)]',
    'data = list(ws.iter_rows(min_row=6, max_row=ws.max_row, max_col=7))',
    'fill = lambda c: c.fill.fgColor.rgb if c.fill.fill_type == "solid" else None',
    'print(json.dumps({"missing": missing, "head": [ws["A2"].value, ws["B2"].value, ws["A3"].value, ws["B3"].value], "rows": rows,',
    '  "fills": [fill(r[5]) for r in data], "fonts": sorted({(c.font.name, c.font.sz) for r in data for c in r}),',
    '  "wrap": [r[2].alignment.wrap_text for r in data], "dv": sorted((str(d.sqref), d.formula1) for d in ws.data_validations.dataValidation)}))'].join('\n');
  const r = spawnSync('python3', ['-I', '-c', py, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.deepEqual(got.missing, [], 'every part is listed in [Content_Types].xml');
  assert.deepEqual(got.head, ['Drawing', 'HVAC-01.dxf', 'Export date', '2026-10-20']);
  assert.deepEqual(got.rows, [
    ['No.', 'Sheet / Layout', 'Comment', 'Reviewer', 'Date', 'Status', 'Code'],
    [1, 'Model', 'Damper access <600> & "east"', 'Ahmad', '2026-10-08', 'Open', 'A'],
    [2, 'Model', 'Duct size to suit', 'Ahmad', '2026-10-08', 'Closed', 'B'],
    [3, 'Model', 'No code yet', 'Ahmad', '2026-10-08', 'Open', null],
  ]);
  assert.deepEqual(got.fills, ['FF00B050', 'FFFFC000', null], 'Status fill: A green, B orange, none');
  assert.deepEqual(got.fonts, [['Calibri', 11]]);
  assert.deepEqual(got.wrap, [true, true, true]);
  assert.deepEqual(got.dv, [['F6:F8', '"Open,In progress,Closed"'], ['G6:G8', '"A,B,C"']]);
});
