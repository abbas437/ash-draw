// CSV export for Excel (src/core/csv.js) and the suggested PDF name of a plot (renderer/files.js plotPdfName).
import test from 'node:test';
import assert from 'node:assert/strict';
import { markupsCsv } from '../src/core/markup.js';
import { symcountCsv } from '../src/core/symcount.js';
import { csvCell } from '../src/core/csv.js';
import { plotPdfName } from '../renderer/files.js';
import { openDialogDir } from '../electron/savePath.js';

const m = (comment) => ({ no: 1, comment, author: 'A', date: '2026-10-20', status: 'Open' });

test('markupsCsv: starts with the UTF-8 BOM, formula cells get an apostrophe, normal text is unchanged', () => {
  const csv = markupsCsv([m('=SUM(1,2)'), m('+1'), m('-1'), m('@x'), m('\tx'), m('Check damper'), m('تعليق')]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.deepEqual([...new TextEncoder().encode(csv).slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[1], `1,"'=SUM(1,2)",A,2026-10-20,Open`);
  assert.equal(lines[2], "1,'+1,A,2026-10-20,Open");
  assert.equal(lines[3], "1,'-1,A,2026-10-20,Open");
  assert.equal(lines[4], "1,'@x,A,2026-10-20,Open");
  assert.equal(lines[5], "1,'\tx,A,2026-10-20,Open");
  assert.equal(lines[6], '1,Check damper,A,2026-10-20,Open');
  assert.equal(lines[7], '1,تعليق,A,2026-10-20,Open');
});

test('csvCell: a cell starting with a carriage return is guarded and quoted; the symbol count shares the helper', () => {
  assert.equal(csvCell('\rx'), '"\'\rx"');
  assert.equal(symcountCsv([{ name: '=cmd', count: 1, layers: ['0'] }]), "\uFEFFSymbol,Count,Layers\r\n'=cmd,1,0\r\n");
});

test('plotPdfName: layout name in the suggestion, made safe for Windows; Model keeps the drawing name', () => {
  assert.equal(plotPdfName('A-101.dxf', 'SHEET-01'), 'A-101-SHEET-01.pdf');
  assert.equal(plotPdfName('A-101.dxf', 'A/B:C'), 'A-101-A_B_C.pdf');
  assert.equal(plotPdfName('A-101.dxf', 'x<>"\\|?*y\u0001z'), 'A-101-x_______y_z.pdf');
  assert.equal(plotPdfName('A-101.dxf', 'Sheet 1. . '), 'A-101-Sheet 1.pdf');
  assert.equal(plotPdfName('A-101.dxf', null), 'A-101.pdf');
  assert.equal(plotPdfName('C:\\p\\A-101.dwg'), 'A-101.pdf');
});

test('openDialogDir: the drawing folder when it exists on this host, else undefined (last-used folder)', () => {
  const isDir = (d) => d === 'C:\\Proj\\Sheets' || d === '/home/u/proj';
  assert.equal(openDialogDir('C:\\Proj\\Sheets\\', { isDir, hostSep: '\\' }), 'C:\\Proj\\Sheets');
  assert.equal(openDialogDir('/home/u/proj/', { isDir, hostSep: '/' }), '/home/u/proj');
  assert.equal(openDialogDir('C:\\Gone\\', { isDir, hostSep: '\\' }), undefined);
  assert.equal(openDialogDir('C:\\Proj\\Sheets\\', { isDir, hostSep: '/' }), undefined);
  assert.equal(openDialogDir('', { isDir, hostSep: '\\' }), undefined);
  assert.equal(openDialogDir(undefined, { isDir, hostSep: '/' }), undefined);
});
