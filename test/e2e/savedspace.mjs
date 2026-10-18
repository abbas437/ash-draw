#!/usr/bin/env node
// Browser end-to-end test: a drawing opens in the space it was saved in ($TILEMODE 0: its active layout tab, 1: Model),
// and a save writes the space shown (Save from a layout: $TILEMODE 0 with that layout as *Paper_Space); harness as layoutmgmt.mjs.
// Uses the browser fallback of window.api (shim.js): Save downloads the DXF.
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });

  const shown = () => page.evaluate(() => ({ tab: document.querySelector('#spacebar button.active')?.dataset.space, layout: window.app.vp.layout?.name ?? null,
    view: { cx: window.app.vp.view.cx, cy: window.app.vp.view.cy, zoom: window.app.vp.view.zoom } }));
  // the layouts fixture written with Layout2 as the active layout and the given $TILEMODE, opened like a file from disk
  const openAs = (name, tilemode) => page.evaluate(async ([name, tilemode]) => {
    const { readDxf } = await import('/src/core/dxfRead.js');
    const { writeDxf } = await import('/src/core/dxfWrite.js');
    const doc = readDxf(new Uint8Array(await (await fetch('/test/fixtures/layouts_r2000.dxf')).arrayBuffer()));
    doc.header.activeLayout = 'Layout2'; doc.header.tilemode = tilemode;
    await window.app.loadFile({ path: null, name, bytes: new TextEncoder().encode(writeDxf(doc)) });
  }, [name, tilemode]);
  const saved = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.evaluate(() => window.app.save())]);
    const text = await fs.readFile(await dl.path(), 'latin1');
    return page.evaluate(async (t) => {
      const { parseDxf } = await import('/src/core/dxfRead.js');
      const d = parseDxf(t);
      return { tilemode: d.header.tilemode, active: d.header.activeLayout, names: d.layouts.map((l) => l.name) };
    }, text);
  };

  step = 'a $TILEMODE 1 drawing opens on Model';
  await openAs('tm1.dxf', 1);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#spacebar button')].map((b) => b.dataset.space)), ['Model', 'Layout1', 'Layout2']);
  assert.equal((await shown()).tab, 'Model'); assert.equal((await shown()).layout, null);
  await page.click('#spacebar button[data-space="Layout2"]');
  const clicked = await shown();
  assert.equal(clicked.layout, 'Layout2');

  step = 'a $TILEMODE 0 drawing opens on its active layout, fitted as a click on the tab fits it';
  await openAs('tm0.dxf', 0);
  const opened = await shown();
  assert.equal(opened.tab, 'Layout2'); assert.equal(opened.layout, 'Layout2');
  assert.deepEqual(opened.view, clicked.view, 'same fit as clicking the tab');
  // the model scene prepared while opening is the one the viewports draw through and the one Model shows again (no rebuild)
  assert.ok(await page.evaluate(() => !!(window.__ms = window.app.active.spaces.scenes.get(''))), 'viewports draw through the prepared model scene');
  await page.click('#spacebar button[data-space="Model"]');
  assert.equal((await shown()).layout, null, 'the Model tab stays available');
  assert.ok(await page.evaluate(() => window.app.vp.scene === window.__ms), 'back on Model: the same scene, not rebuilt');

  step = 'only on open: switching between open drawings keeps the space each shows';
  await page.evaluate(() => window.app.activateIndex(window.app.tabs.findIndex((t) => t.file.name === 'tm1.dxf')));
  assert.equal((await shown()).layout, 'Layout2');
  await page.evaluate(() => window.app.activateIndex(window.app.tabs.findIndex((t) => t.file.name === 'tm0.dxf')));
  assert.equal((await shown()).layout, null, 'tm0.dxf was left on Model');

  step = 'save from Model: $TILEMODE 1, the file\'s active layout kept';
  assert.deepEqual(await saved(), { tilemode: 1, active: 'Layout2', names: ['Layout1', 'Layout2'] });

  step = 'save from a layout: $TILEMODE 0 with that layout as *Paper_Space; tab order kept';
  await page.click('#spacebar button[data-space="Layout1"]');
  assert.deepEqual(await saved(), { tilemode: 0, active: 'Layout1', names: ['Layout1', 'Layout2'] });

  assert.deepEqual(problems, []);
  console.log('savedspace e2e: OK');
} catch (err) {
  console.error(`savedspace e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
