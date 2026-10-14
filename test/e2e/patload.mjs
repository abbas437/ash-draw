#!/usr/bin/env node
// Browser end-to-end test of hatch patterns loaded from a .pat file (Format > Load patterns / Hatch patterns…); same harness as run.mjs.
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
  const menu = async (top, item) => { await page.locator('#menubar .menu > button', { hasText: top }).click(); await page.locator('#menubar .drop button', { hasText: item }).click(); };
  const chooseFile = async (trigger, file) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), trigger()]);
    await chooser.setFiles(file);
  };
  const optionsOf = () => page.evaluate(() => [...window.app.patternSel.querySelectorAll('optgroup[label=Loaded] option')].map((o) => o.value));
  const hatches = () => page.evaluate(() => JSON.parse(JSON.stringify(window.app.doc.entities.filter((e) => e.type === 'HATCH'))));
  const NAME = 'DASHY', PLAIN = 'PLAINY';
  const pat = [`*${PLAIN}, plain lines`, '45, 0,0, 0,5', `*${NAME}, dashed lines`, '0, 0,0, 0,6, 4,-2', '90, 0,0, 0,6, 3,-3', ''].join('\n');

  step = 'Format > Load patterns from .pat file…: the file chooser takes a .pat';
  await chooseFile(() => menu('Format', 'Load patterns from .pat file'), { name: 't.pat', mimeType: 'text/plain', buffer: Buffer.from(pat) });
  await page.waitForFunction((n) => [...window.app.patternSel.querySelectorAll('optgroup[label=Loaded] option')].some((o) => o.value === n), NAME, { timeout: 5000 });

  step = 'the list has a "Loaded" group with both names; select the dashed one';
  assert.deepEqual((await optionsOf()).sort(), [NAME, PLAIN].sort());
  await page.locator('#cmd').focus();
  await page.evaluate((n) => { const s = window.app.patternSel; s.value = n; s.dispatchEvent(new Event('change', { bubbles: true })); }, NAME);
  assert.equal(await page.evaluate(() => window.app.defaults.hatchPattern), NAME);

  step = 'rectangle + HATCH inside: the hatch is NAME and carries its dashed patLines';
  await typeCmd('rec'); await typeCmd('0,0'); await typeCmd('100,60');
  await page.evaluate(() => { const v = window.app.vp; v.view = { ...v.view, cx: 50, cy: 30, zoom: Math.min(v.view.width / 150, v.view.height / 100) }; v.render(); });
  const clickWorld = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]);
    const box = await page.locator('#cv').boundingBox();
    await page.mouse.click(box.x + s.x, box.y + s.y);
  };
  await page.click('#tools button[data-tool=hatch]');
  await clickWorld(50, 30);
  let hs = await hatches();
  assert.equal(hs.length, 1, 'one HATCH');
  assert.equal(hs[0].pattern, NAME);
  assert.ok(hs[0].patLines.length > 0, 'patLines stored');
  assert.ok(hs[0].patLines.some((l) => l.dashes.length > 0), 'the dashes are stored');
  await page.keyboard.press('Escape');

  step = 'reload the page: the loaded patterns persist';
  await page.reload({ waitUntil: 'load' });
  await ready();
  assert.deepEqual((await optionsOf()).sort(), [NAME, PLAIN].sort());

  step = 'Format > Hatch patterns…: Remove one; it leaves the list and the drawing\'s hatch still draws';
  await page.evaluate(async () => { // a drawing with a hatch that carries its own lines (the reload cleared the previous one)
    const M = await import('/src/core/model.js');
    const pts = [[0, 0], [60, 0], [60, 40], [0, 40]].map(([x, y]) => ({ x, y, bulge: 0 }));
    const h = M.makeHatch([{ closed: true, pts }], { solid: false, pattern: 'DASHY', scale: 1, angle: 0 });
    h.patLines = [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 6 }, dashes: [4, -2] }];
    M.addEntity(window.app.doc, h);
    const v = window.app.vp; v.view = { ...v.view, cx: 30, cy: 20, zoom: Math.min(v.view.width / 90, v.view.height / 60) }; v.render();
  });
  await menu('Format', 'Hatch patterns');
  await page.locator('#patterns-list button[data-remove=DASHY]').click();
  await page.locator('dialog[open] .dlg-btns button').click();
  assert.deepEqual(await optionsOf(), [PLAIN]);
  assert.equal(await page.evaluate(() => window.app.patternSel.value === 'DASHY'), false);
  const ink = await page.evaluate(() => {
    const vp = window.app.vp; vp.render();
    const c = document.getElementById('cv'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const bg = [d[0], d[1], d[2]]; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 90) n++;
    return n;
  });
  assert.ok(ink > 200, `the hatch is still drawn from its own patLines (${ink} px)`);
  hs = await hatches();
  assert.equal(hs[0].pattern, 'DASHY');
  assert.ok(hs[0].patLines.length > 0);
  await page.reload({ waitUntil: 'load' });
  await ready();
  assert.deepEqual(await optionsOf(), [PLAIN], 'the removal persists');

  step = 'open a DXF whose HATCH has an unknown pattern and no lines: the report says "unknown pattern"';
  const dxf = await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const { writeDxf } = await import('/src/core/dxfWrite.js');
    const doc = M.newDocument();
    const pts = [[0, 0], [40, 0], [40, 40], [0, 40]].map(([x, y]) => ({ x, y, bulge: 0 }));
    const h = M.makeHatch([{ closed: true, pts }], { solid: false, pattern: 'NOSUCHPAT', scale: 1, angle: 0 });
    h.pattern = 'ANSI31'; // the writer turns an unknown pattern into a solid fill, so write a known one and edit the file
    M.addEntity(doc, h);
    return writeDxf(doc).replace(/\nANSI31(\r?\n)([\s\S]*?\n78\r?\n)\d+/, '\nNOSUCHPAT$1$20');
  });
  assert.ok(dxf.includes('NOSUCHPAT'), 'fixture edit');
  await chooseFile(() => page.keyboard.press('Control+o'), { name: 'unk.dxf', mimeType: 'application/dxf', buffer: Buffer.from(dxf) });
  const report = page.locator('dialog[open]', { hasText: 'Opened with limitations' });
  await report.waitFor({ timeout: 8000 });
  assert.match(await report.innerText(), /unknown pattern NOSUCHPAT/);

  assert.deepEqual(problems, []);
  console.log('patload e2e: OK');
} catch (err) {
  console.error(`patload e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
