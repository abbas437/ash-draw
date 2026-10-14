#!/usr/bin/env node
// Browser end-to-end test of COMPARE: automatic alignment, the panel's offset line and views, Plot to PDF, and alignment
// by picked points (two per drawing, Esc cancels); same harness as run.mjs.
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
  const toolId = () => page.evaluate(() => window.app.toolId);

  step = 'two DXFs: A, and B = A moved by (500, 200) plus one line';
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const { writeDxf } = await import('/src/core/dxfWrite.js');
    const { loadDrawing } = await import('/renderer/files.js');
    const mk = (dx, dy, extra) => {
      const d = M.newDocument(); d.units = 4;
      const L = (x1, y1, x2, y2) => M.addEntity(d, M.makeLine({ x: x1 + dx, y: y1 + dy }, { x: x2 + dx, y: y2 + dy }));
      L(0, 0, 400, 0); L(400, 0, 400, 250); L(400, 250, 0, 250); L(0, 250, 0, 0); L(50, 50, 150, 120); L(300, 60, 360, 60);
      M.addEntity(d, M.makeCircle({ x: 200 + dx, y: 180 + dy }, 30));
      if (extra) L(100, 200, 180, 230);
      return d;
    };
    for (const [name, d] of [['a.dxf', mk(0, 0, false)], ['b.dxf', mk(500, 200, true)]]) {
      const { doc } = await loadDrawing(window.api, name, new TextEncoder().encode(writeDxf(d)));
      window.app.installDoc(doc, { path: null, name, format: 'dxf' });
    }
  });
  const openDialog = async (align) => {
    await typeCmd('compare');
    await page.locator('#dlg[open] #cmp-a').waitFor({ timeout: 3000 });
    await page.selectOption('#cmp-a', { label: 'a.dxf' });
    await page.selectOption('#cmp-b', { label: 'b.dxf' });
    assert.equal(await page.locator('#cmp-align').inputValue(), 'auto', 'Automatic is the default');
    assert.equal(await page.locator('#cmp-tol').inputValue(), '1', '1 mm in a mm drawing');
    if (align) await page.selectOption('#cmp-align', align);
    await page.locator('#dlg button.primary').click();
  };
  const panelText = async () => ({ offset: await page.locator('#compare-panel .cmp-offset').textContent(), counts: await page.locator('#compare-panel .cmp-counts').textContent() });
  const checkResult = async (how) => {
    await page.waitForFunction((n) => window.app.tabs.filter((t) => t.compare).length === n && !document.getElementById('compare-panel').hidden, how === 'auto' ? 1 : 2, { timeout: 20000 });
    const { offset, counts } = await panelText();
    assert.match(counts, /Pieces/); assert.match(counts, /Added 1(?!\d)/); assert.match(counts, /Removed 0(?!\d)/); assert.match(counts, /Changed 0(?!\d)/); assert.match(counts, /Unchanged 7(?!\d)/);
    assert.match(offset, /^A aligned to B: moved 500, 200/);
    assert.match(offset, how === 'auto' ? /automatic; match good/ : /picked points/);
  };

  step = 'COMPARE, Automatic: 1 added, 0 removed, offset 500, 200';
  await openDialog(null);
  await checkResult('auto');

  step = 'views: Overlay shows every compare layer, A only hides B-only layers';
  const layers = () => page.evaluate(() => Object.fromEntries([...window.app.fileDoc.layers.values()].filter((l) => l.name.startsWith('COMPARE-')).map((l) => [l.name, l.visible !== false])));
  const scene0 = await page.evaluate(() => { window.__scene = window.app.vp.scene; return true; });
  assert.ok(scene0);
  await page.selectOption('#cmp-view', 'overlay');
  assert.ok(Object.values(await layers()).every(Boolean), 'overlay: all compare layers on');
  assert.ok(await page.evaluate(() => window.app.vp.scene !== window.__scene), 'the scene is rebuilt after a view change');
  await page.selectOption('#cmp-view', 'a');
  const la = await layers();
  assert.equal(la['COMPARE-ADDED'], false); assert.equal(la['COMPARE-CHANGED'], false);
  assert.equal(la['COMPARE-REMOVED'], true); assert.equal(la['COMPARE-CHANGED-A'], true); assert.equal(la['COMPARE-SAME'], true);
  await page.selectOption('#cmp-view', 'b');
  const lb = await layers();
  assert.equal(lb['COMPARE-ADDED'], true); assert.equal(lb['COMPARE-REMOVED'], false); assert.equal(lb['COMPARE-CHANGED-A'], false);
  await page.selectOption('#cmp-view', 'differences');

  step = 'Plot to PDF… opens the Plot dialog for the compare tab';
  await page.click('#cmp-plot');
  await page.locator('#dlg[open]').waitFor({ timeout: 3000 });
  await page.keyboard.press('Escape');
  await page.locator('#dlg[open]').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});

  // click a world point on the canvas (endpoint snap gives it exactly)
  const clickAt = async (x, y) => {
    const s = await page.evaluate(([wx, wy]) => { const r = window.app.vp.canvas.getBoundingClientRect(), p = window.app.vp.toScreen({ x: wx, y: wy }); return { x: r.left + p.x, y: r.top + p.y }; }, [x, y]);
    await page.mouse.move(s.x + 3, s.y + 3); await page.mouse.move(s.x, s.y); await page.mouse.click(s.x, s.y);
  };
  const prompt = () => page.locator('#prompt').textContent();
  const tabName = () => page.evaluate(() => window.app.active.file.name);

  step = 'Pick points, Esc cancels';
  await openDialog('pick');
  assert.equal(await tabName(), 'a.dxf'); assert.match(await prompt(), /base point in A/);
  await page.keyboard.press('Escape');
  assert.equal(await toolId(), 'select');
  assert.equal(await page.evaluate(() => window.app.tabs.filter((t) => t.compare).length), 1, 'no new compare tab');

  step = 'Pick points: two points in A, two in B: same result';
  await openDialog('pick');
  assert.equal(await tabName(), 'a.dxf');
  await page.evaluate(() => window.app.vp.zoomExtents());
  await clickAt(400, 0);
  assert.match(await prompt(), /second point in A/);
  await clickAt(400, 250);
  assert.equal(await tabName(), 'b.dxf'); assert.match(await prompt(), /base point in B/);
  await page.evaluate(() => window.app.vp.zoomExtents());
  await clickAt(900, 200);
  assert.match(await prompt(), /second point in B/);
  await clickAt(900, 450);
  await checkResult('pick');
  assert.equal(await toolId(), 'select');

  step = 'B turned 180° about (1000, 500) plus one line: offset line says rotated 180°, counts right; Group distance 1.5 m';
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const { writeDxf } = await import('/src/core/dxfWrite.js');
    const { loadDrawing } = await import('/renderer/files.js');
    const d = M.newDocument(); d.units = 4;
    const T = (x, y) => ({ x: 2000 - x, y: 1000 - y }); // 180° about (1000, 500)
    const L = (x1, y1, x2, y2) => M.addEntity(d, M.makeLine(T(x1, y1), T(x2, y2)));
    L(0, 0, 400, 0); L(400, 0, 400, 250); L(400, 250, 0, 250); L(0, 250, 0, 0); L(50, 50, 150, 120); L(300, 60, 360, 60);
    M.addEntity(d, M.makeCircle(T(200, 180), 30));
    L(100, 200, 180, 230);
    const { doc } = await loadDrawing(window.api, 'b180.dxf', new TextEncoder().encode(writeDxf(d)));
    window.app.installDoc(doc, { path: null, name: 'b180.dxf', format: 'dxf' });
  });
  await typeCmd('compare');
  await page.locator('#dlg[open] #cmp-a').waitFor({ timeout: 3000 });
  await page.selectOption('#cmp-a', { label: 'a.dxf' });
  await page.selectOption('#cmp-b', { label: 'b180.dxf' });
  assert.equal(await page.locator('#cmp-gap').inputValue(), '1500', 'group distance 1.5 m in a mm drawing');
  assert.ok((await page.locator('#cmp-ignore option').count()) >= 1, 'the layers of B to ignore');
  await page.locator('#dlg button.primary').click();
  await page.waitForFunction(() => window.app.tabs.filter((t) => t.compare).length === 3 && !document.getElementById('compare-panel').hidden, null, { timeout: 20000 });
  {
    const { offset, counts } = await panelText();
    assert.match(counts, /Added 1(?!\d)/); assert.match(counts, /Removed 0(?!\d)/); assert.match(counts, /Changed 0(?!\d)/); assert.match(counts, /Unchanged 7(?!\d)/);
    assert.match(offset, /^A aligned to B: moved 2000, 1000; rotated 180° \(automatic; match good\)/);
    assert.equal(await page.locator('#compare-panel .cmp-row').count(), 1, 'one cluster');
  }

  assert.deepEqual(problems, []);
  console.log('compare e2e: OK');
} catch (err) {
  console.error(`compare e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
