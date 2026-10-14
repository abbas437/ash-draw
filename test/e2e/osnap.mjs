#!/usr/bin/env node
// Browser end-to-end test of the Drafting Settings dialog (OSNAP): running snap modes, tangent and parallel snaps, F3, persistence; same harness as run.mjs.
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
  const hover = async (x, y, wait = 120) => {
    const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]);
    const box = await page.locator('#cv').boundingBox();
    await page.mouse.move(box.x + s.x, box.y + s.y);
    await page.waitForTimeout(wait);
  };
  const marker = () => page.evaluate(() => window.app.vp.snapMarker?.kind ?? null);
  const kinds = () => page.evaluate(() => [...window.app.vp.settings.kinds].sort());
  const dialogOk = () => page.locator('dialog button.primary').click();

  step = 'defaults: tangent and parallel off';
  assert.ok(!(await kinds()).includes('tan') && !(await kinds()).includes('par'));

  step = 'circle r5 at 0,0 and a line 20,20-30,25; zoom to fit';
  for (const s of ['C', '0,0', '5', 'L', '20,20', '30,25', '']) await typeCmd(s);
  await page.evaluate(() => window.app.vp.zoomExtents());

  step = 'OSNAP opens the dialog; Extension is listed disabled; tick Tangent, polar 30, OK';
  await typeCmd('OSNAP');
  await page.locator('#osnap-dialog').waitFor();
  assert.equal(await page.locator('#osnap-ext').isDisabled(), true);
  assert.match(await page.locator('label[for=osnap-ext]').textContent(), /not yet/);
  await page.locator('#osnap-tan').check();
  await page.locator('#polar-step').selectOption('30');
  await dialogOk();
  assert.ok((await kinds()).includes('tan'));
  assert.equal(await page.evaluate(() => window.app.vp.settings.polarStep), 30);

  step = 'LINE from 10,0: near the upper tangent point the marker is Tangent';
  await typeCmd('L'); await typeCmd('10,0');
  const ty = 5 * Math.sin(Math.PI / 3);
  await hover(2.55, ty + 0.03);
  assert.equal(await marker(), 'tan');
  const c = await page.evaluate(() => window.app.vp.cursor);
  assert.ok(Math.abs(c.x - 2.5) < 1e-9 && Math.abs(c.y - ty) < 1e-9, JSON.stringify(c));

  step = 'untick Tangent: no tangent marker there';
  await typeCmd(''); // end LINE
  await typeCmd('DSETTINGS');
  await page.locator('#osnap-tan').uncheck();
  await dialogOk();
  await typeCmd('L'); await typeCmd('10,0');
  await hover(2.6, ty + 0.05); await hover(2.55, ty + 0.03);
  assert.notEqual(await marker(), 'tan');
  await typeCmd('');

  step = 'Select All ticks Parallel; resting on the line acquires it, the rubber band snaps parallel';
  await typeCmd('OSNAP');
  await page.locator('#osnap-all').click();
  assert.equal(await page.locator('#osnap-par').isChecked(), true);
  assert.equal(await page.locator('#osnap-ext').isChecked(), false, 'a not-yet mode stays off');
  await dialogOk();
  await typeCmd('L'); await typeCmd('0,10');
  await hover(26, 23, 700); // on the line 20,20-30,25 (slope 1/2)
  assert.ok(await page.evaluate(() => !!window.app.vp.parallel), 'direction acquired');
  await hover(8, 14.03);
  assert.equal(await marker(), 'par');
  const pc = await page.evaluate(() => window.app.vp.cursor);
  assert.ok(Math.abs((pc.y - 10) - (pc.x - 0) / 2) < 1e-9, JSON.stringify(pc));
  step = 'Enter ends the LINE; a new line does not keep the acquired direction (no snap, no glyph)';
  await typeCmd('');
  assert.equal(await page.evaluate(() => window.app.vp.parallel), null, 'acquired direction cleared when the command sequence ends');
  await typeCmd('L'); await typeCmd('0,10');
  await hover(8, 14.03);
  assert.notEqual(await marker(), 'par');
  assert.equal(await page.evaluate(() => window.app.vp.parallel), null);
  await typeCmd('');

  step = 'F3 toggles running snaps';
  await page.locator('#cv').focus();
  await page.keyboard.press('F3');
  assert.equal(await page.evaluate(() => window.app.vp.settings.snap), false);
  await page.keyboard.press('F3');
  assert.equal(await page.evaluate(() => window.app.vp.settings.snap), true);

  step = 'right-click on SNAP opens the dialog; Clear All, OK; settings survive a reload';
  await page.locator('#status button[data-key=snap]').click({ button: 'right' });
  await page.locator('#osnap-dialog').waitFor();
  await page.locator('#osnap-none').click();
  await page.locator('#osnap-end').check();
  await page.locator('#osnap-gcen').check();
  await page.locator('#polar-extra').fill('15');
  await dialogOk();
  await page.locator('#cv').focus();
  await page.keyboard.press('F3'); // snap off after the dialog saved: only the toggle itself persists this
  assert.equal(await page.evaluate(() => window.app.vp.settings.snap), false);
  await page.reload({ waitUntil: 'load' });
  await ready();
  await page.waitForFunction(() => window.app.vp.settings.kinds.size === 2, null, { timeout: 5000 });
  assert.deepEqual(await kinds(), ['end', 'gcen']);
  assert.equal(await page.evaluate(() => window.app.vp.settings.polarStep), 30);
  assert.deepEqual(await page.evaluate(() => window.app.vp.settings.polarExtra), [15]);
  assert.equal(await page.evaluate(() => window.app.vp.settings.snap), false, 'F3 off survives the reload');

  assert.deepEqual(problems, []);
  console.log('osnap e2e: OK');
} catch (err) {
  console.error(`osnap e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
