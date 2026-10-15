#!/usr/bin/env node
// Browser end-to-end test of the tool panel layouts (Full / Compact rail / Floating); same harness as run.mjs.
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
  await ready();
  const typeCmd = async (text) => { await page.locator('#cmd').fill(text); await page.locator('#cmd').press('Enter'); };
  const pickMode = async (m) => { await page.click('#tools .tp-mode'); await page.click(`.tp-menu [data-mode=${m}]`); };
  const cvWidth = () => page.evaluate(() => window.app.vp.view.width);
  const flyOpen = () => page.evaluate(() => !document.querySelector('#tools .rail-fly').hidden);
  const flyTools = () => page.evaluate(() => [...document.querySelectorAll('#tools .rail-fly button[data-tool]')].filter((b) => b.getClientRects().length).map((b) => b.dataset.tool));
  const ents = () => page.evaluate(() => [...(window.app.doc.entities.values?.() ?? window.app.doc.entities)].map((e) => String(e.type).toUpperCase()));

  const fullIds = await page.evaluate(() => [...document.querySelectorAll('#tools .tgroup button[data-tool]')].map((b) => b.dataset.tool));
  assert.ok(fullIds.length > 40, 'Full panel tools found');
  assert.ok(await page.evaluate(() => document.getElementById('app').classList.contains('tools-full')), 'Full is the default');
  const fullW = await cvWidth();
  const fullToolsW = await page.evaluate(() => document.getElementById('tools').getBoundingClientRect().width);

  step = 'Compact rail from the ⋯ menu: the canvas gets wider';
  await pickMode('rail');
  await page.waitForFunction((w) => window.app.vp.view.width > w, fullW, { timeout: 3000 });
  const railW = await cvWidth();
  const toolsW = await page.evaluate(() => document.getElementById('tools').getBoundingClientRect().width);
  assert.ok(toolsW <= 46, `rail is about 44 px wide (${toolsW})`);

  step = 'open Draw: its tools and the Hatch settings are in the flyout; Line draws a line; the rail button then shows Line';
  await page.click('#tools [data-rail=draw]');
  assert.ok(await flyOpen(), 'flyout open');
  assert.ok((await flyTools()).includes('line'));
  assert.ok(await page.locator('#tools .rail-fly .xbody select[title="Hatch pattern"]').isVisible(), 'hatch pattern reachable');
  await page.screenshot({ path: path.join(SCRATCH, 'toolrail-compact.png') });
  const before = (await ents()).length;
  await page.click('#tools .rail-fly button[data-tool=line]');
  assert.equal(await page.evaluate(() => window.app.toolId), 'line');
  assert.equal(await flyOpen(), false, 'flyout closes after choosing a tool');
  for (const s of ['0,0', '100,50', '']) await typeCmd(s);
  const after = await ents();
  assert.equal(after.length, before + 1, 'one entity added');
  assert.equal(after.at(-1), 'LINE');
  assert.equal(await page.getAttribute('#tools [data-rail=draw]', 'data-rail-tool'), 'line', 'rail button shows Line');
  await page.evaluate(() => window.app.setTool('select'));
  await page.click('#tools [data-rail=draw]');
  assert.equal(await page.evaluate(() => window.app.toolId), 'line', 'one click repeats Line');
  assert.equal(await flyOpen(), false);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.app.setTool('select'));

  step = 'Escape and an outside click close the flyout';
  await page.click('#tools [data-rail-more=draw]');
  assert.ok(await flyOpen());
  await page.keyboard.press('Escape');
  assert.equal(await flyOpen(), false, 'Escape closes');
  await page.click('#tools [data-rail-more=modify]');
  await page.mouse.click(700, 400);
  assert.equal(await flyOpen(), false, 'outside click closes');

  step = 'a pinned flyout stays open after choosing a tool and clicking the drawing';
  await page.click('#tools [data-rail-more=modify]');
  await page.click('#tools .rail-pin');
  assert.equal(await page.getAttribute('#tools .rail-pin', 'aria-pressed'), 'true');
  await page.click('#tools .rail-fly button[data-tool=move]');
  assert.equal(await page.evaluate(() => window.app.toolId), 'move');
  await page.mouse.click(700, 400);
  assert.ok(await flyOpen(), 'pinned flyout stays open');
  await page.click('#tools [data-rail-more=modify]');
  assert.equal(await flyOpen(), false, 'its arrow closes it');
  await page.keyboard.press('Escape'); await page.evaluate(() => window.app.setTool('select'));

  step = 'every Full tool is reachable in the Compact rail; the dimension style list too';
  const reach = new Set();
  for (const key of await page.evaluate(() => [...document.querySelectorAll('#tools [data-rail-more]')].map((b) => b.dataset.railMore))) {
    await page.click(`#tools [data-rail-more="${key}"]`);
    for (const id of await flyTools()) reach.add(id);
    if (key === 'annotate') assert.ok(await page.locator('#tools .rail-fly #dimstyle').isVisible(), 'dimension style list reachable');
    await page.keyboard.press('Escape');
  }
  assert.deepEqual([...reach].sort(), [...fullIds].sort());

  step = 'the mode and the pins persist after a reload';
  await page.reload({ waitUntil: 'load' }); await ready();
  await page.waitForFunction(() => document.getElementById('app').classList.contains('tools-rail'), null, { timeout: 3000 });
  await page.click('#tools [data-rail-more=modify]');
  assert.equal(await page.getAttribute('#tools .rail-pin', 'aria-pressed'), 'true', 'pin remembered');
  await page.click('#tools .rail-pin');
  await page.keyboard.press('Escape');

  step = 'Floating from the View menu: the canvas uses the full width; drag the title strip; the position persists';
  await page.locator('#menubar .menu > button', { hasText: 'View' }).click();
  await page.locator('#menubar .menu.open .sub > button', { hasText: 'Toolbars' }).hover();
  await page.locator('#menubar .drop').getByRole('menuitemcheckbox', { name: 'Tool panel layout: Floating', exact: true }).click(); // not "Floating compact"
  await page.waitForFunction((w) => window.app.vp.view.width > w, railW, { timeout: 3000 });
  const head = await page.locator('#tools .float-head').boundingBox();
  const r0 = await page.evaluate(() => document.getElementById('tools').getBoundingClientRect().toJSON());
  await page.mouse.move(head.x + 20, head.y + 5);
  await page.mouse.down();
  await page.mouse.move(head.x + 200, head.y + 25, { steps: 5 });
  await page.mouse.move(head.x + 320, head.y + 45, { steps: 5 });
  await page.mouse.up();
  const r1 = await page.evaluate(() => document.getElementById('tools').getBoundingClientRect().toJSON());
  assert.equal(Math.round(r1.left - r0.left), 300); assert.equal(Math.round(r1.top - r0.top), 40, 'moved with the pointer');
  await page.screenshot({ path: path.join(SCRATCH, 'toolrail-floating.png') });
  await page.reload({ waitUntil: 'load' }); await ready();
  await page.waitForFunction(() => document.getElementById('app').classList.contains('tools-float'), null, { timeout: 3000 });
  await page.waitForFunction((x) => Math.round(document.getElementById('tools').getBoundingClientRect().left) === x, Math.round(r1.left), { timeout: 3000 });
  assert.equal(Math.round((await page.evaluate(() => document.getElementById('tools').getBoundingClientRect().top))), Math.round(r1.top), 'position kept');

  step = 'a smaller window snaps the floating panel back inside';
  await page.setViewportSize({ width: 500, height: 600 });
  await page.waitForFunction(() => { const r = document.getElementById('tools').getBoundingClientRect(); return r.right <= innerWidth && r.bottom <= innerHeight && r.left >= 0 && r.top >= 0; }, null, { timeout: 3000 });
  await page.setViewportSize({ width: 1400, height: 850 });

  step = 'back to Full: the panel is as before';
  await pickMode('full');
  // the canvas starts after the Full column again and the viewport took its new size (the side panel may have narrowed in the small window)
  await page.waitForFunction((tw) => { const t = document.getElementById('tools').getBoundingClientRect(), c = document.getElementById('cv').getBoundingClientRect(); return t.width === tw && c.left >= t.right && window.app.vp.view.width === Math.round(c.width); }, fullToolsW, { timeout: 3000 });
  assert.equal(await page.evaluate(() => document.getElementById('tools').getBoundingClientRect().width), fullToolsW, 'the Full column is back');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#tools .tgroup button[data-tool]')].map((b) => b.dataset.tool)), fullIds);
  assert.equal(await page.evaluate(() => document.getElementById('tools').style.left), '');

  assert.deepEqual(problems, []);
  console.log('draw toolrail e2e: OK');
} catch (err) {
  console.error(`draw toolrail e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
