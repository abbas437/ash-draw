#!/usr/bin/env node
// Browser end-to-end test of Find across spaces: an INSERT attribute (KV-1013) in model space and a paper-space TEXT
// on layout SHEET-01 are both listed with their place; choosing the layout hit shows that layout and selects the text.
// Same harness as measuretab.mjs (browser fallback of window.api).
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(await fs.readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const problems = [];
let step = 'start';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });

  step = 'install a drawing: VALVE INSERT with TAG = KV-1013 in model space, a TEXT on layout SHEET-01';
  const ids = await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const B = await import('/src/core/blocks.js');
    const L = await import('/src/core/layouts.js');
    const doc = M.newDocument();
    M.addBlock(doc, 'VALVE', { x: 0, y: 0 }, [M.makeCircle({ x: 0, y: 0 }, 2), B.makeAttdef({ x: 0, y: 3 }, 1.5, 'TAG', { default: 'KV-0000' })]);
    const ins = M.addEntity(doc, B.instantiate(doc.blocks.get('VALVE'), { x: 50, y: 50 }, { values: { TAG: 'KV-1013' } }));
    M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 100, y: 100 }));
    const lo = L.newLayout('SHEET-01', 1);
    const t = M.makeText({ x: 100, y: 100 }, 5, 'SEE KV-1013 DETAIL'); t.id = doc.nextId++; lo.entities.push(t);
    doc.layouts = [lo];
    window.app.installDoc(doc, { path: null, name: 'pid.dxf', format: 'dxf' });
    return { ins: ins.id, text: t.id };
  });
  await page.locator('#cv').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+f');
  await page.waitForSelector('#find-panel:not([hidden])');
  await page.locator('#find-q').fill('KV-1013');

  step = 'both hits are listed with their place';
  const rows = page.locator('#find-panel .find-row');
  assert.equal(await rows.count(), 2);
  assert.match(await page.locator('#find-panel .find-count').innerText(), /2 matches/);
  assert.match(await rows.nth(0).innerText(), /Model · attribute TAG of block VALVE/);
  assert.match(await rows.nth(1).innerText(), /Layout SHEET-01/);

  step = 'choosing the layout hit shows SHEET-01 and selects the text';
  await rows.nth(1).click();
  await page.waitForFunction(() => window.app.active.spaces?.cur === 'SHEET-01', null, { timeout: 5000 });
  assert.equal(await page.locator('[data-space="SHEET-01"]').getAttribute('aria-selected'), 'true');
  assert.deepEqual(await page.evaluate(() => [...window.app.vp.selection]), [ids.text]);

  step = 'choosing the attribute hit goes back to Model and selects the INSERT';
  await rows.nth(0).click();
  await page.waitForFunction(() => window.app.active.spaces?.cur === 'Model', null, { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => [...window.app.vp.selection]), [ids.ins]);
  const zoomedIn = await page.evaluate(() => { const s = window.app.vp.toScreen({ x: 50, y: 50 }); return s.x > 0 && s.y > 0 && s.x < 1400 && s.y < 850; });
  assert.ok(zoomedIn, 'the INSERT is in view');

  step = 'Replace all changes the attribute and the paper-space text, one undo step';
  await page.locator('#find-r').fill('XV-2020');
  await page.locator('#find-all').click();
  assert.equal(await rows.count(), 0, 'results refresh after Replace all');
  const after = await page.evaluate(() => { const d = window.app.active.doc; return [d.entities[0].attribs[0].text, d.layouts[0].entities.at(-1).text]; });
  assert.deepEqual(after, ['XV-2020', 'SEE XV-2020 DETAIL']);
  await page.evaluate(() => window.app.session.undo());
  const undone = await page.evaluate(() => { const d = window.app.active.doc; return [d.entities[0].attribs[0].text, d.layouts[0].entities.at(-1).text]; });
  assert.deepEqual(undone, ['KV-1013', 'SEE KV-1013 DETAIL']);

  assert.deepEqual(problems, []);
  console.log('findspaces e2e: OK');
} catch (err) {
  console.error(`findspaces e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
