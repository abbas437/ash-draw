#!/usr/bin/env node
// Browser e2e of review rounds: Round field, new markups get the round, Follow-up… dialog (code A closes), Rev.xx tag,
// the CRS export with the blue Rev.01 line (checked with python openpyxl), and Import… of the Rev.00 markups onto a
// Rev.01 that is turned 90° and moved (automatic alignment, one undo step, Only open, duplicates, no markups, a big file).
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { writeDxf } from '../../src/core/dxfWrite.js';
import { newDocument, makeLine, makeCircle, makeText } from '../../src/core/model.js';
import { Session, addEntities } from '../../src/core/edit.js';
import { transformEntity, compose, rotation, translation, apply } from '../../src/core/geom.js';
import { addMarkup, listMarkups, setMarkupCode, setMarkupStatus } from '../../src/core/markup.js';

// ---- import fixtures (built with the core): a duct plan; Rev.01 is the same content turned 90° and moved ----
const DAMPER = { x: 40, y: 25 }, GRILLE = { x: 65, y: 55 }; // content circles: markup 1 circles the first, markup 2 boxes the second
function planContent(n = 12) {
  const out = [makeLine({ x: 0, y: 0 }, { x: 200, y: 0 }), makeLine({ x: 200, y: 0 }, { x: 200, y: 120 }), makeLine({ x: 200, y: 120 }, { x: 0, y: 120 }), makeLine({ x: 0, y: 120 }, { x: 0, y: 0 })];
  for (let i = 0; i < n; i++) out.push(makeLine({ x: 10 + (i % 12) * 15, y: 10 + Math.floor(i / 12) * 0.37 }, { x: 10 + (i % 12) * 15 + 3 * (i % 12), y: 17 + (i % 12) * 4 + Math.floor(i / 12) * 0.37 }));
  for (let i = 0; i < 6; i++) out.push(makeCircle({ x: 40 + i * 25, y: 25 + (i % 3) * 30 }, 2 + i));
  for (let i = 0; i < 4; i++) out.push(makeText({ x: 20 + i * 40, y: 100 }, 3, `VCD-${i + 1}`));
  return out;
}
const sessionOf = (ents) => { const d = newDocument(); d.units = 4; const s = new Session(d); addEntities(s, ents); return s; };
const MOVE = compose(translation(500, -300), rotation(Math.PI / 2));
const meta = { author: 'AR', date: '2026-11-07', rev: 'Rev.00' };
const rev00 = sessionOf(planContent());
addMarkup(rev00, 'circle', { c: DAMPER, r: 6 }, { ...meta, comment: 'Damper access' });
addMarkup(rev00, 'rect', { p1: { x: 60, y: 50 }, p2: { x: 70, y: 60 } }, { ...meta, comment: 'Grille size' });
{ const [m1, m2] = listMarkups(rev00.doc); setMarkupCode(rev00, m1.uid, 'B'); setMarkupCode(rev00, m2.uid, 'C'); }
const REV00 = writeDxf(rev00.doc);
addMarkup(rev00, 'text', { p: { x: 150, y: 110 } }, { ...meta, comment: 'Label font' }); // Rev.00 with a third, closed markup
setMarkupStatus(rev00, listMarkups(rev00.doc)[2].uid, 'Closed');
const REV00_CLOSED = writeDxf(rev00.doc);
const REV01 = writeDxf(sessionOf(planContent().map((e) => transformEntity(e, MOVE))).doc);
const big = sessionOf(planContent(3000)); // a few thousand entities: the alignment is sliced (progress shown)
addMarkup(big, 'circle', { c: DAMPER, r: 6 }, { ...meta, comment: 'Big damper' });
const BIG00 = writeDxf(big.doc), BIG01 = writeDxf(sessionOf(planContent(3000).map((e) => transformEntity(e, MOVE))).doc);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const file = path.join(ROOT, path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(await fs.readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const problems = [];
let step = 'start';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  // the browser api is frozen: leave it open, so Save can be given a desktop writeFile (the reopen-round step)
  await page.addInitScript(() => { const f = Object.freeze; Object.freeze = (o) => (o && 'saveFile' in o && 'isElectron' in o ? o : f(o)); });
  await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });
  const clickWorld = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]);
    const box = await page.locator('#cv').boundingBox();
    await page.mouse.click(box.x + s.x, box.y + s.y);
  };
  const ok = () => page.locator('#dlg button.primary').click();

  step = 'two markups in Rev.00 with codes B and C';
  await page.evaluate(() => { Object.assign(window.app, { markupAuthor: 'AR', markupAuthorAsked: true }); const vp = window.app.vp; vp.view = { ...vp.view, cx: 0, cy: 0, zoom: 4 }; vp.render(); });
  assert.equal(await page.locator('#mk-round').inputValue(), 'Rev.00', 'no markups: the round is Rev.00');
  for (const [x, c] of [[0, 'Duct size'], [60, 'Damper access']]) {
    await page.click('#tools button[data-tool="mkc"]');
    await clickWorld(x, 0); await clickWorld(x + 10, 0);
    await page.locator('#dlg[open] textarea').fill(c); await ok();
    await page.keyboard.press('Escape');
  }
  assert.equal(await page.locator('#markups .mk-row').count(), 2);
  assert.deepEqual(await page.locator('#markups .mk-rev').allTextContents(), ['Rev.00', 'Rev.00'], 'new markups carry the round');
  await page.locator('#markups .mk-code').nth(0).selectOption('B');
  await page.locator('#markups .mk-code').nth(1).selectOption('C');
  assert.equal(await page.locator('#mk-round').inputValue(), 'Rev.00', 'the default round stays put while markups are added');
  await page.fill('#mk-round', 'Rev.01'); await page.locator('#mk-round').press('Enter');
  assert.deepEqual(await page.evaluate(() => window.api.settingsGet('markup.round')), [], 'an unsaved drawing has no key: round kept for this tab only');

  step = 'follow-ups in Rev.01: code A closes markup 1; markup 2 code B; reopening the dialog edits it';
  await page.locator('#markups .mk-fu-btn').nth(0).click();
  assert.match(await page.locator('#dlg[open]').textContent(), /Duct size[^]*No follow-ups yet[^]*Code A closes the item/);
  await page.fill('#mk-fu-text', 'Addressed in Rev.01');
  await page.selectOption('#mk-fu-code', 'A');
  assert.equal(await page.locator('#mk-fu-status').inputValue(), 'Closed', 'code A preselects Closed');
  await ok();
  assert.equal(await page.locator('#markups .mk-status').nth(0).inputValue(), 'Closed');
  assert.equal(await page.locator('#markups .mk-code').nth(0).inputValue(), 'A');
  assert.equal(await page.locator('#markups .mk-rev').nth(0).textContent(), 'Rev.01');
  await page.locator('#markups .mk-row .mk-text').nth(1).dblclick();
  await page.fill('#mk-fu-text', 'Access panel still missing');
  await page.selectOption('#mk-fu-code', 'B');
  await ok();
  await page.locator('#markups .mk-fu-btn').nth(1).click();
  assert.equal(await page.locator('#mk-fu-text').inputValue(), 'Access panel still missing', 'the round\'s follow-up is edited, not added again');
  await page.fill('#mk-fu-text', 'Access panel still not shown');
  await ok();
  const fus = await page.evaluate(() => window.app.markupPanel && window.app.doc.entities.length && (async () => (await import('../src/core/markup.js')).listMarkups(window.app.doc).map((m) => m.followUps.length))());
  assert.deepEqual(fus, [1, 1]);
  await page.selectOption('#mk-filter', 'Closed');
  assert.equal(await page.locator('#markups .mk-row').count(), 1, 'the filter uses the latest status');
  await page.selectOption('#mk-filter', 'all');

  step = 'CRS export: blue Rev.01 run, code A, Closed, green fill';
  const dl = page.waitForEvent('download');
  await page.click('#mk-crs');
  const xlsx = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'mkrev-')), 'crs.xlsx');
  await (await dl).saveAs(xlsx);
  const py = `
import sys
from openpyxl import load_workbook
ws = load_workbook(sys.argv[1], rich_text=True).active
hdr = [c.value for c in next(r for r in ws.iter_rows() if r[0].value == 'No.')]
rows = [r for r in ws.iter_rows() if r[0].value == 1]
r = rows[0]; get = lambda n: r[hdr.index(n)]
cm = get('Comment').value
blue = [b for b in cm if hasattr(b, 'font') and b.font is not None and b.font.color is not None and str(b.font.color.rgb).endswith('0070C0')]
assert blue and blue[0].text.lstrip('\\n').startswith('Rev.01:'), cm
assert get('Code').value == 'A' and get('Status').value == 'Closed', (get('Code').value, get('Status').value)
assert str(get('Status').fill.fgColor.rgb).endswith('00B050'), get('Status').fill.fgColor.rgb
print('xlsx ok')`;
  assert.match(execFileSync('python3', ['-I', '-c', py, xlsx], { encoding: 'utf8' }), /xlsx ok/);
  await fs.rm(path.dirname(xlsx), { recursive: true });

  // ---- Import… ----
  const openText = (name, text) => page.evaluate(([n, t]) => window.app.loadFile({ path: null, name: n, bytes: new TextEncoder().encode(t) }), [name, text]);
  const toastText = () => page.locator('#toast').textContent();
  /** Import…, choose the file; returns once the import dialog is open (or the toast says why not) */
  const importFile = async (name, text, { dialog = true } = {}) => {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#mk-import')]);
    await fc.setFiles({ name, mimeType: 'application/dxf', buffer: Buffer.from(text) });
    if (dialog) await page.locator('#dlg[open] #mk-imp-align').waitFor({ timeout: 30000 });
  };
  /** each markup with the centre of its shape (circle centre; rectangle: mean of its corners) */
  const centres = () => page.evaluate(async () => {
    const { listMarkups, markupData } = await import('../src/core/markup.js');
    const doc = window.app.doc;
    return listMarkups(doc).map((m) => {
      const e = doc.entities.find((x) => m.ids.includes(x.id) && markupData(x)?.role === 'shape');
      const pts = e.type === 'CIRCLE' ? [e.c] : e.vertices ?? e.pts;
      return { no: m.no, code: m.code, x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
    });
  });
  /** centre of the content circle of radius r in the drawing shown */
  const circleAt = (r) => page.evaluate((rr) => { const c = window.app.doc.entities.find((e) => e.type === 'CIRCLE' && e.layer !== 'ASH-MARKUP' && Math.abs(e.r - rr) < 1e-9); return c && { x: c.c.x, y: c.c.y }; }, r);
  const near = (p, q, what) => assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 1e-6, `${what}: ${JSON.stringify(p)} vs ${JSON.stringify(q)}`);

  step = 'import: Rev.01 is turned 90° and moved; aligned automatically, both markups land on the matching content';
  await openText('Rev01.dxf', REV01);
  assert.equal(await page.locator('#markups .mk-row').count(), 0, 'the panel lists the markups of the tab shown');
  await importFile('Rev00.dxf', REV00);
  assert.equal(await page.locator('#mk-imp-src').textContent(), 'Rev00.dxf: 2 markups found');
  assert.match(await page.locator('#mk-imp-align').textContent(), /^Aligned automatically \(quality \d+ %\)$/);
  await ok();
  assert.match(await toastText(), /^Imported 2 markups; Undo removes them\.$/);
  const got = await centres();
  assert.deepEqual(got.map((m) => [m.no, m.code]), [[1, 'B'], [2, 'C']]);
  near(got[0], await circleAt(2), 'markup 1 circles the damper');
  near(got[1], await circleAt(3), 'markup 2 boxes the grille');
  near(got[0], apply(MOVE, DAMPER), 'markup 1 where the damper moved to');
  assert.equal(await page.locator('#mk-round').inputValue(), 'Rev.01', 'no round set for this drawing: the next after the imported Rev.00');
  assert.equal(await page.evaluate(() => window.app.vp.selection.size) > 0, true, 'the imported markups are selected (zoomed to)');

  step = 'import: Undo removes both in one step';
  await page.evaluate(() => window.app.undo());
  assert.equal(await page.locator('#markups .mk-row').count(), 0);

  step = 'import: Only open brings the B and C markups, not the closed one';
  await importFile('Rev00.dxf', REV00_CLOSED);
  assert.equal(await page.locator('#mk-imp-src').textContent(), 'Rev00.dxf: 3 markups found');
  await page.selectOption('#mk-imp-only', 'open');
  await ok();
  assert.match(await toastText(), /^Imported 2 markups; skipped 1 closed; Undo removes them\.$/);
  assert.deepEqual((await centres()).map((m) => m.code), ['B', 'C']);

  step = 'import: importing again skips the duplicates';
  await importFile('Rev00.dxf', REV00);
  await ok();
  assert.match(await toastText(), /^Imported 0 markups; skipped 2 already here\.$/);
  assert.equal(await page.locator('#markups .mk-row').count(), 2);

  step = 'import: a source without markups says so';
  await importFile('Rev01.dxf', REV01, { dialog: false });
  await page.waitForFunction(() => /No markups in Rev01\.dxf/.test(document.getElementById('toast').textContent));
  assert.equal(await page.locator('#dlg[open]').count(), 0);

  step = 'import: a few-thousand-entity drawing aligns time-sliced (progress shown), then imports';
  await openText('Big01.dxf', BIG01);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#mk-import')]);
  await fc.setFiles({ name: 'Big00.dxf', mimeType: 'application/dxf', buffer: Buffer.from(BIG00) });
  await page.waitForFunction(() => /Aligning… \d+%/.test(document.getElementById('toast').textContent), null, { timeout: 30000 });
  await page.locator('#dlg[open] #mk-imp-align').waitFor({ timeout: 60000 });
  assert.match(await page.locator('#mk-imp-align').textContent(), /^Aligned automatically/);
  await ok();
  near((await centres())[0], apply(MOVE, DAMPER), 'big: the markup lands on the moved damper');

  step = 'import: switching tab during the alignment cancels it and imports nothing';
  const counts = () => page.evaluate(async () => { const { listMarkups } = await import('../src/core/markup.js'); return window.app.tabs.map((t) => listMarkups(t.doc).length); });
  await page.evaluate(() => { window.app.activateIndex(1); window.__held = false; window.__hold = new Promise((r) => { window.__release = r; }); window.app.importHold = () => { window.__held = true; return window.__hold; }; });
  const before = await counts();
  const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#mk-import')]);
  await fc2.setFiles({ name: 'Rev00.dxf', mimeType: 'application/dxf', buffer: Buffer.from(REV00_CLOSED) });
  await page.waitForFunction(() => window.__held, null, { timeout: 30000 });
  await page.evaluate(() => { window.app.activateIndex(0); window.__release(); });
  await page.waitForFunction(() => /Import cancelled: the drawing was switched/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  assert.equal(await page.locator('#dlg[open]').count(), 0, 'no import dialog');
  assert.deepEqual(await counts(), before, 'nothing imported into any tab');
  await page.evaluate(() => { delete window.app.importHold; });

  step = 'round: remembered per drawing once used; after save and reopen it is still Rev.00, so a new markup gets Rev.00';
  await page.evaluate(async () => {
    window.__w = {};
    window.api.writeFile = async (p, b) => { window.__w[p] = b; return { path: p, backup: null }; };
    const M = await import('../src/core/model.js');
    const d = M.newDocument(); d.units = 4; // millimetres: Save asks nothing
    window.app.installDoc(d, { path: '/rev/Plan.dxf', name: 'Plan.dxf', format: 'dxf' });
    const vp = window.app.vp; vp.view = { ...vp.view, cx: 0, cy: 0, zoom: 4 }; vp.render();
  });
  const markupAt = async (x, c) => {
    await page.click('#tools button[data-tool="mkc"]');
    await clickWorld(x, 0); await clickWorld(x + 10, 0);
    await page.locator('#dlg[open] textarea').fill(c); await ok();
    await page.keyboard.press('Escape');
  };
  assert.equal(await page.locator('#mk-round').inputValue(), 'Rev.00');
  await markupAt(0, 'Day 1 comment');
  assert.deepEqual(await page.locator('#markups .mk-rev').allTextContents(), ['Rev.00']);
  await page.evaluate(() => window.app.save());
  assert.deepEqual(await page.evaluate(() => Object.keys(window.__w)), ['/rev/Plan.dxf'], 'saved over its path');
  await page.evaluate(async () => {
    await window.app.closeTab();
    await window.app.loadFile({ path: '/rev/Plan.dxf', name: 'Plan.dxf', bytes: window.__w['/rev/Plan.dxf'] });
    const vp = window.app.vp; vp.view = { ...vp.view, cx: 0, cy: 0, zoom: 4 }; vp.render();
  });
  assert.equal(await page.locator('#markups .mk-row').count(), 1, 'the saved drawing is reopened');
  assert.equal(await page.locator('#mk-round').inputValue(), 'Rev.00', 'the round used on day 1 is kept (not the next one)');
  await markupAt(40, 'Day 2 comment');
  assert.deepEqual(await page.locator('#markups .mk-rev').allTextContents(), ['Rev.00', 'Rev.00'], 'a new markup gets Rev.00');

  step = 'round: Save As over a file that has an older stored round keeps the drawing\'s own round';
  // /rev/Old.dxf was reviewed at Rev.00 (its round is stored); Plan.dxf moves on to Rev.01 and is saved over Old.dxf
  await page.evaluate(async () => {
    const M = await import('../src/core/model.js');
    const d = M.newDocument(); d.units = 4;
    window.app.installDoc(d, { path: '/rev/Old.dxf', name: 'Old.dxf', format: 'dxf' });
    const vp = window.app.vp; vp.view = { ...vp.view, cx: 0, cy: 0, zoom: 4 }; vp.render();
  });
  await markupAt(0, 'Old file comment'); // uses Rev.00: stored for /rev/Old.dxf
  await page.evaluate(() => window.app.save());
  await page.evaluate(async () => {
    await window.app.closeTab();
    await window.app.loadFile({ path: '/rev/Plan.dxf', name: 'Plan.dxf', bytes: window.__w['/rev/Plan.dxf'] });
  });
  await page.locator('#mk-round').fill('Rev.01');
  await page.locator('#mk-round').dispatchEvent('change');
  await page.evaluate(() => document.activeElement?.blur()); // the panel only refreshes the field when it has no focus
  await page.evaluate(async () => {
    window.api.saveFile = async ({ bytes }) => { window.__w['/rev/Old.dxf'] = bytes; return { path: '/rev/Old.dxf', backup: null }; };
    await window.app.saveAs('dxf');
  });
  assert.equal(await page.evaluate(() => window.app.file.path), '/rev/Old.dxf', 'saved as /rev/Old.dxf');
  await page.evaluate(() => window.app.markupPanel.render());
  assert.equal(await page.evaluate(() => window.app.markupPanel.round()), 'Rev.01', 'the drawing keeps Rev.01, not Old.dxf\'s stored Rev.00');
  assert.equal(await page.locator('#mk-round').inputValue(), 'Rev.01', 'the Round field shows Rev.01');

  assert.deepEqual(problems, []);
  console.log('markuprev e2e: OK');
} catch (err) {
  console.error(`markuprev e2e FAILED at "${step}": ${err.stack || err}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally { await browser.close(); server.close(); }
