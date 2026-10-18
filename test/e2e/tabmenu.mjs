#!/usr/bin/env node
// Browser end-to-end test of the right-click close menu on the document tabs; same harness as run.mjs.
// Uses the browser fallback of window.api (shim.js).
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
  let body;
  try { body = await fs.readFile(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
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

  // a fresh app with `n` drawings T1..Tn open; those listed in `dirty` (1-based) have an unsaved edit
  const reset = async (n, dirty = []) => {
    await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });
    await page.evaluate(async ([n, dirty]) => {
      const M = await import('/src/core/model.js');
      const a = window.app;
      for (let i = 1; i <= n; i++) {
        const doc = M.newDocument();
        M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 100, y: 0 }));
        a.installDoc(doc, { path: null, name: `T${i}.dxf`, format: 'dxf' }, { replaceBlank: true });
      }
      for (const i of dirty) a.tabs[i - 1].session.transact('line', (tx) => tx.add(M.makeLine({ x: 0, y: 0 }, { x: 5, y: 5 })));
      a.updateTitle();
    }, [n, dirty]);
  };
  const names = () => page.evaluate(() => window.app.tabs.map((t) => t.file.name));
  const tab = (i) => page.locator('#tabbar .tab').nth(i - 1);
  const openMenu = async (i) => { await tab(i).click({ button: 'right' }); await page.waitForSelector('.tab-menu'); };
  const act = () => page.evaluate(() => document.activeElement.dataset.act);
  const state = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.tab-menu button')].map((b) => [b.dataset.act, !b.disabled])));

  step = 'items: first tab, last tab, single tab';
  await reset(3);
  assert.deepEqual(await names(), ['T1.dxf', 'T2.dxf', 'T3.dxf']);
  await openMenu(1);
  assert.deepEqual(await state(), { this: true, others: true, left: false, right: true, all: true });
  assert.equal(await page.locator('.tab-menu button[data-act=this] kbd').textContent(), 'Ctrl+W');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.tab-menu').count(), 0);
  await openMenu(3);
  assert.deepEqual(await state(), { this: true, others: true, left: true, right: false, all: true });
  await page.keyboard.press('Escape');
  await reset(1);
  await openMenu(1);
  assert.deepEqual(await state(), { this: true, others: false, left: false, right: false, all: true });
  await page.keyboard.press('Escape');

  step = 'keyboard: Shift+F10 opens, arrows skip disabled items, Escape returns focus to the tab';
  await reset(3);
  await tab(1).focus();
  await page.keyboard.press('Shift+F10');
  await page.waitForSelector('.tab-menu');
  assert.equal(await act(), 'this');
  await page.keyboard.press('ArrowDown');
  assert.equal(await act(), 'others');
  await page.keyboard.press('ArrowDown');
  assert.equal(await act(), 'right'); // 'left' is disabled on the first tab
  await page.keyboard.press('End');
  assert.equal(await act(), 'all');
  await page.keyboard.press('Home');
  assert.equal(await act(), 'this');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.tab-menu').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('tab')), true);

  step = 'click outside closes the menu';
  await openMenu(2);
  await page.mouse.click(700, 500);
  assert.equal(await page.locator('.tab-menu').count(), 0);

  step = 'Close';
  await reset(3); await openMenu(2); await page.click('.tab-menu [data-act=this]');
  await page.waitForFunction(() => window.app.tabs.length === 2);
  assert.deepEqual(await names(), ['T1.dxf', 'T3.dxf']);
  step = 'Close other tabs';
  await reset(4); await openMenu(2); await page.click('.tab-menu [data-act=others]');
  await page.waitForFunction(() => window.app.tabs.length === 1);
  assert.deepEqual(await names(), ['T2.dxf']);
  step = 'Close tabs to the left';
  await reset(4); await openMenu(3); await page.click('.tab-menu [data-act=left]');
  await page.waitForFunction(() => window.app.tabs.length === 2);
  assert.deepEqual(await names(), ['T3.dxf', 'T4.dxf']);
  step = 'Close tabs to the right';
  await reset(4); await openMenu(2); await page.click('.tab-menu [data-act=right]');
  await page.waitForFunction(() => window.app.tabs.length === 2);
  assert.deepEqual(await names(), ['T1.dxf', 'T2.dxf']);
  step = 'Close all tabs leaves one new blank drawing';
  await reset(3); await openMenu(2); await page.click('.tab-menu [data-act=all]');
  await page.waitForFunction(() => window.app.tabs.length === 1 && !window.app.tabs[0].file.name.startsWith('T'));
  assert.equal(await page.locator('.tab-menu').count(), 0);

  step = 'an unsaved drawing asks; Cancel stops the rest';
  await reset(4, [2]);
  await openMenu(4); await page.click('.tab-menu [data-act=others]');
  await page.waitForSelector('#dlg[open]');
  assert.match(await page.locator('#dlg').textContent(), /Save changes to T2\.dxf/);
  await page.locator('#dlg button', { hasText: 'Cancel' }).click();
  await page.waitForFunction(() => !document.querySelector('#dlg[open]'));
  assert.deepEqual(await names(), ['T2.dxf', 'T3.dxf', 'T4.dxf']); // T1 closed before the prompt; T3 was never reached

  step = "Don't save discards the drawing and closes everything";
  await openMenu(1); await page.click('.tab-menu [data-act=all]');
  await page.waitForSelector('#dlg[open]');
  await page.locator('#dlg button', { hasText: "Don't save" }).click();
  await page.waitForFunction(() => window.app.tabs.length === 1 && window.app.tabs[0].file.name.startsWith('Untitled'));

  assert.deepEqual(problems, []);
  console.log('TABMENU OK');
} catch (err) {
  console.error(`TABMENU FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
