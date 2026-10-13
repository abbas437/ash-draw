#!/usr/bin/env node
// Browser end-to-end test of the command history (strip above the prompt bar, F2 panel, Up-arrow recall); same harness as run.mjs.
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
  const strip = () => page.evaluate(() => { // the lines visible in the collapsed strip
    const list = document.querySelector('#cmdhist .ch-list').getBoundingClientRect();
    return [...document.querySelectorAll('#cmdhist .ch-line')].filter((l) => { const r = l.getBoundingClientRect(); return r.top >= list.top - 0.5 && r.bottom <= list.bottom + 0.5; }).map((l) => l.textContent);
  });

  step = 'the collapsed strip (at most 54 px) lies over the bottom of the canvas; clicks there reach the canvas';
  {
    const g = await page.evaluate(() => {
      const h = document.getElementById('cmdhist').getBoundingClientRect(), c = document.getElementById('cv').getBoundingClientRect();
      return { h: h.height, gap: c.bottom - h.bottom, hit: document.elementFromPoint(h.left + h.width / 2, h.top + h.height / 2)?.id };
    });
    assert.ok(g.h > 0 && g.h <= 54, `strip height ${g.h}`);
    assert.ok(Math.abs(g.gap) < 1, `strip at the bottom of the canvas (gap ${g.gap})`);
    assert.equal(g.hit, 'cv', 'pointer goes through to the canvas');
  }

  step = 'L 0,0 10,0 Enter, then ID 3,4: the strip shows the ID coordinates';
  {
    await typeCmd('L'); await typeCmd('0,0'); await typeCmd('10,0'); await typeCmd('');
    assert.equal(await page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'LINE').length), 1, 'the line was drawn');
    await typeCmd('ID'); await typeCmd('3,4');
    const lines = await strip();
    assert.equal(lines.length, 3, `3 visible lines: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((t) => /X = 3(\.0+)?\b.*Y = 4(\.0+)?\b/.test(t)), `ID result in the strip: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((t) => /^ID {2}specify point: 3,4$/.test(t)), `the input with its prompt: ${JSON.stringify(lines)}`);
  }

  step = 'the wheel over the collapsed strip zooms the drawing (the strip is transparent to the pointer)';
  {
    const box = await page.locator('#cv').boundingBox();
    const before = await page.evaluate(() => ({ zoom: window.app.vp.view.zoom, top: document.querySelector('#cmdhist .ch-list').scrollTop }));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20);
    await page.mouse.wheel(0, -200);
    await page.waitForFunction((z) => window.app.vp.view.zoom !== z, before.zoom, { timeout: 3000 });
    assert.equal(await page.evaluate(() => document.querySelector('#cmdhist .ch-list').scrollTop), before.top, 'the history did not scroll');
  }

  step = 'F2 opens the panel (12 lines, Copy) listing L; the canvas keeps its size; Escape closes';
  {
    const cv = await page.evaluate(() => document.getElementById('cv').getBoundingClientRect().height);
    await page.locator('#cv').focus();
    await page.keyboard.press('F2');
    assert.equal(await page.locator('#cmdhist.open').count(), 1, 'panel open');
    assert.equal(await page.locator('#cmdhist .ch-copy').isVisible(), true, 'Copy button');
    const all = await page.locator('#cmdhist .ch-line').allTextContents();
    assert.ok(all.includes('Command: L'), `lists L: ${JSON.stringify(all)}`);
    assert.ok(all.includes('LINE  specify first point: 0,0') || all.some((t) => /^LINE.*: 0,0$/.test(t)), `lists the first point: ${JSON.stringify(all)}`);
    const box = await page.evaluate(() => document.querySelector('#cmdhist .ch-list').getBoundingClientRect().height);
    assert.ok(box >= 150, `about 12 lines tall: ${box}`);
    assert.equal(await page.evaluate(() => document.getElementById('cv').getBoundingClientRect().height), cv, 'the canvas is not resized');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#cmdhist.open').count(), 0, 'Escape closes');
    await page.locator('#cmd').focus(); await page.keyboard.press('F2');
    assert.equal(await page.locator('#cmdhist.open').count(), 1, 'F2 from the command input opens it');
    await page.keyboard.press('F2');
    assert.equal(await page.locator('#cmdhist.open').count(), 0, 'F2 closes');
  }

  step = 'Up arrow in the empty input recalls ID, then 3,4 ... Down goes back';
  {
    await page.locator('#cmd').focus();
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.locator('#cmd').inputValue(), '3,4');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.locator('#cmd').inputValue(), 'ID');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('#cmd').inputValue(), '3,4');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('#cmd').inputValue(), '');
    await page.keyboard.press('Escape');
  }

  step = 'an unknown command is logged; View > Command history toggles the panel';
  {
    await typeCmd('xyz');
    assert.ok((await strip()).includes('Unknown command "xyz".'));
    await page.locator('#menubar .menu > button', { hasText: 'View' }).click();
    await page.locator('#menubar .drop button', { hasText: 'Command history' }).click();
    assert.equal(await page.locator('#cmdhist.open').count(), 1, 'menu opens it');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#cmdhist.open').count(), 0);
  }

  assert.deepEqual(problems, []);
  console.log('cmdhist e2e: OK');
} catch (err) {
  console.error(`cmdhist e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
