#!/usr/bin/env node
// Browser e2e of review rounds: Round field, new markups get the round, Follow-up… dialog (code A closes), Rev.xx tag,
// and the CRS export with the blue Rev.01 line (checked with python openpyxl).
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

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
  assert.deepEqual(problems, []);
  console.log('markuprev e2e: OK');
} catch (err) {
  console.error(`markuprev e2e FAILED at "${step}": ${err.stack || err}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally { await browser.close(); server.close(); }
