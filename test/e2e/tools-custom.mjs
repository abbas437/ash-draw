#!/usr/bin/env node
// Browser end-to-end test of View > Customize tools (hide, move, Quick Access, Compact/Expanded, persist, reset); same harness as run.mjs.
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
  const menuItem = async (item) => { await page.locator('#menubar .menu > button', { hasText: 'View' }).click(); await page.locator('#menubar .drop button', { hasText: item }).click(); };
  const typeCmd = async (text) => { await page.locator('#cmd').fill(text); await page.locator('#cmd').press('Enter'); };
  const panelIds = (g) => page.evaluate((k) => [...document.querySelectorAll(`#tools .gbody[data-body=${k}] button[data-tool]`)].map((b) => b.dataset.tool), g);
  const groupOrder = () => page.evaluate(() => [...document.querySelectorAll('#tools .tgroup[data-group]')].map((g) => g.dataset.group));
  const quickIds = () => page.evaluate(() => [...document.querySelectorAll('#qat button[data-cmd]')].map((b) => b.dataset.cmd));
  const folded = () => page.evaluate(() => [...document.querySelectorAll('#tools .gbody[data-body]')].filter((b) => b.hidden).map((b) => b.dataset.body));
  const defaults = { panel: await page.evaluate(() => [...document.querySelectorAll('#tools button[data-tool]')].map((b) => b.dataset.tool)), groups: await groupOrder(), quick: await quickIds() };

  step = 'right-click a tool: the menu closes on Escape; Hide Trim removes its button, focus moves on, TR still runs Trim';
  {
    await page.click('#tools button[data-tool=trim]', { button: 'right' });
    assert.equal(await page.locator('.tcz-menu').count(), 1, 'context menu open');
    assert.deepEqual(await page.locator('.tcz-menu button').allTextContents(), ['Hide Trim', 'Remove from Quick Access', 'Customize tools…']);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.tcz-menu').count(), 0, 'Escape closes it');
    await page.click('#tools button[data-tool=select]', { button: 'right' });
    assert.equal(await page.locator('.tcz-menu [data-act=hide]').isDisabled(), true, 'Select cannot be hidden');
    await page.setViewportSize({ width: 1390, height: 850 });
    await page.waitForFunction(() => !document.querySelector('.tcz-menu'), null, { timeout: 3000 });
    await page.locator('#tools button[data-tool=trim]').focus(); // (no resize back: a late resize event would close the next menu)
    await page.keyboard.press('Shift+F10'); // keyboard context menu
    await page.waitForFunction(() => document.querySelector('.tcz-menu') && document.activeElement?.dataset.act === 'hide', null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => window.app.vp.settings.polar), false, 'Shift+F10 opens the menu, does not toggle Polar');
    await page.keyboard.press('Enter'); // first item: Hide Trim
    assert.equal(await page.locator('#tools button[data-tool=trim]').count(), 0, 'Trim button gone');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.tool), 'extend', 'focus on the next tool');
    await typeCmd('TR');
    assert.equal(await page.evaluate(() => window.app.toolId), 'trim', 'TR starts Trim');
    await page.evaluate(() => window.app.setTool('select'));
  }

  step = 'Customize tools…: move Measure to Draw, Markup group up, add Offset to Quick Access and remove Undo (keyboard tabs)';
  {
    await menuItem('Customize tools…');
    await page.waitForSelector('#dlg[open] .tcz');
    assert.equal(await page.locator('#dlg [data-key="show:trim"]').isChecked(), false, 'Trim shown unticked');
    assert.equal(await page.locator('#dlg [data-key="show:select"]').isDisabled(), true);
    await page.selectOption('#dlg [data-key="grp:measure"]', 'draw');
    await page.click('#dlg [data-key="gup:markup"]');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.key), 'gup:markup', 'focus kept after a move');
    await page.locator('#dlg [data-key="tab:panel"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#dlg [data-key="tab:quick"]').getAttribute('aria-selected'), 'true', 'arrow key switches tab');
    await page.selectOption('#dlg [data-key=qpick]', 'offset');
    await page.click('#dlg [data-key=qadd]');
    await page.click('#dlg li[data-q=undo] button[data-key^=qdel]');
    await page.click('#dlg .dlg-btns button.primary');
    assert.equal(await page.locator('#dlg[open]').count(), 0);
  }
  const check = async (when) => {
    assert.ok((await panelIds('draw')).at(-1) === 'measure', `${when}: Measure at the end of Draw`);
    assert.deepEqual(await panelIds('inquiry'), ['area'], `${when}: Inquiry keeps Area`);
    const g = await groupOrder();
    assert.ok(g.indexOf('markup') === g.indexOf('inquiry') - 1, `${when}: Markup moved up: ${g}`);
    const q = await quickIds();
    assert.ok(q.includes('offset') && !q.includes('undo'), `${when}: Quick Access ${q}`);
    assert.equal(await page.locator('#tools button[data-tool=trim]').count(), 0, `${when}: Trim hidden`);
  };
  await check('applied');

  step = 'the layout persists after a reload';
  await page.reload({ waitUntil: 'load' }); await ready();
  await page.waitForFunction(() => document.querySelector('#qat button[data-cmd=offset]'), null, { timeout: 5000 });
  await check('after reload');

  step = 'Quick Access right-click: remove and add back; Top band uses the layout';
  {
    await page.click('#qat button[data-cmd=offset]', { button: 'right' });
    await page.click('.tcz-menu [data-act=qremove]');
    assert.ok(!(await quickIds()).includes('offset'));
    await page.click('#tools button[data-tool=offset]', { button: 'right' });
    await page.click('.tcz-menu [data-act=qadd]');
    assert.equal((await quickIds()).at(-1), 'offset');
    await menuItem('Tool panel: Top');
    assert.equal((await panelIds('draw')).at(-1), 'measure', 'Top band: Measure in Draw');
    await menuItem('Tool panel: Left');
  }

  step = 'View > Tools: Compact folds every group but Select; Expanded unfolds all';
  {
    await menuItem('Tools: Compact');
    const all = await groupOrder();
    assert.deepEqual((await folded()).sort(), all.filter((g) => g !== 'select').sort());
    await menuItem('Tools: Expanded');
    assert.deepEqual(await folded(), []);
  }

  step = 'View > Quick Access row hides and shows the row; the canvas area moves up';
  {
    const top = () => page.evaluate(() => document.getElementById('main').getBoundingClientRect().top);
    const t0 = await top();
    await menuItem('Quick Access row');
    assert.equal(await page.locator('#qat').isVisible(), false);
    assert.ok(await top() < t0, 'work area grows');
    await page.reload({ waitUntil: 'load' }); await ready();
    await page.waitForFunction(() => document.getElementById('app').classList.contains('no-qat'), null, { timeout: 5000 });
    await menuItem('Quick Access row');
    assert.equal(await page.locator('#qat').isVisible(), true);
    assert.equal(await top(), t0);
  }

  step = 'Reset to default restores the panel and the Quick Access row';
  {
    await menuItem('Customize tools…');
    await page.click('#dlg [data-key=reset]');
    await page.click('#dlg .dlg-btns button.primary');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#tools button[data-tool]')].map((b) => b.dataset.tool)), defaults.panel);
    assert.deepEqual(await groupOrder(), defaults.groups);
    assert.deepEqual(await quickIds(), defaults.quick);
  }

  assert.deepEqual(problems, []);
  console.log('draw tools-custom e2e: OK');
} catch (err) {
  console.error(`draw tools-custom e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
