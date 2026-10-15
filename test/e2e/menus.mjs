#!/usr/bin/env node
// Browser end-to-end test of View > Toolbars / Panels submenus and the toolbar right-click menu; same harness as toolrail.mjs.
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


const SCRATCH = path.join(ROOT, '.scratch');
await fs.mkdir(SCRATCH, { recursive: true });
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
  const ready = () => page.waitForFunction(() => window.app && window.app.vp && window.app.doc && window.app.toolModes, null, { timeout: 10000 });
  const view = () => page.locator('#menubar .menu > button', { hasText: /^View$/ });
  const subBtn = (name) => page.locator('#menubar .menu.open .sub > button', { hasText: name });
  const viewItem = (text) => page.locator('#menubar .menu.open .drop button', { hasText: text });
  const openSubs = () => page.evaluate(() => [...document.querySelectorAll('.sub.open > button')].map((b) => b.textContent));
  const layout = () => page.evaluate(() => window.app.toolModes.layout);
  const active = () => page.evaluate(() => document.activeElement?.textContent ?? '');
  const ctxTexts = () => page.locator('.tcz-menu button').allTextContents();
  const TB_ITEMS = ['Tool panel: Left', 'Tool panel: Right', 'Tool panel: Top', 'Tool panel: Hidden', 'Tool panel layout: Full', 'Tool panel layout: Compact rail', 'Tool panel layout: Floating', 'Tool panel layout: Floating compact', 'Tool labels', 'Tool group colours', 'Tools: Compact', 'Tools: Expanded', 'Quick Access row', 'Customize tools…'];
  const hasToolbarItems = (texts, what) => { for (const t of TB_ITEMS) assert.ok(texts.some((x) => x.replace(/^✓/, '') === t), `${what}: "${t}" in ${JSON.stringify(texts)}`); };

  step = 'View has the Toolbars and Panels submenus, closed';
  await view().click();
  for (const name of ['Toolbars', 'Panels']) {
    assert.equal(await subBtn(name).count(), 1, `${name} submenu`);
    assert.equal(await subBtn(name).getAttribute('aria-haspopup'), 'menu');
    assert.equal(await subBtn(name).getAttribute('aria-expanded'), 'false');
  }
  assert.equal(await viewItem('Tool panel layout: Compact rail').isVisible(), false, 'Toolbars items hidden until it opens');

  step = 'hover Toolbars: its items show; Compact rail there changes the layout and closes everything';
  await subBtn('Toolbars').hover();
  await viewItem('Tool panel layout: Compact rail').waitFor({ state: 'visible', timeout: 3000 });
  assert.equal(await subBtn('Toolbars').getAttribute('aria-expanded'), 'true');
  hasToolbarItems(await page.locator('#menubar .menu.open .sub.open > .drop button').allTextContents(), 'View > Toolbars');
  assert.equal(await viewItem('Tool panel layout: Full').getAttribute('aria-checked'), 'true', 'Full ticked');
  await viewItem('Tool panel layout: Compact rail').click();
  assert.equal(await layout(), 'rail', 'Compact rail applied');
  assert.equal(await page.locator('#menubar .menu.open').count(), 0, 'menu closed');
  assert.deepEqual(await openSubs(), [], 'submenu closed with it');
  await view().click(); await subBtn('Toolbars').hover();
  await viewItem('Tool panel layout: Compact rail').waitFor({ state: 'visible', timeout: 3000 });
  assert.equal(await viewItem('Tool panel layout: Compact rail').getAttribute('aria-checked'), 'true', 'tick refreshed when the submenu opened again');
  await page.keyboard.press('Escape');

  step = 'Panels holds the side panel, Symbols panel and Command history items; Escape closes the menu and its submenu';
  await page.evaluate(() => window.app.toolModes.setLayout('full'));
  await view().click(); await subBtn('Panels').hover();
  await viewItem('Side panel: Expanded').waitFor({ state: 'visible', timeout: 3000 });
  const pnTexts = (await page.locator('#menubar .menu.open .sub.open > .drop button').allTextContents()).map((t) => t.replace(/^✓/, ''));
  for (const t of ['Side panel: Expanded', 'Side panel: Collapsed', 'Side panel: Hidden', 'Command history', 'Symbols panel: ']) assert.ok(pnTexts.some((x) => x.startsWith(t)), `Panels: ${t} in ${pnTexts}`);
  assert.deepEqual(await openSubs(), ['Panels▸'], 'only Panels open');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#menubar .menu.open').count(), 0, 'Escape closed View');
  assert.deepEqual(await openSubs(), [], 'and Panels');

  step = 'keyboard: Enter on View, ArrowDown to Toolbars, ArrowRight opens it, ArrowLeft and Escape close it';
  await view().focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#menubar .menu.open').count(), 1, 'Enter opens View');
  for (let i = 0; i < 30 && !(await active()).startsWith('Toolbars'); i++) await page.keyboard.press('ArrowDown');
  assert.ok((await active()).startsWith('Toolbars'), 'ArrowDown reached Toolbars');
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await openSubs(), ['Toolbars▸'], 'ArrowRight opened Toolbars');
  assert.ok((await active()).includes('Tool panel: Left'), `focus on its first item (${await active()})`);
  await page.keyboard.press('ArrowDown');
  assert.ok((await active()).includes('Tool panel: Right'), 'ArrowDown inside the submenu');
  await page.keyboard.press('ArrowLeft');
  assert.deepEqual(await openSubs(), [], 'ArrowLeft closed it');
  assert.ok((await active()).startsWith('Toolbars'), 'focus back on Toolbars');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  assert.deepEqual(await openSubs(), [], 'Escape closed the submenu');
  assert.equal(await page.locator('#menubar .menu.open').count(), 1, 'View still open');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#menubar .menu.open').count(), 0, 'second Escape closed View');
  assert.equal(await active(), 'View', 'focus back on View');

  step = 'screenshot: View > Toolbars, dark theme';
  await page.evaluate(() => window.app.setTheme('dark'));
  await view().click(); await subBtn('Toolbars').hover();
  await viewItem('Tool panel layout: Compact rail').waitFor({ state: 'visible', timeout: 3000 });
  await page.screenshot({ path: path.join(SCRATCH, 'menu-toolbars.png') });
  await page.keyboard.press('Escape');

  step = 'right-click on the Quick Access row: the Toolbars menu at the pointer; Floating compact applies';
  const pt = await page.evaluate(() => { const r = document.getElementById('qat').getBoundingClientRect(); return { x: r.right - 4, y: r.top + r.height / 2 }; });
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, pt), 'qat', 'an empty spot of the row');
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  assert.equal(await page.locator('.tcz-menu').count(), 1, 'menu open');
  hasToolbarItems(await ctxTexts(), 'Quick Access right-click');
  const at = await page.evaluate(() => document.querySelector('.tcz-menu').getBoundingClientRect().toJSON());
  assert.ok(Math.abs(at.top - pt.y) < 2, `at the pointer (${at.top} vs ${pt.y})`);
  await page.screenshot({ path: path.join(SCRATCH, 'toolbar-ctx.png') });
  await page.locator('.tcz-menu button', { hasText: 'Tool panel layout: Floating compact' }).click();
  assert.equal(await layout(), 'float-rail', 'Floating compact applied');
  assert.equal(await page.locator('.tcz-menu').count(), 0, 'menu closed');

  step = 'right-click on the floating compact strip opens it too, ticked; Escape closes it';
  await page.click('#tools .rail [data-rail=draw]', { button: 'right' });
  assert.equal(await page.locator('.tcz-menu').count(), 1);
  assert.equal(await page.locator('.tcz-menu button', { hasText: 'Tool panel layout: Floating compact' }).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.tcz-menu').count(), 0, 'Escape closes it');

  step = 'right-click on #tools in the Full layout: a tool, then the panel background; an outside click closes it';
  await page.evaluate(() => window.app.toolModes.setLayout('full'));
  await page.click('#tools button[data-tool=line]', { button: 'right' });
  const lineTexts = await ctxTexts();
  assert.equal(lineTexts[0], 'Hide Line', 'the tool\'s own items first');
  hasToolbarItems(lineTexts, 'tool right-click');
  await page.keyboard.press('Escape');
  await page.click('#tools .lbl-toggle', { button: 'right' });
  hasToolbarItems(await ctxTexts(), 'panel right-click');
  assert.equal(await page.locator('.tcz-menu [data-act]').count(), 0, 'no tool items off a tool');
  await page.mouse.click(700, 400);
  assert.equal(await page.locator('.tcz-menu').count(), 0, 'outside click closes it');

  step = 'right-click on the canvas opens no toolbar menu; on the status-bar SNAP it still opens drafting settings';
  await page.click('#cv', { button: 'right', position: { x: 300, y: 300 } });
  assert.equal(await page.locator('.tcz-menu').count(), 0, 'no toolbar menu on the canvas');
  await page.keyboard.press('Escape');
  await page.click('#status button[data-key=snap]', { button: 'right' });
  await page.waitForSelector('#dlg[open] #osnap-on', { timeout: 3000 });
  assert.equal(await page.locator('.tcz-menu').count(), 0, 'no toolbar menu on SNAP');
  await page.keyboard.press('Escape');

  step = 'a pointer-opened menu leaves the command line its keys (ArrowUp, Escape, Enter)';
  await page.locator('#cmd').fill('LINE');
  await page.locator('#cmd').focus();
  await view().dispatchEvent('pointerdown', { button: 0 });
  assert.equal(await page.locator('#menubar .menu.open').count(), 1, 'View opened by the pointer');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'cmd', 'focus stays in the command line');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#menubar .menu.open').count(), 0, 'Escape closes the menu');
  // (Escape then goes on to the app as usual: it leaves the command line for the canvas)
  await view().dispatchEvent('pointerdown', { button: 0 });
  await page.locator('#cmd').fill('LINE'); await page.locator('#cmd').press('Enter');
  assert.equal(await page.evaluate(() => window.app.toolId), 'line', 'Enter runs the command, not the menu');
  await page.keyboard.press('Escape');

  step = 'a hover timer pending when the menu closes does not reopen the submenu';
  await view().click();
  await subBtn('Toolbars').hover();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.mouse.move(700, 500);
  await page.waitForTimeout(350);
  assert.equal(await page.locator('.sub.open').count(), 0, 'no submenu left open');

  step = 'a submenu that does not fit keeps inside the window on every open';
  await page.setViewportSize({ width: 1000, height: 520 });
  for (let k = 0; k < 3; k++) {
    await view().click();
    await subBtn('Toolbars').click();
    const b = await page.evaluate(() => { const d = document.querySelector('#menubar .sub.open > .drop').getBoundingClientRect(); return { top: d.top, bottom: d.bottom }; });
    assert.ok(b.bottom <= 520 - 3 && b.top >= 0, `open ${k + 1}: ${JSON.stringify(b)}`);
    await page.mouse.click(700, 400); // close
  }
  await page.setViewportSize({ width: 1400, height: 850 });

  assert.deepEqual(problems, []);
  console.log('draw menus e2e: OK');
} catch (err) {
  console.error(`draw menus e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
