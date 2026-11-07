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
  addFollowUp, editFollowUp, removeFollowUp, setMarkupRev, nextRevLabel, MARKUP_XDATA_LIMIT, saveFollowUps, markupLabel,
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
  assert.match(markupsCsv(listMarkups(s.doc)), /,In progress,\r\n/);
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
  assert.equal(markupsCsv(listMarkups(s.doc)), '\uFEFFNo,Rev.,Comment,Author,Date,Status,Follow-ups\r\n1,,"a, b",Ahmad,2026-10-08,Open,\r\n2,,Check damper access,Ahmad,2026-10-08,Closed,\r\n');
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
test('Export to CRS: 8 columns (Rev. after No.), header block, Calibri 11, wrapped comments, Status filled by code, drop-downs; well-formed parts', { skip: !hasOpenpyxl && 'python3 openpyxl not available' }, (t) => {
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
    'rows = [[c.value for c in r] for r in ws.iter_rows(min_row=5, max_row=ws.max_row, max_col=8)]',
    'data = list(ws.iter_rows(min_row=6, max_row=ws.max_row, max_col=8))',
    'fill = lambda c: c.fill.fgColor.rgb if c.fill.fill_type == "solid" else None',
    'print(json.dumps({"missing": missing, "head": [ws["A2"].value, ws["B2"].value, ws["A3"].value, ws["B3"].value], "rows": rows,',
    '  "fills": [fill(r[6]) for r in data], "fonts": sorted({(c.font.name, c.font.sz) for r in data for c in r}),',
    '  "wrap": [r[3].alignment.wrap_text for r in data], "dv": sorted((str(d.sqref), d.formula1) for d in ws.data_validations.dataValidation)}))'].join('\n');
  const r = spawnSync('python3', ['-I', '-c', py, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.deepEqual(got.missing, [], 'every part is listed in [Content_Types].xml');
  assert.deepEqual(got.head, ['Drawing', 'HVAC-01.dxf', 'Export date', '2026-10-20']);
  assert.deepEqual(got.rows, [
    ['No.', 'Rev.', 'Sheet / Layout', 'Comment', 'Reviewer', 'Date', 'Status', 'Code'],
    [1, null, 'Model', 'Damper access <600> & "east"', 'Ahmad', '2026-10-08', 'Closed', 'A'], // code A closes the item
    [2, null, 'Model', 'Duct size to suit', 'Ahmad', '2026-10-08', 'Closed', 'B'],
    [3, null, 'Model', 'No code yet', 'Ahmad', '2026-10-08', 'Open', null],
  ]);
  assert.deepEqual(got.fills, ['FF00B050', 'FFFFC000', null], 'Status fill: A green, B orange, none');
  assert.deepEqual(got.fonts, [['Calibri', 11]]);
  assert.deepEqual(got.wrap, [true, true, true]);
  assert.deepEqual(got.dv, [['G6:G8', '"Open,In progress,Closed"'], ['H6:H8', '"A,B,C"']]);
});

// ---- Rev.xx follow-ups ----
const LONG = ('Resubmitted: VCD moved | access panel = 600x600; ' + 'تم نقل المخمد. ').repeat(14);
const mtext = (doc, uid) => doc.entities.find((e) => e.type === 'MTEXT' && markupData(e).uid === uid).text;
const plain = (l) => l.map(({ ids, bbox, ...r }) => r);

test('follow-ups: rev and 2 follow-ups (long text, |, =, newlines, Arabic) round-trip through writeDxf/parseDxf on every part', () => {
  const s = new Session(newDocument());
  addMarkup(s, 'circle', { c: { x: 0, y: 0 }, r: 2 }, { ...meta, comment: 'Check damper access', code: 'B', rev: 'Rev.00' });
  addMarkup(s, 'text', { p: { x: 30, y: 0 } }, { ...meta, comment: 'Note' });
  const [a] = listMarkups(s.doc);
  const t2 = 'Line one | a=b\nLine two 100% done\r\nملاحظة: تمت المعالجة';
  assert.ok(LONG.length > 600);
  addFollowUp(s, a.uid, { rev: 'Rev.01', text: LONG, code: 'B', status: 'In progress', author: 'AA', date: '2026-11-01' });
  addFollowUp(s, a.uid, { rev: 'Rev.02', text: t2, code: 'A', author: 'AA', date: '2026-11-07' });
  for (const e of s.doc.entities.filter((x) => markupData(x).uid === a.uid)) {
    for (const [, v] of e.xdata.ASH_MARKUP) if (/^fu\d+\.text=/.test(v)) assert.ok(v.length <= 210 && !/[\r\n]/.test(v), 'pieces short, no raw newlines');
  }
  const back = parseDxf(writeDxf(s.doc));
  assert.deepEqual(plain(listMarkups(back)), plain(listMarkups(s.doc)));
  const [m, n] = listMarkups(back);
  assert.equal(m.rev, 'Rev.00');
  assert.deepEqual(m.followUps, [
    { rev: 'Rev.01', text: LONG.trim(), code: 'B', status: 'In progress', author: 'AA', date: '2026-11-01' },
    { rev: 'Rev.02', text: t2, code: 'A', status: 'Closed', author: 'AA', date: '2026-11-07' },
  ]);
  assert.deepEqual([m.status, m.code], ['Closed', 'A'], 'latest round');
  for (const e of back.entities.filter((x) => markupData(x).uid === m.uid)) {
    const d = markupData(e);
    assert.deepEqual([d.followUps, d.rev, d.origCode, d.origStatus], [m.followUps, 'Rev.00', 'B', 'Open']);
  }
  assert.deepEqual([n.rev, n.followUps], ['', []]);
});

test('follow-ups: an old-file markup (no rev, no follow-up keys) reads rev "" and followUps []; existing fields unchanged', () => {
  const e = { xdata: { ASH_MARKUP: [[1000, 'uid=U'], [1000, 'no=4'], [1000, 'role=shape'], [1000, 'kind=circle'], [1000, 'author=A'], [1000, 'date=2026-01-01'], [1000, 'status=Open'], [1000, 'code=B'], [1000, 'comment=Old']] } };
  const d = markupData(e);
  assert.deepEqual(d, { uid: 'U', no: 4, role: 'shape', kind: 'circle', author: 'A', date: '2026-01-01', status: 'Open', code: 'B', comment: 'Old', rev: '', followUps: [], origStatus: 'Open', origCode: 'B' });
  assert.deepEqual(markupXData(d), e.xdata, 'written back byte for byte');
});

test('follow-ups: latest code and status after add, edit and remove; A gives Closed; status/code edits go to the latest round', () => {
  const s = new Session(newDocument());
  addMarkup(s, 'rect', { p1: { x: 0, y: 0 }, p2: { x: 4, y: 4 } }, { ...meta, comment: 'Duct size', code: 'C' });
  const { uid } = listMarkups(s.doc)[0];
  const cur = () => { const [m] = listMarkups(s.doc); return [m.status, m.code, m.followUps.length]; };
  assert.equal(addFollowUp(s, uid, { rev: 'Rev.01', text: 'Not yet', code: 'B', ...meta }), 3);
  assert.deepEqual(cur(), ['Open', 'B', 1]);
  addFollowUp(s, uid, { text: 'Addressed', code: 'A', ...meta });
  assert.deepEqual(cur(), ['Closed', 'A', 2]);
  assert.equal(listMarkups(s.doc)[0].followUps[1].rev, 'Rev.02', 'no rev = the next label');
  editFollowUp(s, uid, 1, { code: 'B', status: 'Open' });
  assert.deepEqual(cur(), ['Open', 'B', 2]);
  editFollowUp(s, uid, 1, { code: 'A' });
  assert.deepEqual(cur(), ['Closed', 'A', 2], 'code A without a status closes');
  setMarkupCode(s, uid, 'C'); setMarkupStatus(s, uid, 'In progress');
  assert.deepEqual(listMarkups(s.doc)[0].followUps.map((f) => [f.code, f.status]), [['B', 'Open'], ['C', 'In progress']]);
  assert.equal(editFollowUp(s, uid, 5, { text: 'x' }), 0);
  removeFollowUp(s, uid, 1);
  assert.deepEqual(cur(), ['Open', 'B', 1]);
  removeFollowUp(s, uid, 0);
  assert.deepEqual(cur(), ['Open', 'C', 0], 'the original round comes back');
  assert.ok(!s.doc.entities[0].xdata.ASH_MARKUP.some(([, v]) => /^(fu|ostatus|ocode)/.test(v)));
  assert.throws(() => addFollowUp(s, uid, { text: 'ملاحظة '.repeat(500) }), RangeError);
  assert.ok(MARKUP_XDATA_LIMIT >= 16000);
  assert.deepEqual(cur(), ['Open', 'C', 0], 'a refused follow-up changes nothing');
});

test('follow-ups: undo and redo of addFollowUp, editFollowUp, removeFollowUp and setMarkupRev, one step each', () => {
  const s = new Session(newDocument());
  addMarkup(s, 'circle', { c: { x: 0, y: 0 }, r: 2 }, { ...meta, comment: 'C1' });
  const { uid } = listMarkups(s.doc)[0];
  const snap = () => JSON.stringify(plain(listMarkups(s.doc))) + mtext(s.doc, uid);
  const steps = [
    () => addFollowUp(s, uid, { rev: 'Rev.01', text: 'F1', code: 'B' }),
    () => editFollowUp(s, uid, 0, { text: 'F1 edited' }),
    () => setMarkupRev(s, uid, 'Rev.00'),
    () => removeFollowUp(s, uid, 0),
  ];
  for (const step of steps) {
    const before = snap(), n = s.undoStack.length;
    step();
    const after = snap();
    assert.notEqual(after, before);
    assert.equal(s.undoStack.length, n + 1);
    s.undo(); assert.equal(snap(), before);
    s.redo(); assert.equal(snap(), after);
  }
  assert.equal(listMarkups(s.doc)[0].rev, 'Rev.00');
});

test('follow-ups: the MTEXT shows each follow-up as a blue (ACI 5) paragraph, escaped; redrawn on renumber', () => {
  const s = new Session(newDocument());
  addMarkup(s, 'circle', { c: { x: 0, y: 0 }, r: 2 }, { ...meta, comment: 'First', no: 5 });
  addMarkup(s, 'text', { p: { x: 9, y: 0 } }, { ...meta, comment: 'Second' });
  const [a, b] = listMarkups(s.doc);
  addFollowUp(s, a.uid, { rev: 'Rev.01', text: 'Moved {see} C:\\dwg\nok', code: 'B' });
  addFollowUp(s, a.uid, { rev: 'Rev.02', text: 'Done', code: 'A' });
  assert.equal(mtext(s.doc, a.uid), '5: First\\P{\\C5;Rev.01: Moved \\{see\\} C:\\\\dwg\\Pok}\\P{\\C5;Rev.02: Done}');
  editFollowUp(s, a.uid, 1, { text: 'Closed out' });
  assert.equal(mtext(s.doc, a.uid), '5: First\\P{\\C5;Rev.01: Moved \\{see\\} C:\\\\dwg\\Pok}\\P{\\C5;Rev.02: Closed out}');
  assert.equal(mtext(parseDxf(writeDxf(s.doc)), a.uid), mtext(s.doc, a.uid), 'MTEXT round-trips');
  renumberMarkups(s);
  assert.equal(mtext(s.doc, a.uid), '1: First\\P{\\C5;Rev.01: Moved \\{see\\} C:\\\\dwg\\Pok}\\P{\\C5;Rev.02: Closed out}');
  assert.equal(mtext(s.doc, b.uid), '2: Second', 'a markup without follow-ups keeps the number rewrite');
  removeFollowUp(s, a.uid, 0); removeFollowUp(s, a.uid, 0);
  assert.equal(mtext(s.doc, a.uid), '1: First');
});

test('nextRevLabel: Rev.xx, R00, Rev 1, Rev.A, none; keeps the style of the highest label', () => {
  assert.equal(nextRevLabel(['Rev.00', 'Rev.01']), 'Rev.02');
  assert.equal(nextRevLabel(['Rev.01', 'Rev.00']), 'Rev.02');
  assert.equal(nextRevLabel(['R00']), 'R01');
  assert.equal(nextRevLabel(['R09']), 'R10');
  assert.equal(nextRevLabel(['Rev 1']), 'Rev 2');
  assert.equal(nextRevLabel(['Rev.A']), 'Rev.B');
  assert.equal(nextRevLabel(['rev.b']), 'rev.c');
  assert.equal(nextRevLabel(['Rev.A', 'Rev.03', '', 'junk']), 'Rev.04', 'numbers rank above letters');
  assert.equal(nextRevLabel(['Rev.99']), 'Rev.100');
  assert.equal(nextRevLabel([]), 'Rev.01');
  assert.equal(nextRevLabel(['', 'x']), 'Rev.01');
});

test('ezdxf: a drawing with follow-ups (Arabic, long text) audits clean; ezdxf reads the follow-up pieces', { skip: !ezdxfAvailable() && 'ezdxf not installed' }, (t) => {
  const s = new Session(newDocument());
  addMarkup(s, 'circle', { c: { x: 10, y: 10 }, r: 4 }, { ...meta, comment: 'Check damper access', rev: 'Rev.00', code: 'B' });
  const { uid } = listMarkups(s.doc)[0];
  addFollowUp(s, uid, { rev: 'Rev.01', text: LONG, code: 'B' });
  addFollowUp(s, uid, { rev: 'Rev.02', text: 'Addressed | ok = yes\nthanks', code: 'A' });
  const dir = mkdtempSync(path.join(tmpdir(), 'ashmarkup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'markup-fu.dxf');
  writeFileSync(file, writeDxf(s.doc));
  const audit = validateWithEzdxf(file);
  assert.equal(audit.audit_errors, 0, JSON.stringify(audit.audit_messages));
  const py = 'import ezdxf, json, sys\ndoc = ezdxf.readfile(sys.argv[1])\nc = doc.modelspace().query("CIRCLE")[0]\nprint(json.dumps([v for _, v in c.get_xdata("ASH_MARKUP")]))';
  const r = spawnSync(ezdxfAvailable(), ['-c', py, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const xd = JSON.parse(r.stdout.trim());
  const u = (v) => v.replace(/\\U\+([0-9A-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); // ezdxf keeps the DXF \U+ escapes
  assert.equal(u(xd.filter((v) => v.startsWith('fu1.text=')).map((v) => v.slice(9)).join('')), LONG.trim());
  assert.ok(xd.every((v) => v.length <= 255), 'every XDATA string within 255 bytes');
  assert.ok(xd.includes('fu2.text=Addressed | ok = yes%0Athanks') && xd.includes('status=Closed') && xd.includes('ocode=B'));
});

test('long Arabic / mixed comments: pieces stay within 255 DXF bytes, round-trip exactly, ezdxf audit clean', { skip: !ezdxfAvailable() && 'ezdxf not installed' }, (t) => {
  const arabic = 'تعليق على مجرى الهواء '.repeat(20).slice(0, 300);
  const mixed = Array.from({ length: 700 }, (_, i) => (i % 3 === 0 ? 'ع' : i % 3 === 1 ? 'a' : ' ')).join('');
  const s = new Session(newDocument());
  addMarkup(s, 'circle', { c: { x: 0, y: 0 }, r: 2 }, { ...meta, comment: arabic });
  addMarkup(s, 'rect', { p1: { x: 5, y: 5 }, p2: { x: 8, y: 9 } }, { ...meta, comment: mixed });
  const dxf = writeDxf(s.doc);
  const lines = dxf.split(/\r?\n/);
  let n = 0;
  for (let i = 0; i < lines.length - 1; i++) if (lines[i].trim() === '1000' && lines[i + 1].includes('=')) { n++; assert.ok(Buffer.byteLength(lines[i + 1]) <= 255, `XDATA line of ${Buffer.byteLength(lines[i + 1])} bytes`); }
  assert.ok(n > 6);
  const back = listMarkups(parseDxf(dxf));
  assert.equal(back[0].comment, arabic);
  assert.equal(back[1].comment, mixed);
  const dir = mkdtempSync(path.join(tmpdir(), 'ashmarkup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'markup-ar.dxf');
  writeFileSync(file, dxf);
  const audit = validateWithEzdxf(file);
  assert.equal(audit.audit_errors, 0, JSON.stringify(audit.audit_messages));
});

test('markupsCsv: Rev. column after the number, Follow-ups column with Rev.xx lines, latest status', () => {
  const s = new Session(newDocument());
  addMarkup(s, 'circle', { c: { x: 0, y: 0 }, r: 2 }, { ...meta, comment: 'Damper access', code: 'B', rev: 'Rev.00' });
  const { uid } = listMarkups(s.doc)[0];
  addFollowUp(s, uid, { rev: 'Rev.01', text: 'Still not shown', code: 'B', author: 'AA', date: '2026-11-01' });
  addFollowUp(s, uid, { rev: 'Rev.02', text: '=ok', code: 'A', author: 'AA', date: '2026-11-07' });
  assert.equal(markupsCsv(listMarkups(s.doc)), '\uFEFFNo,Rev.,Comment,Author,Date,Status,Follow-ups\r\n1,Rev.00,Damper access,Ahmad,2026-10-08,Closed,"Rev.01: Still not shown\nRev.02: =ok"\r\n');
});

test('Export to CRS with follow-ups: rich-text comment, blue plain Rev.xx lines, Rev. column, latest code fill, review round, drop-downs', { skip: !hasOpenpyxl && 'python3 openpyxl not available' }, (t) => {
  const s = new Session(newDocument());
  addMarkup(s, 'circle', { c: { x: 0, y: 0 }, r: 2 }, { ...meta, comment: 'Damper access', code: 'B', rev: 'Rev.00' });
  addMarkup(s, 'rect', { p1: { x: 5, y: 5 }, p2: { x: 8, y: 9 } }, { ...meta, comment: 'Duct size <600> & "x"', code: 'C', rev: 'Rev.00' });
  addMarkup(s, 'text', { p: { x: 30, y: 0 } }, { ...meta, comment: 'Untouched', code: 'B' });
  const [a, b] = listMarkups(s.doc);
  addFollowUp(s, a.uid, { rev: 'Rev.01', text: 'Still not shown', code: 'B' });
  addFollowUp(s, a.uid, { rev: 'Rev.02', text: 'Addressed', code: 'A' });
  addFollowUp(s, b.uid, { rev: 'Rev.01', text: 'Revised & resubmit', code: 'B' });
  const bytes = xlsxBytes([markupsCrsSheet([{ name: 'Model', markups: listMarkups(s.doc) }], { drawing: 'HVAC-01.dxf', date: '2026-11-07' })]);
  const dir = mkdtempSync(path.join(tmpdir(), 'ashcrs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'HVAC-01-CRS.xlsx');
  writeFileSync(file, bytes);
  const py = ['import sys, json, zipfile, xml.dom.minidom as m, openpyxl',
    'z = zipfile.ZipFile(sys.argv[1]); [m.parseString(z.read(n)) for n in z.namelist()]',
    'ws = openpyxl.load_workbook(sys.argv[1], rich_text=True).active',
    'from openpyxl.cell.rich_text import CellRichText',
    'def runs(v):',
    '  if not isinstance(v, CellRichText): return v',
    '  return [[str(p.text), p.font.color.rgb if p.font.color is not None else None, bool(p.font.b), p.font.rFont, p.font.sz] for p in v]',
    'data = list(ws.iter_rows(min_row=7, max_row=ws.max_row, max_col=8))',
    'fill = lambda c: c.fill.fgColor.rgb if c.fill.fill_type == "solid" else None',
    'print(json.dumps({"head": [[c.value for c in r] for r in ws.iter_rows(min_row=1, max_row=6, max_col=8)],',
    '  "rows": [[runs(c.value) for c in r] for r in data], "fills": [fill(r[6]) for r in data],',
    '  "fonts": sorted({(c.font.name, c.font.sz) for r in data for c in r}), "wrap": [r[3].alignment.wrap_text for r in data],',
    '  "dv": sorted((str(d.sqref), d.formula1) for d in ws.data_validations.dataValidation)}))'].join('\n');
  const r = spawnSync('python3', ['-I', '-c', py, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  const pad = (row) => [...row, ...Array(8 - row.length).fill(null)];
  assert.deepEqual(got.head, [pad(['Comment Review Sheet (CRS) - drawing markups']), pad(['Drawing', 'HVAC-01.dxf']), pad(['Export date', '2026-11-07']),
    pad(['Review round', 'Rev.02']), pad([]), ['No.', 'Rev.', 'Sheet / Layout', 'Comment', 'Reviewer', 'Date', 'Status', 'Code']]);
  const BLUE = 'FF0070C0';
  assert.deepEqual(got.rows, [
    [1, 'Rev.00', 'Model', [['Damper access', null, false, 'Calibri', 11], ['\nRev.01: Still not shown', BLUE, false, 'Calibri', 11], ['\nRev.02: Addressed', BLUE, false, 'Calibri', 11]], 'Ahmad', '2026-10-08', 'Closed', 'A'],
    [2, 'Rev.00', 'Model', [['Duct size <600> & "x"', null, false, 'Calibri', 11], ['\nRev.01: Revised & resubmit', BLUE, false, 'Calibri', 11]], 'Ahmad', '2026-10-08', 'Open', 'B'],
    [3, null, 'Model', 'Untouched', 'Ahmad', '2026-10-08', 'Open', 'B'],
  ]);
  assert.deepEqual(got.fills, ['FF00B050', 'FFFFC000', 'FFFFC000'], 'Status fill from the latest code');
  assert.deepEqual(got.fonts, [['Calibri', 11]]);
  assert.deepEqual(got.wrap, [true, true, true]);
  assert.deepEqual(got.dv, [['G7:G9', '"Open,In progress,Closed"'], ['H7:H9', '"A,B,C"']]);
  // a markup without follow-ups is the same plain cell as before follow-ups existed
  const sheet = (list) => markupsCrsSheet([{ name: 'Model', markups: list }], { date: 'd' }).rows.at(-1);
  const plainRow = sheet(listMarkups(s.doc).slice(2));
  assert.deepEqual(plainRow[3], { v: 'Untouched', style: { vAlign: 'top', wrap: true } });
});

// ---- review fixes ----
test('code and status agree: code A closes, reopening clears code A (with and without follow-ups); B and C are kept', () => {
  const s = new Session(newDocument());
  addMarkup(s, 'text', { p: { x: 0, y: 0 } }, { ...meta, comment: 'one' });
  addMarkup(s, 'text', { p: { x: 9, y: 0 } }, { ...meta, comment: 'two' });
  const [a, b] = listMarkups(s.doc);
  const get = (uid) => { const m = listMarkups(s.doc).find((k) => k.uid === uid); return [m.code, m.status]; };
  setMarkupCode(s, a.uid, 'A');
  assert.deepEqual(get(a.uid), ['A', 'Closed'], 'code A sets Closed');
  setMarkupStatus(s, a.uid, 'In progress');
  assert.deepEqual(get(a.uid), ['', 'In progress'], 'In progress clears code A');
  setMarkupCode(s, a.uid, 'B'); setMarkupStatus(s, a.uid, 'Open');
  assert.deepEqual(get(a.uid), ['B', 'Open'], 'B is kept when reopened');
  setMarkupStatus(s, a.uid, 'Closed');
  assert.deepEqual(get(a.uid), ['B', 'Closed'], 'a chosen code is kept on closing');
  addFollowUp(s, b.uid, { rev: 'Rev.01', text: 'Addressed', code: 'B', status: 'Open', author: 'AR', date: '2026-11-07' });
  setMarkupCode(s, b.uid, 'A');
  assert.deepEqual(get(b.uid), ['A', 'Closed'], 'on the latest follow-up');
  setMarkupStatus(s, b.uid, 'Open');
  assert.deepEqual(get(b.uid), ['', 'Open']);
  assert.deepEqual(listMarkups(s.doc).find((k) => k.uid === b.uid).followUps.map((f) => [f.code, f.status]), [['', 'Open']]);
});

test('the comment line of the MTEXT is escaped (backslash, braces, newline as \\P); renumber keeps it', () => {
  assert.equal(markupLabel({ no: 3, comment: 'C:\\Pipes\\Unit {x}\nnext' }), '3: C:\\\\Pipes\\\\Unit \\{x\\}\\Pnext');
  const s = new Session(newDocument());
  addMarkup(s, 'text', { p: { x: 0, y: 0 } }, { ...meta, comment: 'C:\\Pipes\\Unit }', no: 4 });
  const text = () => s.doc.entities.find((e) => e.type === 'MTEXT').text;
  assert.equal(text(), '4: C:\\\\Pipes\\\\Unit \\}');
  renumberMarkups(s, 1);
  assert.equal(text(), '1: C:\\\\Pipes\\\\Unit \\}');
  addFollowUp(s, listMarkups(s.doc)[0].uid, { rev: 'Rev.01', text: 'ok', author: 'AR', date: '2026-11-07' });
  renumberMarkups(s, 7);
  assert.equal(text(), '7: C:\\\\Pipes\\\\Unit \\}\\P{\\C5;Rev.01: ok}');
  assert.equal(listMarkups(s.doc)[0].comment, 'C:\\Pipes\\Unit }', 'the stored comment is the raw text');
});

test('XDATA: a long Arabic author and rev labels are cut so every written line is at most 255 bytes', () => {
  const s = new Session(newDocument());
  const author = 'م'.repeat(40), rev = 'Rev.' + 'ر'.repeat(40);
  addMarkup(s, 'circle', { c: { x: 0, y: 0 }, r: 2 }, { author, date: '2026-11-07', rev, comment: 'تعليق '.repeat(60) });
  const { uid } = listMarkups(s.doc)[0];
  for (let i = 0; i < 12; i++) addFollowUp(s, uid, { rev: `${rev}%${i}`, text: `متابعة ${i}`, author, date: '2026-11-07' });
  const lines = writeDxf(s.doc).split(/\r?\n/).filter((l) => /^(uid|no|role|kind|author|date|status|code|comment|rev|ostatus|ocode|fu\d+\.\w+)=/.test(l));
  assert.ok(lines.some((l) => l.startsWith('fu12.author=')));
  const over = lines.filter((l) => Buffer.byteLength(l, 'utf8') > 255);
  assert.deepEqual(over, []);
  const m = listMarkups(parseDxf(writeDxf(s.doc)))[0];
  assert.equal(m.author, 'م'.repeat(30), 'author cut to 30 characters');
  assert.equal(m.rev, rev.slice(0, 20), 'rev cut to 20 characters');
  assert.equal(m.followUps[11].author, 'م'.repeat(30));
  assert.equal(m.followUps[11].rev, `${rev}%11`.slice(0, 20));
  assert.equal(m.followUps.length, 12);
});

test('saveFollowUps: edit, removals and a new follow-up in one undo step; all removed brings the original state back', () => {
  const s = new Session(newDocument());
  addMarkup(s, 'text', { p: { x: 0, y: 0 } }, { ...meta, comment: 'one', code: 'C' });
  const { uid } = listMarkups(s.doc)[0];
  addFollowUp(s, uid, { rev: 'Rev.01', text: 'a', code: 'B', author: 'AR', date: '2026-11-01' });
  addFollowUp(s, uid, { rev: 'Rev.02', text: 'b', code: 'B', author: 'AR', date: '2026-11-02' });
  saveFollowUps(s, uid, { index: 1, changes: { text: 'b2', date: '2026-11-07' }, remove: [0], add: { rev: 'Rev.03', text: 'c', code: 'A', author: 'ZZ', date: '2026-11-07' } });
  const fus = () => listMarkups(s.doc)[0].followUps.map((f) => [f.rev, f.text, f.author, f.date, f.code]);
  assert.deepEqual(fus(), [['Rev.02', 'b2', 'AR', '2026-11-07', 'B'], ['Rev.03', 'c', 'ZZ', '2026-11-07', 'A']]);
  assert.equal(listMarkups(s.doc)[0].status, 'Closed');
  s.undo();
  assert.deepEqual(fus().map((f) => f[1]), ['a', 'b'], 'one undo step');
  saveFollowUps(s, uid, { remove: [0, 1] });
  assert.deepEqual([listMarkups(s.doc)[0].followUps.length, listMarkups(s.doc)[0].code, listMarkups(s.doc)[0].status], [0, 'C', 'Open']);
});
