#!/usr/bin/env node
// Browser end-to-end test of the block editor (BEDIT, BSAVE, BCLOSE); same harness as run.mjs.
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
  const ents = () => page.evaluate(() => JSON.parse(JSON.stringify([...window.app.doc.entities.values?.() ?? window.app.doc.entities])));
  const toolId = () => page.evaluate(() => window.app.toolId);
  const editing = () => page.evaluate(() => !document.getElementById('beditbar').hidden);
  const defLen = () => page.evaluate(() => window.app.fileDoc.blocks.get('BOX').entities.length);
  // a world point under the cursor picks the block reference whose drawn content passes there
  const pickAt = (x, y) => page.evaluate(([x, y]) => window.app.vp.pick({ x, y })?.id ?? null, [x, y]);
  const dialogButton = (label) => page.locator('#dlg button', { hasText: label }).click();

  step = 'make block BOX and insert it twice';
  const [a, b] = await page.evaluate(async () => {
    const { makeLine } = await import('/src/core/model.js');
    const { instantiate } = await import('/src/core/blocks.js');
    const app = window.app;
    return app.session.transact('setup', (tx) => {
      const blk = { name: 'BOX', base: { x: 0, y: 0 }, entities: [makeLine({ x: 0, y: 0 }, { x: 10, y: 0 })] };
      tx.block('BOX', blk);
      return [tx.add(instantiate(blk, { x: 100, y: 0 })).id, tx.add(instantiate(blk, { x: 200, y: 50 })).id];
    });
  });
  await page.evaluate(() => window.app.vp.zoomBox?.({ minX: 90, minY: -10, maxX: 220, maxY: 80 }, 0) ?? window.app.vp.zoomExtents());
  assert.equal(await pickAt(105, 20), null);
  const steps0 = await page.evaluate(() => window.app.session.undoStack.length);

  step = 'BEDIT: list dialog, OK opens the editor';
  await typeCmd('BEDIT');
  await page.locator('#dlg select').selectOption('BOX');
  await dialogButton('OK');
  assert.equal(await editing(), true);
  assert.equal(await page.locator('#spacebar').isHidden(), true, 'Model / layout tabs hidden');
  assert.match(await page.locator('#beditbar').innerText(), /Block editor: BOX/);

  step = 'draw a line inside, undo / redo in the editor, BSAVE, BCLOSE';
  for (const s of ['L', '0,20', '10,20', '']) await typeCmd(s);
  assert.equal(await page.evaluate(() => window.app.doc.entities.length), 2);
  await typeCmd('U');
  assert.equal(await page.evaluate(() => window.app.doc.entities.length), 1);
  await typeCmd('REDO');
  assert.equal(await defLen(), 1, 'the drawing is untouched until BSAVE');
  await typeCmd('BSAVE');
  assert.equal(await defLen(), 2);
  await typeCmd('BCLOSE');
  assert.equal(await editing(), false);
  assert.equal(await page.locator('#spacebar').isHidden(), false);
  assert.equal(await page.evaluate(() => window.app.session.undoStack.length), steps0 + 1, 'one undo step');
  assert.equal(await pickAt(105, 20), a, 'first insert shows the new line');
  assert.equal(await pickAt(205, 70), b, 'second insert shows the new line');

  step = 'undo restores the old definition';
  await typeCmd('U');
  assert.equal(await defLen(), 1);
  assert.equal(await pickAt(105, 20), null);

  step = 'BEDIT, change, BCLOSE, Discard: nothing changes';
  const before = await page.evaluate(() => JSON.stringify(window.app.fileDoc.blocks.get('BOX')));
  await typeCmd('BE');
  await dialogButton('OK');
  for (const s of ['L', '0,30', '10,30', '']) await typeCmd(s);
  await typeCmd('BCLOSE');
  await page.locator('#dlg', { hasText: 'Save changes to BOX?' }).waitFor();
  await dialogButton('Discard');
  assert.equal(await editing(), false);
  assert.equal(await page.evaluate(() => JSON.stringify(window.app.fileDoc.blocks.get('BOX'))), before);
  assert.equal(await page.evaluate(() => window.app.session.undoStack.length), steps0);

  step = 'Esc in the name prompt';
  await typeCmd('BEDIT');
  await page.locator('#dlg select').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await editing(), false);
  assert.equal(await toolId(), 'select');

  step = 'right-click a selected reference: Edit block';
  await page.evaluate((i) => window.app.vp.setSelection([i]), a);
  await page.evaluate(() => window.app.tools.select.rightClick({ x: 0, y: 0 }, { clientX: 300, clientY: 300 }));
  await page.locator('.popmenu', { hasText: 'Edit block' }).getByText('Edit block').click();
  assert.equal(await editing(), true);
  await typeCmd('BCLOSE');
  assert.equal(await editing(), false);

  assert.deepEqual(problems, []);
  console.log('bedit e2e: OK');
} catch (err) {
  console.error(`bedit e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
