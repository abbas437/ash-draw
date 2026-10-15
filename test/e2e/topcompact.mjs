#!/usr/bin/env node
// Browser end-to-end test: the current tool is marked in the Quick Access row and the Compact rail, and the Compact rail
// works at the top inside the Quick Access row (#qat: one row after "Symbols ▾", flyouts below the row, no band); same harness as run.mjs. Uses the browser fallback of window.api (shim.js).
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
  const pickMode = async (m) => { await page.click('.tp-mode'); await page.click(`.tp-menu [data-mode=${m}]`); };
  const viewItem = async (text) => { await page.locator('#menubar .menu > button', { hasText: 'View' }).click(); await page.locator('#menubar .menu.open .sub > button', { hasText: 'Toolbars' }).hover(); await page.locator('#menubar .drop button', { hasText: text }).click(); };
  const rect = (sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().toJSON(), sel);
  const cls = (c) => page.evaluate((k) => document.getElementById('app').classList.contains(k), c);
  const setting = (k) => page.evaluate((key) => window.api.settingsGet(key), k);
  const flyHidden = () => page.evaluate(() => document.querySelector('#tools .rail-fly').hidden);
  /** the marks: the QAT Line button (active class, aria-current) and the rail Draw button (aria-pressed) */
  const marks = () => page.evaluate(() => {
    const q = document.querySelector('#qat button[data-cmd=line]'), r = document.querySelector('.rail .rail-btn.g-draw');
    return { qat: q.classList.contains('active'), qatCur: q.getAttribute('aria-current'), draw: r.getAttribute('aria-pressed'), pressed: [...document.querySelectorAll('.rail .rail-btn[aria-pressed=true]')].map((b) => b.dataset.rail) };
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

  step = 'View > Tool panel: Top keeps the Compact rail: its group buttons move into the Quick Access row after Symbols, #tools takes no height';
  await viewItem('Tool panel: Top');
  assert.ok(await cls('tools-top') && await cls('tools-rail'), 'Top + Compact rail');
  assert.equal(await setting('tools.placement'), 'top'); assert.equal(await setting('tools.mode'), 'rail');
  /** the rail sits in #qat after #sym-combo, in one row; #tools is 0 px tall; the canvas starts right under the row (and the tab bar) */
  const inQat = async () => {
    const r = await page.evaluate(() => {
      const rail = document.querySelector('.rail'), sym = document.getElementById('sym-combo');
      return { inQat: !!rail.closest('#qat'), after: !!(sym.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING),
        n: document.querySelectorAll('#qat .rail-btn').length, more: !!document.querySelector('#qat .tp-mode'),
        tops: [...document.querySelectorAll('#qat .rail-btn')].filter((b) => b.getClientRects().length).map((b) => Math.round(b.getBoundingClientRect().top)) };
    });
    assert.ok(r.inQat && r.after && r.more, `rail and ⋯ in #qat after #sym-combo (${JSON.stringify(r)})`);
    assert.ok(r.n >= 6 && r.tops.length && r.tops.every((t) => t === r.tops[0]), `rail buttons in one row (${r.tops})`);
    assert.equal(await page.getAttribute('.rail', 'aria-orientation'), 'horizontal');
    assert.equal((await rect('#tools')).height, 0, '#tools has no height');
    const q = await rect('#qat'), cv = await rect('#cv');
    assert.ok(cv.top <= q.bottom + 30, `the canvas starts under the Quick Access row (${cv.top} <= ${q.bottom} + 30)`);
    return q;
  };
  let qat = await inQat();

  step = 'the Draw flyout opens below the Quick Access row; Ellipse from it sets the tool, presses Draw and closes it';
  await page.click('#qat [data-rail-more=draw]');
  let fly = await rect('.rail-fly');
  const btn = await rect('#qat [data-rail=draw]');
  assert.ok(fly.top >= qat.bottom, `flyout below the row (${fly.top} >= ${qat.bottom})`);
  assert.ok(Math.abs(fly.left - btn.left) < 2, 'flyout starts under its button');
  await page.click('.rail-fly button[data-tool=ellipse]');
  assert.equal(await page.evaluate(() => window.app.toolId), 'ellipse');
  assert.equal(await flyHidden(), true, 'flyout closed');
  assert.equal((await marks()).draw, 'true', 'Draw pressed in the Quick Access rail');
  await page.keyboard.press('Escape'); await page.evaluate(() => window.app.setTool('select'));

  step = 'Escape and an outside click close a Top flyout';
  await page.click('#qat [data-rail-more=modify]');
  assert.equal(await flyHidden(), false);
  await page.keyboard.press('Escape');
  assert.equal(await flyHidden(), true, 'Escape closes');
  await page.click('#qat [data-rail-more=modify]');
  await page.mouse.click(700, 500);
  assert.equal(await flyHidden(), true, 'outside click closes');

  step = 'a rebuilt Quick Access row (app.renderQuickAccess) keeps the rail';
  await page.evaluate(() => window.app.renderQuickAccess());
  qat = await inQat();

  step = 'Quick Access row off: the row stays with only the group buttons and ⋯';
  await page.evaluate(() => window.app.setToolLayout({ ...window.app.toolLayout, quickRow: false }, false));
  const only = await page.evaluate(() => [...document.querySelectorAll('#qat > *')].filter((n) => n.getClientRects().length).map((n) => n.className));
  assert.deepEqual(only, ['rail', 'tp-ctl tp-mode'], `only the rail and ⋯ show (${only})`);
  await inQat();
  await page.evaluate(() => window.app.setToolLayout({ ...window.app.toolLayout, quickRow: true }, false));

  step = 'an 800 px window: nothing in the Quick Access row runs past the window; wrapped groups are in the ⋯ menu';
  await page.setViewportSize({ width: 800, height: 850 });
  await page.waitForTimeout(100);
  const over = await page.evaluate(() => [...document.querySelectorAll('#qat > *, #qat .rail-item')].filter((n) => n.getClientRects().length && n.getBoundingClientRect().right > innerWidth + 0.5).map((n) => `${n.className || n.tagName}:${n.getBoundingClientRect().right}`));
  assert.deepEqual(over, [], 'every visible child of #qat ends inside the window');
  const wrapped = await page.evaluate(() => document.querySelectorAll('#qat .rail-item.fit-out').length);
  if (wrapped) {
    await page.click('#qat .tp-mode');
    assert.equal(await page.locator('.tp-menu [data-ovf]').count(), wrapped, 'each wrapped group is in the ⋯ menu');
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1400, height: 850 });
  await page.waitForTimeout(100);

  step = 'Top + Compact survives a reload';
  await page.reload({ waitUntil: 'load' }); await ready();
  await page.waitForFunction(() => { const c = document.getElementById('app').classList; return c.contains('tools-top') && c.contains('tools-rail'); }, null, { timeout: 3000 });
  qat = await inQat();
  await page.evaluate(() => window.app.setTheme('dark', false));
  await page.click('#qat [data-rail-more=draw]');
  fly = await rect('.rail-fly');
  assert.ok(fly.top >= qat.bottom, 'flyout below the row after the reload');
  await page.mouse.move(700, 500);
  await page.screenshot({ path: path.join(SCRATCH, 'top-compact-qat.png') });
  await page.keyboard.press('Escape');

  step = 'the other restore order (mode before placement) also gives Top + Compact';
  await page.evaluate(() => { window.app.setToolPlacement('left', false); window.app.toolModes.setMode('full', false); window.app.toolModes.setMode('rail', false); window.app.setToolPlacement('top', false); });
  assert.ok(await cls('tools-top') && await cls('tools-rail'));
  await inQat();

  step = 'a restored Floating with placement Top keeps floating, docked on the left, in either order';
  await page.evaluate(() => { window.app.toolModes.setMode('float', false); window.app.setToolPlacement('top', false); });
  assert.ok(await cls('tools-float') && await cls('tools-left'), 'mode, then placement');
  await page.evaluate(() => { window.app.toolModes.setMode('full', false); window.app.setToolPlacement('top', false); window.app.toolModes.setMode('float', false); });
  assert.ok(await cls('tools-float') && await cls('tools-left'), 'placement, then mode');
  await page.evaluate(() => { window.app.toolModes.setMode('full', false); window.app.setToolPlacement('top', false); window.app.toolModes.setMode('rail', false); });
  assert.ok(await cls('tools-top') && await cls('tools-rail'));

  step = 'the Symbols dock rules still apply with the tools at the top';
  await page.evaluate(() => document.getElementById('app').classList.add('sym-dock-left'));
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('main')).gridTemplateAreas), '"tools tools side" "symdock docs side"');
  await page.evaluate(() => document.getElementById('app').classList.remove('sym-dock-left'));

  step = 'Floating and Hidden do not take the top';
  await pickMode('float');
  assert.ok(await cls('tools-float') && await cls('tools-left'), 'Floating moves to the left');
  assert.equal(await page.evaluate(() => !!document.querySelector('#qat .rail')), false, 'the rail left the Quick Access row');
  await viewItem('Tool panel: Top');
  assert.ok(await cls('tools-top') && await cls('tools-full'), 'Top from Floating is Full');
  await pickMode('rail');
  assert.ok(await cls('tools-top') && await cls('tools-rail'), 'Compact rail from the Top Full band stays at the top');
  await inQat();
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
