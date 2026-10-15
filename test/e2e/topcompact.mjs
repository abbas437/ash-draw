#!/usr/bin/env node
// Browser end-to-end test: the current tool is marked in the Quick Access row and the Compact rail, and the Compact rail
// works in the Top band (one row, flyouts below it); same harness as run.mjs. Uses the browser fallback of window.api (shim.js).
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
  const pickMode = async (m) => { await page.click('#tools .tp-mode'); await page.click(`.tp-menu [data-mode=${m}]`); };
  const viewItem = async (text) => { await page.locator('#menubar .menu > button', { hasText: 'View' }).click(); await page.locator('#menubar .drop button', { hasText: text }).click(); };
  const rect = (sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().toJSON(), sel);
  const cls = (c) => page.evaluate((k) => document.getElementById('app').classList.contains(k), c);
  const setting = (k) => page.evaluate((key) => window.api.settingsGet(key), k);
  const flyHidden = () => page.evaluate(() => document.querySelector('#tools .rail-fly').hidden);
  /** the marks: the QAT Line button (active class, aria-current) and the rail Draw button (aria-pressed) */
  const marks = () => page.evaluate(() => {
    const q = document.querySelector('#qat button[data-cmd=line]'), r = document.querySelector('#tools .rail-btn.g-draw');
    return { qat: q.classList.contains('active'), qatCur: q.getAttribute('aria-current'), draw: r.getAttribute('aria-pressed'), pressed: [...document.querySelectorAll('#tools .rail-btn[aria-pressed=true]')].map((b) => b.dataset.rail) };
  });
  /** a CSS colour as the browser computes it */
  const computed = (c) => page.evaluate((v) => { const d = document.createElement('div'); d.style.color = v; document.body.append(d); const out = getComputedStyle(d).color; d.remove(); return out; }, c);
  const bgOf = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, sel);

  step = 'Compact rail: Ellipse from the Draw flyout presses the Draw rail button in the accent colours';
  await pickMode('rail');
  await page.click('#tools [data-rail-more=draw]');
  await page.click('#tools .rail-fly button[data-tool=ellipse]');
  assert.equal(await page.evaluate(() => window.app.toolId), 'ellipse');
  let m = await marks();
  assert.equal(m.draw, 'true', 'Draw rail button pressed after Ellipse');
  assert.deepEqual(m.pressed, ['draw'], 'only the Draw group is pressed');
  const want = await computed(await page.evaluate(() => getComputedStyle(document.getElementById('app')).getPropertyValue('--accent2').trim()));
  await page.mouse.move(700, 400);
  assert.equal(await bgOf('#tools .rail-btn.g-draw'), want, 'pressed rail button uses --accent2');
  await page.screenshot({ path: path.join(SCRATCH, 'rail-active.png') });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.app.setTool('select'));

  step = 'typing L marks the QAT Line button and the Draw rail button; Escape back to Select clears both';
  await page.locator('#cmd').fill('L'); await page.locator('#cmd').press('Enter');
  assert.equal(await page.evaluate(() => window.app.toolId), 'line');
  m = await marks();
  assert.ok(m.qat && m.qatCur === 'true', 'QAT Line button active');
  assert.equal(m.draw, 'true', 'Draw rail button pressed after typing L');
  assert.equal(await bgOf('#qat button[data-cmd=line]'), want, 'active QAT button uses --accent2');
  await page.locator('#cmd').press('Escape');
  await page.waitForFunction(() => window.app.toolId === 'select', null, { timeout: 2000 });
  m = await marks();
  assert.ok(!m.qat && m.qatCur === null, 'QAT Line button cleared');
  assert.equal(m.draw, 'false', 'Draw rail button cleared');

  step = 'the QAT Circle button marks itself and the Draw rail button';
  await page.click('#qat button[data-cmd=circle]');
  assert.equal(await page.evaluate(() => window.app.toolId), 'circle');
  assert.ok(await page.evaluate(() => document.querySelector('#qat button[data-cmd=circle]').classList.contains('active')));
  assert.equal((await marks()).draw, 'true');
  await page.keyboard.press('Escape'); await page.evaluate(() => window.app.setTool('select'));

  step = 'View > Tool panel: Top keeps the Compact rail: one row of group buttons, a band at most 48 px tall';
  const cv0 = await rect('#cv');
  await viewItem('Tool panel: Top');
  assert.ok(await cls('tools-top') && await cls('tools-rail'), 'Top + Compact rail');
  assert.equal(await setting('tools.placement'), 'top'); assert.equal(await setting('tools.mode'), 'rail');
  const oneRow = async () => {
    const tops = await page.evaluate(() => [...document.querySelectorAll('#tools .rail-btn')].map((b) => Math.round(b.getBoundingClientRect().top)));
    assert.ok(tops.length >= 6 && tops.every((t) => t === tops[0]), `rail buttons in one row (${tops})`);
    const r = await rect('#tools');
    assert.ok(r.height <= 48, `band height ${r.height}`);
    assert.equal(await page.getAttribute('#tools .rail', 'aria-orientation'), 'horizontal');
    return r;
  };
  let band = await oneRow();
  const cv1 = await rect('#cv');
  assert.ok(cv1.top >= band.bottom - 1 && cv1.left < cv0.left, `the canvas sits below the band at full width (${cv1.top}, ${cv1.left})`);

  step = 'the Draw flyout opens below the band; Circle from it sets the tool and closes it';
  await page.click('#tools [data-rail-more=draw]');
  let fly = await rect('#tools .rail-fly');
  const btn = await rect('#tools [data-rail=draw]');
  assert.ok(fly.top >= band.bottom, `flyout below the band (${fly.top} >= ${band.bottom})`);
  assert.ok(Math.abs(fly.left - btn.left) < 2, 'flyout starts under its button');
  await page.click('#tools .rail-fly button[data-tool=circle]');
  assert.equal(await page.evaluate(() => window.app.toolId), 'circle');
  assert.equal(await flyHidden(), true, 'flyout closed');
  assert.equal((await marks()).draw, 'true', 'Draw pressed in the Top rail');
  await page.keyboard.press('Escape'); await page.evaluate(() => window.app.setTool('select'));

  step = 'Escape and an outside click close a Top flyout';
  await page.click('#tools [data-rail-more=modify]');
  assert.equal(await flyHidden(), false);
  await page.keyboard.press('Escape');
  assert.equal(await flyHidden(), true, 'Escape closes');
  await page.click('#tools [data-rail-more=modify]');
  await page.mouse.click(700, 500);
  assert.equal(await flyHidden(), true, 'outside click closes');

  step = 'Top + Compact survives a reload';
  await page.reload({ waitUntil: 'load' }); await ready();
  await page.waitForFunction(() => { const c = document.getElementById('app').classList; return c.contains('tools-top') && c.contains('tools-rail'); }, null, { timeout: 3000 });
  band = await oneRow();
  await page.evaluate(() => window.app.setTheme('dark', false));
  await page.click('#tools [data-rail-more=draw]');
  fly = await rect('#tools .rail-fly');
  assert.ok(fly.top >= band.bottom, 'flyout below the band after the reload');
  await page.mouse.move(700, 500);
  await page.screenshot({ path: path.join(SCRATCH, 'top-compact.png') });
  await page.keyboard.press('Escape');

  step = 'the other restore order (mode before placement) also gives Top + Compact';
  await page.evaluate(() => { window.app.setToolPlacement('left', false); window.app.toolModes.setMode('full', false); window.app.toolModes.setMode('rail', false); window.app.setToolPlacement('top', false); });
  assert.ok(await cls('tools-top') && await cls('tools-rail'));
  await oneRow();

  step = 'the Symbols dock rules still apply with the Top band';
  await page.evaluate(() => document.getElementById('app').classList.add('sym-dock-left'));
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('main')).gridTemplateAreas), '"tools tools side" "symdock docs side"');
  await page.evaluate(() => document.getElementById('app').classList.remove('sym-dock-left'));

  step = 'Floating and Hidden do not take the Top band';
  await pickMode('float');
  assert.ok(await cls('tools-float') && await cls('tools-left'), 'Floating moves to the left');
  await viewItem('Tool panel: Top');
  assert.ok(await cls('tools-top') && await cls('tools-full'), 'Top from Floating is Full');
  await pickMode('rail');
  assert.ok(await cls('tools-top') && await cls('tools-rail'), 'Compact rail from the Top Full band stays at the top');
  await viewItem('Tool panel: Hidden');
  assert.ok(await cls('tools-hidden') && await cls('tools-full'), 'Hidden is Full');
  await viewItem('Tool panel: Left');

  assert.deepEqual(problems, []);
  console.log('draw topcompact e2e: OK');
} catch (err) {
  console.error(`draw topcompact e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
