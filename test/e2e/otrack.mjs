#!/usr/bin/env node
// Browser end-to-end test of the Extension object snap and object snap tracking (OTRACK, F11); same harness as osnap.mjs.
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

  const vp = (f) => page.evaluate(f);
  const at = (p, x, y) => assert.ok(p && Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9, JSON.stringify(p));
  const clickHere = async () => { await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(50); };

  step = 'two lines: 0,0-10,0 and 20,10-20,20; zoom to fit; OSNAP: tick Extension';
  for (const s of ['L', '0,0', '10,0', '', 'L', '20,10', '20,20', '']) await typeCmd(s);
  await page.evaluate(() => window.app.vp.zoomExtents());
  await typeCmd('OSNAP');
  await page.locator('#osnap-dialog').waitFor();
  assert.equal(await page.locator('#osnap-ext').isDisabled(), false);
  await page.locator('#osnap-ext').check();
  await dialogOk();
  assert.ok((await kinds()).includes('ext'));
  assert.equal(await vp(() => window.app.vp.settings.otrack), false, 'OTRACK off by default');

  step = 'LINE: resting on the end 10,0 acquires it; a short pass does not';
  await typeCmd('L');
  await hover(10, 0, 200); await hover(5, 3, 50);
  assert.equal(await vp(() => window.app.vp.acquired.length), 0, 'not acquired after 0.2 s');
  await hover(10, 0, 700);
  assert.equal(await vp(() => window.app.vp.acquired.length), 1);
  at(await vp(() => window.app.vp.acquired[0].at), 10, 0);

  step = 'along the extension: Extension marker, the point on the extension; click';
  await hover(15, 0.1);
  assert.equal(await marker(), 'ext');
  const m = await vp(() => { const s = window.app.vp.snapMarker; return { x: s.x, y: s.y, dist: s.dist, angle: s.angle }; });
  assert.ok(Math.abs(m.y) < 1e-9 && Math.abs(m.x - 15) < 0.2 && Math.abs(m.dist - (m.x - 10)) < 1e-9 && m.angle === 0, JSON.stringify(m));
  await clickHere();
  const p1 = await vp(() => window.app.vp.lastPoint);
  assert.ok(Math.abs(p1.y) < 1e-9 && p1.x > 10, `first point on the extension: ${JSON.stringify(p1)}`);
  await typeCmd(''); // end LINE
  assert.equal(await vp(() => window.app.vp.acquired.length), 0, 'acquired points cleared when the command ends');

  step = 'F11 turns OTRACK on (status button too)';
  await page.locator('#cv').focus();
  await page.keyboard.press('F11');
  assert.equal(await vp(() => window.app.vp.settings.otrack), true);
  assert.equal(await page.locator('#status button[data-key=otrack]').evaluate((b) => b.classList.contains('on')), true);

  step = 'LINE: acquire 10,0 and 20,10; near the crossing of the vertical through 10,0 and the horizontal through 20,10';
  await typeCmd('L');
  await hover(10, 0, 700); await hover(20, 10, 700);
  assert.equal(await vp(() => window.app.vp.acquired.length), 2);
  await hover(10.15, 9.9);
  assert.equal(await marker(), 'trackint');
  await clickHere();
  at(await vp(() => window.app.vp.lastPoint), 10, 10);

  step = 'on the horizontal tracking line through 20,10, a typed 4 places the point 4 from it';
  await hover(14, 10.1);
  assert.equal(await marker(), 'track');
  at(await vp(() => window.app.vp.snapMarker.from), 20, 10);
  await typeCmd('4');
  at(await vp(() => window.app.vp.lastPoint), 16, 10);
  at(await vp(() => window.app.doc.entities.at(-1).p1), 10, 10);
  at(await vp(() => window.app.doc.entities.at(-1).p2), 16, 10);

  step = 'resting on an acquired point again releases it';
  await hover(10, 0, 700);
  assert.equal(await vp(() => window.app.vp.acquired.length), 1);
  await typeCmd('');
  assert.equal(await vp(() => window.app.vp.acquired.length), 0);

  step = 'OTRACK survives a reload; F11 turns it off';
  await page.reload({ waitUntil: 'load' });
  await ready();
  await page.waitForFunction(() => window.app.vp.settings.otrack === true, null, { timeout: 5000 });
  await page.locator('#cv').focus();
  await page.keyboard.press('F11');
  assert.equal(await vp(() => window.app.vp.settings.otrack), false);

  assert.deepEqual(problems, []);
  console.log('otrack e2e: OK');
} catch (err) {
  console.error(`otrack e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
