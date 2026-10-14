#!/usr/bin/env node
// Browser end-to-end test of COPYCLIP / PASTECLIP between two tabs through the system clipboard (DXF text); same harness as run.mjs.
// Uses the browser fallback of window.api (shim.js); Electron-only features (DWG) are covered elsewhere.
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
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  const ready = () => page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });
  await ready();

  const dxf = [
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '1',
    '0', 'LAYER', '2', 'WALLS', '70', '0', '62', '1', '6', 'CONTINUOUS', '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    ...[[0, 0, 10, 0], [10, 0, 10, 10]].flatMap(([a, b, c, d]) => ['0', 'LINE', '8', 'WALLS', '10', a, '20', b, '30', '0', '11', c, '21', d, '31', '0'].map(String)),
    '0', 'CIRCLE', '8', 'WALLS', '10', '5', '20', '5', '30', '0', '40', '2',
    '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
  const chooser = new Promise((r) => page.once('filechooser', r));
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'clipa.dxf', mimeType: 'application/octet-stream', buffer: Buffer.from(dxf) });
  await page.waitForFunction(() => window.app.file.name === 'clipa.dxf' && window.app.doc.entities.length === 3, null, { timeout: 8000 });

  step = 'copy from tab A puts a DXF fragment on the system clipboard';
  await page.locator('#cv').focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await page.waitForFunction(() => navigator.clipboard.readText().then((t) => /^0\s*\r?\nSECTION/.test(t) && t.includes('WALLS')), null, { timeout: 5000 });

  step = 'paste into tab B at a picked point';
  await page.keyboard.press('Control+n');
  await page.waitForFunction(() => window.app.tabs.length === 2 && window.app.doc.entities.length === 0, null, { timeout: 5000 });
  await page.evaluate(() => { window.app.clip = null; }); // the system clipboard must carry it, not the window's copy
  await page.locator('#cv').focus();
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => window.app.toolId === 'pickpoint', null, { timeout: 5000 });
  await page.locator('#cmd').fill('100,50'); await page.locator('#cmd').press('Enter');
  await page.waitForFunction(() => window.app.doc.entities.length === 3, null, { timeout: 5000 });
  const got = await page.evaluate(() => ({ tool: window.app.toolId, layer: !!window.app.doc.layers.get('WALLS'), steps: window.app.session.undoStack.length,
    ents: window.app.doc.entities.map((e) => (e.type === 'LINE' ? [e.type, e.p1.x, e.p1.y, e.p2.x, e.p2.y] : [e.type, e.c.x, e.c.y, e.r])) }));
  assert.equal(got.tool, 'select');
  assert.ok(got.layer, 'layer WALLS came with the fragment');
  assert.equal(got.steps, 1);
  assert.deepEqual(got.ents, [['LINE', 100, 50, 110, 50], ['LINE', 110, 50, 110, 60], ['CIRCLE', 105, 55, 2]]);

  step = 'Ctrl+Z removes everything pasted';
  await page.locator('#cv').focus();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.app.doc.entities.length === 0 && !window.app.doc.layers.get('WALLS'), null, { timeout: 3000 });

  assert.deepEqual(problems, []);
  console.log('clipboard e2e: OK');
} catch (err) {
  console.error(`clipboard e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
