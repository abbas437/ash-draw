#!/usr/bin/env node
// Browser end-to-end test of the Distance results panel (cleared when the drawing tab changes or closes); same harness as run.mjs.
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
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  const ready = () => page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });
  await ready();

  const typeCmd = async (text) => { await page.locator('#cmd').fill(text); await page.locator('#cmd').press('Enter'); };
  const panelText = () => page.evaluate(() => document.querySelector('#measure-panel')?.textContent ?? null);
  const install = (name, units) => page.evaluate(async ([n, u]) => {
    const M = await import('/src/core/model.js');
    const doc = M.newDocument();
    doc.units = u;
    M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 100, y: 0 }));
    window.app.installDoc(doc, { path: null, name: n, format: 'dxf' });
  }, [name, units]);
  const click = async (x, y) => {
    const box = await page.locator('#stage canvas').first().boundingBox();
    const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]);
    await page.mouse.click(box.x + s.x, box.y + s.y);
  };

  step = 'measure a distance in drawing 1 (millimetres)';
  await install('mm.dxf', 4);
  await typeCmd('DIST');
  await click(10, 10); await click(60, 10);
  await page.waitForSelector('#measure-panel');
  assert.match(await panelText(), /Distance =/);

  step = 'a drawing in metres replaces it: the old panel is gone';
  await install('m.dxf', 6);
  assert.equal(await panelText(), null);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#measure-panel').length), 0);

  step = 'switching back to drawing 1 does not bring it back (and does not relabel)';
  await page.evaluate(() => window.app.activateIndex(0));
  assert.equal(await panelText(), null);

  step = 'measure again, then close the tab: panel closes';
  await typeCmd('DIST');
  await click(10, 10); await click(60, 10);
  await page.waitForSelector('#measure-panel');
  await page.evaluate(() => window.app.closeTab());
  await page.waitForFunction(() => !document.querySelector('#measure-panel'), null, { timeout: 5000 });

  assert.deepEqual(problems, []);
  console.log('measuretab e2e: OK');
} catch (err) {
  console.error(`measuretab e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
