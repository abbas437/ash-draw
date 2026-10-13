#!/usr/bin/env node
// Browser end-to-end test of the command-line view/inquiry commands (ZOOM options, ID, LIST, LA, LTSCALE, RE); same harness as run.mjs.
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
  const view = () => page.evaluate(() => { const v = window.app.vp.view; return { cx: v.cx, cy: v.cy, zoom: v.zoom, width: v.width, height: v.height }; });
  const toolId = () => page.evaluate(() => window.app.toolId);
  const pause = () => page.waitForTimeout(450); // a later change is a new ZOOM Previous entry, not part of the same gesture

  step = 'draw two circles far apart';
  for (const [c, r] of [['0,0', '10'], ['1000,0', '10']]) { await typeCmd('C'); await typeCmd(c); await typeCmd(r); }
  await page.keyboard.press('Escape');
  const circles = await page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'CIRCLE').map((e) => e.id));
  assert.equal(circles.length, 2, 'two circles drawn');

  step = 'ZE';
  await pause();
  await typeCmd('ZE');
  const ext = await view();

  step = 'ZOOM Window by two typed corners';
  await pause();
  await typeCmd('Z');
  assert.equal(await toolId(), 'zoom', 'Z starts ZOOM');
  assert.match(await page.locator('#prompt').textContent(), /\[All\/Extents\/Window\/Previous\/Object\]/);
  await typeCmd('W'); await typeCmd('-20,-20'); await typeCmd('20,20');
  const win = await view();
  assert.ok(win.zoom > ext.zoom * 10, `window zoomed in (${win.zoom} vs ${ext.zoom})`);
  assert.ok(Math.abs(win.cx) < 1e-6 && Math.abs(win.cy) < 1e-6, 'window centred on its corners');
  assert.equal(await toolId(), 'select', 'back to Select after Window');

  step = 'ZOOM Previous';
  await pause();
  await typeCmd('Z'); await typeCmd('P');
  const prev = await view();
  assert.deepEqual({ cx: prev.cx, cy: prev.cy, zoom: prev.zoom }, { cx: ext.cx, cy: ext.cy, zoom: ext.zoom }, 'Previous restores the exact earlier view');
  assert.equal(await toolId(), 'select', 'back to Select after Previous');

  step = 'ZOOM Object on the selected circle';
  await page.evaluate((id) => window.app.vp.setSelection([id]), circles[1]);
  await pause();
  await typeCmd('Z'); await typeCmd('O');
  const obj = await view();
  const side = Math.min(obj.width, obj.height);
  assert.ok(Math.abs(obj.cx - 1000) < 1e-6 && Math.abs(obj.cy) < 1e-6, `centred on the circle (${obj.cx}, ${obj.cy})`);
  assert.ok(20 * obj.zoom > 0.85 * side && 20 * obj.zoom <= side, `the circle fills the view (${20 * obj.zoom}px of ${side}px)`);
  assert.equal(await toolId(), 'select', 'back to Select after Object');

  step = 'ZOOM 2x';
  await pause();
  await typeCmd('Z'); await typeCmd('2x');
  const two = await view();
  assert.ok(Math.abs(two.zoom / obj.zoom - 2) < 1e-9, `zoom doubled (${two.zoom / obj.zoom})`);
  assert.ok(Math.abs(two.cx - obj.cx) < 1e-6 && Math.abs(two.cy - obj.cy) < 1e-6, '2x keeps the view centre');
  assert.equal(await toolId(), 'select', 'back to Select after 2x');

  step = 'ZOOM nXP';
  await typeCmd('Z'); await typeCmd('2xp');
  assert.equal((await view()).zoom, two.zoom, 'nXP leaves the view alone');
  assert.match(await page.locator('body').textContent(), /2XP is not supported yet/);
  assert.equal(await toolId(), 'select', 'back to Select after nXP');

  step = 'ID on a typed point';
  await typeCmd('ID');
  assert.equal(await toolId(), 'id', 'ID starts the point tool');
  assert.match(await page.locator('#prompt').textContent(), /ID {2}specify point/);
  await typeCmd('12.5,-3');
  assert.match(await page.locator('#toast').textContent(), /X = 12\.5 {3}Y = -3/);
  assert.equal(await toolId(), 'select', 'back to Select after ID');

  step = 'LIST of a selected line and circle';
  await typeCmd('L'); await typeCmd('0,0'); await typeCmd('10,10'); await typeCmd('');
  await page.keyboard.press('Escape');
  const line = await page.evaluate(() => window.app.doc.entities.find((e) => e.type === 'LINE').id);
  await page.evaluate((ids) => window.app.vp.setSelection(ids), [line, circles[0]]);
  await typeCmd('LI');
  await page.locator('#list-text').waitFor({ state: 'visible' });
  const listed = await page.locator('#list-text').textContent();
  assert.match(listed, /Length = 14\.1421\b/, 'line length to the drawing precision');
  assert.match(listed, /radius 10\b/, 'circle radius');
  assert.equal(await page.locator('#dlg button').filter({ hasText: 'Copy' }).count(), 1, 'a Copy button');
  await page.keyboard.press('Escape');
  await page.locator('#list-text').waitFor({ state: 'detached' }).catch(() => {});
  assert.equal(await page.evaluate(() => document.getElementById('dlg').open), false, 'Escape closes LIST');
  assert.equal(await toolId(), 'select', 'back to Select after LIST');

  step = 'LA shows the Layers panel';
  await page.evaluate(() => document.getElementById('app').classList.add('no-side'));
  assert.equal(await page.locator('#layers').isVisible(), false, 'panel hidden first');
  await typeCmd('LA');
  assert.equal(await page.locator('#layers').isVisible(), true, 'LA shows #layers');

  step = 'LTSCALE 2 then U';
  await typeCmd('LTS');
  assert.match(await page.locator('#prompt').textContent(), /LTSCALE {2}new linetype scale factor <1>/);
  await typeCmd('2');
  assert.equal(await page.evaluate(() => window.app.fileDoc.header.ltscale), 2, 'LTSCALE sets $LTSCALE');
  assert.equal(await toolId(), 'select', 'back to Select after LTSCALE');
  await typeCmd('U');
  assert.equal(await page.evaluate(() => window.app.fileDoc.header?.ltscale || 1), 1, 'U restores $LTSCALE');

  step = 'RE';
  await typeCmd('RE');
  assert.match(await page.locator('#toast').textContent(), /Regenerating model\./);

  assert.deepEqual(problems, []);
  console.log('cmdline e2e: OK');
} catch (err) {
  console.error(`cmdline e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
