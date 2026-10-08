#!/usr/bin/env node
// Browser end-to-end test of the draw app (headless Chromium via playwright-core, served over http).
// Uses the browser fallback of window.api (shim.js); Electron-only features (DWG) are covered elsewhere.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOTS = process.env.E2E_SHOTS || '';
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const rgbOf = (css) => css.match(/[\d.]+/g).slice(0, 3).map(Number);
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });

  const count = () => page.evaluate(() => window.app.doc.entities.length);
  const types = () => page.evaluate(() => window.app.doc.entities.map((e) => e.type));
  const clickWorld = async (x, y, opts = {}) => {
    const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]);
    const box = await page.locator('#cv').boundingBox();
    await page.mouse.click(box.x + s.x, box.y + s.y, opts);
  };
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  const typeCmd = async (text) => { await page.locator('#cmd').fill(text); await page.locator('#cmd').press('Enter'); };

  step = 'ui present';
  assert.ok(await page.locator('#menubar .menu').count() >= 4);
  step = 'first run uses the light theme';
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? 'light'), 'light');
  assert.ok(lum(rgbOf(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))) > 0.7, 'body background is not light');
  assert.equal(await page.evaluate(() => window.app.vp.settings.dark), false);
  assert.ok(await page.locator('#tools button').count() >= 20);

  step = 'draw a line with the mouse';
  await page.evaluate(() => window.app.vp.zoomBy(0.0001)); // tiny zoom so clicks map to large world units
  await page.evaluate(() => { window.app.vp.view = { ...window.app.vp.view, cx: 50, cy: 25, zoom: 8 }; window.app.vp.render(); });
  await page.click('#tools button[data-tool=line]');
  await clickWorld(0, 0); await clickWorld(40, 0); await clickWorld(40, 30);
  await page.keyboard.press('Escape');
  assert.deepEqual(await types(), ['LINE', 'LINE']);

  step = 'typed coordinates';
  await typeCmd('rec'); await typeCmd('60,0'); await typeCmd('@30,20');
  assert.equal((await types()).filter((t) => t === 'LWPOLYLINE').length, 1);
  await typeCmd('c'); await typeCmd('75,10'); await typeCmd('6');
  assert.equal((await types()).filter((t) => t === 'CIRCLE').length, 1);
  const circle = await page.evaluate(() => window.app.doc.entities.find((e) => e.type === 'CIRCLE'));
  assert.deepEqual([circle.c.x, circle.c.y, circle.r], [75, 10, 6]);

  step = 'undo / redo';
  const n = await count();
  await page.keyboard.press('Control+z');
  assert.equal(await count(), n - 1);
  await page.keyboard.press('Control+y');
  assert.equal(await count(), n);

  step = 'select with window, move by typed offset';
  await page.click('#tools button[data-tool=select]');
  const a = await page.evaluate(() => window.app.vp.toScreen({ x: 55, y: -5 })), b = await page.evaluate(() => window.app.vp.toScreen({ x: 95, y: 28 }));
  const box = await page.locator('#cv').boundingBox();
  await page.mouse.move(box.x + a.x, box.y + a.y); await page.mouse.down(); await page.mouse.move(box.x + b.x, box.y + b.y, { steps: 5 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.app.vp.selection.size), 2); // rectangle + circle fully inside
  await typeCmd('m'); await typeCmd('0,0'); await typeCmd('@0,-10');
  const rect = await page.evaluate(() => window.app.doc.entities.find((e) => e.type === 'LWPOLYLINE'));
  assert.equal(rect.vertices[0].y, -10);

  step = 'erase and layers';
  await page.keyboard.press('Control+a');
  assert.equal(await page.evaluate(() => window.app.vp.selection.size), await count());
  await page.click('#layer-add'); await page.locator('#dlg input').fill('DUCTS'); await page.locator('#dlg button.primary').click();
  assert.ok(await page.evaluate(() => window.app.doc.layers.has('DUCTS')));
  await page.locator('#cv').focus();
  await page.keyboard.press('Delete');
  assert.equal(await count(), 0);
  await page.keyboard.press('Control+z');
  assert.ok(await count() > 0);

  step = 'open a fixture DXF through the file chooser';
  const fixtures = ['hatch_r2000.dxf', 'blocks_r2000.dxf', 'text_r2000.dxf', 'dims_r2000.dxf', 'r2007_ac1021.dxf'];
  for (const f of fixtures) {
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+o');
    // the unsaved-changes dialog may appear first
    if (await page.locator('#dlg[open]').count()) await page.locator('#dlg button', { hasText: "Don't save" }).click();
    (await chooser).setFiles(path.join(ROOT, 'test', 'fixtures', f));
    await page.waitForFunction((name) => window.app.file.name === name, f, { timeout: 8000 });
    assert.ok(await count() > 0, `${f} opened empty`);
    await page.waitForTimeout(100);
    await shot(`open_${f.replace('.dxf', '')}`);
    // the canvas must contain drawn pixels other than the background (white on the default light canvas)
    const painted = await page.evaluate(() => {
      const c = document.getElementById('cv'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const bg = window.app.vp.settings.dark ? [27, 31, 35] : [255, 255, 255];
      let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2])) > 60) n++;
      return n;
    });
    assert.ok(painted > 200, `${f}: canvas looks blank (${painted})`);
  }

  step = 'tabs: every opened drawing gets its own tab';
  const tabCount = () => page.locator('#tabbar .tab').count();
  assert.equal(await tabCount(), 1 + fixtures.length); // the first (edited) drawing plus one tab per fixture
  const openFixture = async (f) => {
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+o');
    (await chooser).setFiles(path.join(ROOT, 'test', 'fixtures', f));
    await page.waitForFunction((name) => window.app.file.name === name, f, { timeout: 8000 });
  };
  const before = await tabCount();
  await openFixture('basic_r2000.dxf');
  const n1 = await count();
  const view1 = await page.evaluate(() => ({ ...window.app.vp.view }));
  await openFixture('colors_r2000.dxf');
  assert.equal(await tabCount(), before + 2);
  assert.deepEqual(await page.locator('#tabbar .tab .name').evaluateAll((els) => els.slice(-2).map((e) => e.textContent)), ['basic_r2000.dxf', 'colors_r2000.dxf']);
  const n2 = await count();

  step = 'tabs: an edit in tab 2 stays in tab 2';
  await typeCmd('l'); await typeCmd('0,0'); await typeCmd('10,10'); await page.keyboard.press('Escape');
  assert.equal(await count(), n2 + 1);
  assert.equal(await page.locator('#tabbar .tab.active.dirty').count(), 1);
  await page.keyboard.press('Control+Shift+Tab');
  assert.equal(await page.evaluate(() => window.app.file.name), 'basic_r2000.dxf');
  assert.equal(await count(), n1, 'tab 1 changed');
  assert.deepEqual(await page.evaluate(() => { const v = window.app.vp.view; return { cx: v.cx, cy: v.cy, zoom: v.zoom }; }), { cx: view1.cx, cy: view1.cy, zoom: view1.zoom }, 'tab 1 view not restored');

  step = 'tabs: undo in tab 1 does not touch tab 2';
  await page.locator('#cv').focus();
  await page.keyboard.press('Control+z');
  assert.equal(await count(), n1, 'undo in tab 1 changed tab 1');
  assert.equal(await page.evaluate(() => window.app.session.dirty), false, 'tab 1 shows unsaved changes');
  await page.keyboard.press('Control+Tab');
  assert.equal(await page.evaluate(() => window.app.file.name), 'colors_r2000.dxf');
  assert.equal(await count(), n2 + 1, 'the line drawn in tab 2 is gone');
  assert.equal(await page.locator('#tabbar .tab.active.dirty .dot').textContent(), '\u25CF');
  await page.keyboard.press('Control+z');
  assert.equal(await count(), n2, "tab 2's own undo step is gone");
  await page.keyboard.press('Control+y');
  assert.equal(await count(), n2 + 1);

  step = 'tabs: closing a drawing with unsaved changes asks first';
  await page.keyboard.press('Control+w');
  await page.locator('#dlg[open]').waitFor({ timeout: 3000 });
  assert.match(await page.locator('#dlg').textContent(), /Save changes to colors_r2000\.dxf\?/);
  await page.locator('#dlg button', { hasText: 'Cancel' }).click();
  assert.equal(await tabCount(), before + 2);
  await page.keyboard.press('Control+w');
  await page.locator('#dlg button', { hasText: "Don't save" }).click();
  await page.waitForFunction((n) => document.querySelectorAll('#tabbar .tab').length === n, before + 1, { timeout: 3000 });
  assert.equal(await page.evaluate(() => window.app.file.name), 'basic_r2000.dxf');

  step = 'tabs: a clean tab closes without asking; Ctrl+N opens a new tab';
  await page.keyboard.press('Control+w');
  await page.waitForFunction((n) => document.querySelectorAll('#tabbar .tab').length === n, before, { timeout: 3000 });
  assert.equal(await page.locator('#dlg[open]').count(), 0);
  await page.keyboard.press('Control+n');
  assert.equal(await tabCount(), before + 1);
  assert.equal(await count(), 0);

  step = 'binary DXF is rejected with a message';
  {
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+o');
    (await chooser).setFiles(path.join(ROOT, 'test', 'fixtures', 'binary_sentinel.dxf'));
    await page.waitForSelector('#dlg[open]');
    assert.match(await page.locator('#dlg').innerText(), /binary DXF/i);
    await page.locator('#dlg button.primary').click();
  }

  step = 'export SVG, PDF, PNG and save DXF produce downloads';
  for (const [menuItem, ext, check] of [['Export SVG…', 'svg', (b) => b.toString('utf8').startsWith('<?xml') || b.toString('utf8').includes('<svg')], ['Export PNG image…', 'png', (b) => b[1] === 0x50 && b[2] === 0x4e], ['Save as DXF…', 'dxf', (b) => b.toString('utf8').includes('SECTION')]]) {
    const dl = page.waitForEvent('download');
    await page.locator('#menubar .menu > button', { hasText: menuItem.startsWith('Save') ? 'File' : 'File' }).click();
    await page.locator('#menubar .drop button', { hasText: menuItem }).click();
    const d = await dl;
    const p = path.join(os.tmpdir(), `ash-e2e-${process.pid}.${ext}`);
    await d.saveAs(p);
    assert.ok(check(await fs.readFile(p)), `${ext} content`);
    await fs.rm(p, { force: true });
  }
  {
    await page.locator('#menubar .menu > button', { hasText: 'File' }).click();
    await page.locator('#menubar .drop button', { hasText: 'Plot to PDF…' }).click();
    const dl = page.waitForEvent('download');
    await page.locator('#dlg button.primary').click();
    const d = await dl;
    const p = path.join(os.tmpdir(), `ash-e2e-${process.pid}.pdf`);
    await d.saveAs(p);
    assert.equal((await fs.readFile(p)).subarray(0, 4).toString(), '%PDF');
    await fs.rm(p, { force: true });
  }

  step = 'theme: dark theme switches and is remembered; ACI 7 follows the canvas; text contrast';
  {
    const shotDir = SHOTS || await fs.mkdtemp(path.join(os.tmpdir(), 'ash-e2e-theme-'));
    const menu = async (top, item) => { await page.locator('#menubar .menu > button', { hasText: top }).click(); await page.locator('#menubar .drop button', { hasText: item }).click(); };
    // the ACI-7 line drawn by drawAci7Line() (cy offset by half a pixel so the 1px line is crisp): returns the line pixel (most different from the background) and the background
    const aci7Line = async () => {
      await page.evaluate(() => { const vp = window.app.vp; vp.view = { ...vp.view, cx: 50, cy: 0.125, zoom: 4 }; vp.selection.clear(); vp.render(); });
      await page.mouse.move(2, 2);
      return page.evaluate(() => {
        const vp = window.app.vp; vp.showCross = false; vp.render();
        const s = vp.toScreen({ x: 50, y: 0 }), k = vp.dpr;
        const px = vp.ctx.getImageData(Math.round(s.x * k) - 3, Math.round(s.y * k) - 3, 7, 7).data, bg = vp.ctx.getImageData(3, 3, 1, 1).data;
        let best = null, bd = -1;
        for (let i = 0; i < px.length; i += 4) { const dd = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]); if (dd > bd) { bd = dd; best = [px[i], px[i + 1], px[i + 2]]; } }
        return { line: best, bg: [bg[0], bg[1], bg[2]] };
      });
    };
    const drawAci7Line = async () => {
      await page.evaluate(() => { const l = window.app.doc.layers.get('0'); if (l) l.color = 7; window.app.state.layer = '0'; window.app.state.color = 256; });
      await page.click('#tools button[data-tool=line]');
      await typeCmd('0,0'); await typeCmd('100,0'); await page.keyboard.press('Escape');
      await page.click('#tools button[data-tool=select]');
    };
    // minimum WCAG contrast of every text-bearing element under the selectors, against its effective background
    const minContrast = (sels) => page.evaluate((list) => {
      const rgb = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { c: m.slice(0, 3), a: m.length > 3 ? m[3] : 1 }; };
      const L = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bgOf = (n) => { for (; n; n = n.parentElement) { const b = rgb(getComputedStyle(n).backgroundColor); if (b.a > 0.5) return b.c; } return [255, 255, 255]; };
      let worst = { ratio: Infinity, what: '' }, n = 0;
      for (const sel of list) for (const root of document.querySelectorAll(sel)) for (const e of [root, ...root.querySelectorAll('*')]) {
        if (![...e.childNodes].some((t) => t.nodeType === 3 && t.textContent.trim())) continue;
        if (!e.getClientRects().length) continue;
        n++;
        const a = L(rgb(getComputedStyle(e).color).c), b = L(bgOf(e)), r = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        if (r < worst.ratio) worst = { ratio: r, what: `${sel} ${e.tagName}#${e.id}.${e.className} "${e.textContent.trim().slice(0, 30)}"` };
      }
      return { ...worst, n };
    }, sels);
    const checkContrast = async (theme) => {
      await page.locator('#menubar .menu > button', { hasText: 'View' }).click();
      const m = await minContrast(['#menubar', '#status', '#cmdbar']);
      await shot(`theme_${theme}_menu`); await page.screenshot({ path: path.join(shotDir, `theme_${theme}.png`) });
      await page.keyboard.press('Escape'); await page.mouse.click(700, 400);
      const opened = page.evaluate(() => window.app.limitations());
      await page.waitForSelector('#dlg[open]');
      const d = await minContrast(['#dlg']);
      await page.screenshot({ path: path.join(shotDir, `theme_${theme}_dialog.png`) });
      await page.locator('#dlg button.primary').click(); await opened;
      for (const [where, r] of [['menu/status', m], ['dialog', d]]) assert.ok(r.n > 3 && r.ratio >= 4.5, `${theme} ${where} contrast ${r.ratio.toFixed(2)} at ${r.what}`);
    };

    // the PDF export may leave its warnings message open
    await page.waitForTimeout(300);
    if (await page.locator('#dlg[open]').count()) await page.locator('#dlg button.primary').click();
    // light (default): ACI 7 is dark on the white canvas
    await page.evaluate(() => window.app.newDrawing(true));
    await drawAci7Line();
    let px = await aci7Line();
    assert.ok(lum(px.bg) > 0.9 && lum(px.line) < 0.2, `light canvas: ACI 7 ${px.line} on ${px.bg}`);
    await checkContrast('light');

    // View > Dark theme: whole UI dark, canvas dark, ACI 7 light, remembered after a reload
    await menu('View', 'Dark theme');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.ok(lum(rgbOf(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))) < 0.05);
    page.once('dialog', (d) => d.accept()); // drawings with unsaved changes are still open in other tabs: leave anyway
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.app && window.app.doc && document.documentElement.dataset.theme === 'dark', null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.app.vp.settings.dark), true);
    assert.equal(await page.locator('#theme-btn.on').count(), 1);
    await drawAci7Line();
    px = await aci7Line();
    assert.ok(lum(px.bg) < 0.05 && lum(px.line) > 0.8, `dark canvas: ACI 7 ${px.line} on ${px.bg}`);
    await checkContrast('dark');

    // the canvas-only override still works inside a theme
    await menu('View', 'Light / dark background');
    px = await aci7Line();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.ok(lum(px.bg) > 0.9 && lum(px.line) < 0.2, `dark theme, light canvas: ACI 7 ${px.line} on ${px.bg}`);
    await menu('View', 'Light / dark background');

    // back to light from the status bar toggle; that choice is saved too
    await page.click('#theme-btn');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? 'light'), 'light');
    assert.equal(await page.evaluate(() => window.api.settingsGet('theme')), 'light');
    if (!SHOTS) await fs.rm(shotDir, { recursive: true, force: true });
  }

  step = 'about logo';
  {
    const menu = async (top, item) => { await page.locator('#menubar .menu > button', { hasText: top }).click(); await page.locator('#menubar .drop button', { hasText: item }).click(); };
    const aboutLogo = async (theme) => {
      await menu('Help', 'About');
      await page.waitForSelector('.about-logo', { state: 'attached' });
      const r = await page.evaluate(() => [...document.querySelectorAll('img.about-logo')].filter((i) => i.offsetParent !== null).map((i) => [i.complete, i.naturalWidth, i.getAttribute('src')]));
      assert.ok(r.length === 1 && r[0][0] && r[0][1] > 0, `About logo not loaded (${theme}): ${JSON.stringify(r)}`);
      assert.ok(r[0][2].includes(theme === 'dark' ? 'reversed' : 'horizontal.svg'), `wrong About logo variant for ${theme}`);
      await page.keyboard.press('Escape');
    };
    await aboutLogo('light');
    await page.evaluate(() => window.app.setTheme('dark'));
    await aboutLogo('dark');
    await page.evaluate(() => window.app.setTheme('light'));
  }

  step = 'layers: LAYISO / LAYUNISO, freeze hides objects, On/Off keeps the frozen flag through save and reopen';
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const doc = M.newDocument();
    for (const n of ['WALL', 'DUCT']) M.addLayer(doc, { name: n });
    M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }, { layer: 'WALL' }));
    M.addEntity(doc, M.makeLine({ x: 0, y: 5 }, { x: 10, y: 5 }, { layer: 'DUCT' }));
    window.app.installDoc(doc, { path: null, name: 'layers.dxf', format: 'dxf' });
  });
  const lay = () => page.evaluate(() => Object.fromEntries([...window.app.doc.layers.values()].map((l) => [l.name, `${l.visible ? 'on' : 'off'}${l.frozen ? '+frozen' : ''}`])));
  const shown = () => page.evaluate(() => [[5, 0], [5, 5]].map(([x, y]) => window.app.vp.pick({ x, y }, { tol: 1 })?.layer).filter(Boolean).join(','));
  await page.evaluate(() => window.app.vp.setSelection([window.app.doc.entities[0].id]));
  await typeCmd('layiso');
  assert.deepEqual(await lay(), { 0: 'off', WALL: 'on', DUCT: 'off' });
  await typeCmd('layuniso');
  assert.deepEqual(await lay(), { 0: 'on', WALL: 'on', DUCT: 'on' });
  const row = (n) => page.locator('#layers .layer', { has: page.locator('.lname', { hasText: new RegExp(`^${n}$`) }) });
  await row('DUCT').locator('button.lay-frz').click();
  assert.equal(await shown(), 'WALL', 'objects on a frozen layer are hidden');
  await row('DUCT').locator('button.lay-on').click();
  assert.deepEqual(await lay(), { 0: 'on', WALL: 'on', DUCT: 'off+frozen' }, 'On/Off must not thaw the layer');
  const reread = await page.evaluate(async () => {
    const { writeDxf } = await import('/src/core/dxfWrite.js'); const { readDxf } = await import('/src/core/dxfRead.js');
    const l = readDxf(new TextEncoder().encode(writeDxf(window.app.doc))).layers.get('DUCT');
    return [l.visible, l.frozen];
  });
  assert.deepEqual(reread, [false, true], 'DUCT off + frozen after save and reopen');

  step = 'find and replace: Ctrl+F, results, click selects, Replace all, Undo';
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const doc = M.newDocument();
    M.addEntity(doc, M.makeText({ x: 0, y: 0 }, 2, 'PUMP P-101'));
    M.addEntity(doc, M.makeMText({ x: 0, y: 20 }, 2, '{\\C1;Pump} room\\Pspare pump'));
    M.addEntity(doc, M.makeText({ x: 50, y: 0 }, 2, 'PUMPS'));
    M.addEntity(doc, M.makeLine({ x: 0, y: -10 }, { x: 100, y: -10 }));
    window.app.installDoc(doc, { path: null, name: 'find.dxf', format: 'dxf' });
  });
  await page.locator('#cv').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+f');
  await page.waitForSelector('#find-panel:not([hidden])');
  await page.locator('#find-word').check();
  await page.locator('#find-q').fill('pump');
  assert.equal(await page.locator('#find-panel .find-row').count(), 3);
  assert.match(await page.locator('#find-panel .find-count').innerText(), /3 matches/);
  await page.locator('#find-panel .find-row').nth(1).click();
  const mtextId = await page.evaluate(() => window.app.doc.entities[1].id);
  assert.deepEqual(await page.evaluate(() => [...window.app.vp.selection]), [mtextId], 'clicked result is selected');
  await page.locator('#find-q').press('Enter'); // find next
  assert.equal(await page.locator('#find-panel .find-row.cur').count(), 1);
  await page.locator('#find-r').fill('FAN');
  await page.locator('#find-all').click();
  const texts = () => page.evaluate(() => window.app.doc.entities.filter((e) => e.text != null).map((e) => e.text));
  assert.deepEqual(await texts(), ['FAN P-101', '{\\C1;FAN} room\\Pspare FAN', 'PUMPS']);
  assert.equal(await page.locator('#find-panel .find-row').count(), 0, 'results refresh after Replace all');
  await page.locator('#find-q').press('Escape');
  assert.equal(await page.locator('#find-panel').isHidden(), true);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await texts(), ['PUMP P-101', '{\\C1;Pump} room\\Pspare pump', 'PUMPS'], 'one Undo restores every replaced text');

  step = 'measure: AREA object / add / subtract, MEA distance / radius / angle';
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const doc = M.newDocument();
    M.addEntity(doc, M.makeRect({ x: 0, y: 0 }, { x: 100, y: 50 }));   // 5000, perimeter 300
    M.addEntity(doc, M.makeRect({ x: 150, y: 0 }, { x: 210, y: 40 })); // 2400
    M.addEntity(doc, M.makeCircle({ x: 260, y: 20 }, 10));
    window.app.installDoc(doc, { path: null, name: 'measure.dxf', format: 'dxf' });
    window.app.vp.zoomExtents();
  });
  const panel = () => page.locator('#measure-panel .mp-body').textContent();
  await typeCmd('area'); await typeCmd('o'); await clickWorld(50, 0);
  assert.match(await panel(), /^Area = 5000, Perimeter = 300$/m);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.app.toolId), 'select', 'Esc ends AREA');
  assert.equal(await page.locator('#measure-panel').count(), 1, 'results panel stays after the command ends');
  await typeCmd('area'); await typeCmd('a'); await typeCmd('o'); await clickWorld(50, 0); await clickWorld(180, 0);
  assert.match(await panel(), /^Total area = 7400$/m, 'Add: running total of both rectangles');
  await page.keyboard.press('Escape');
  await typeCmd('area'); await typeCmd('a'); await typeCmd('o'); await clickWorld(50, 0);
  await typeCmd('s'); await typeCmd('o'); await clickWorld(180, 0);
  assert.match(await panel(), /^Total area = 2600$/m, 'Subtract: 5000 - 2400');
  await page.keyboard.press('Escape');
  await typeCmd('mea'); await clickWorld(0.6, 0.4); await clickWorld(99.5, 49.6); // snapped to the corners
  assert.match(await panel(), /^Distance = 111\.8034$/m);
  assert.match(await panel(), /^Delta X = 100, Delta Y = 50$/m);
  await typeCmd('r'); await clickWorld(270, 20);
  assert.match(await panel(), /^Radius = 10$/m);
  await typeCmd('n'); await clickWorld(50, 0); await clickWorld(0, 25);
  assert.match(await panel(), /^Angle = 90°$/m);
  await page.keyboard.press('Escape');
  await page.locator('#measure-panel .mp-close').click();
  assert.equal(await page.locator('#measure-panel').count(), 0, 'Close removes the panel');

  step = 'modify tools: FILLET R 5 on two perpendicular lines';
  await typeCmd('new');
  assert.equal(await count(), 0);
  await page.evaluate(() => { const vp = window.app.vp; vp.view = { ...vp.view, cx: 50, cy: 25, zoom: 8 }; vp.render(); });
  const ents = () => page.evaluate(() => window.app.doc.entities.map((e) => ({ ...e, len: e.type === 'LINE' ? Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y) : null })));
  const lens = async () => (await ents()).filter((e) => e.type === 'LINE').map((e) => Math.round(e.len * 1e6) / 1e6).sort((x, y) => x - y);
  const near = (x, y, msg) => assert.ok(Math.abs(x - y) < 1e-6, `${msg}: ${x} != ${y}`);
  await typeCmd('l'); await typeCmd('0,0'); await typeCmd('40,0'); await typeCmd('');
  await typeCmd('l'); await typeCmd('0,0'); await typeCmd('0,30'); await typeCmd('');
  await typeCmd('f'); await typeCmd('r'); await typeCmd('5');
  await clickWorld(20, 0); await clickWorld(0, 15);
  const arc = (await ents()).find((e) => e.type === 'ARC');
  assert.ok(arc, 'FILLET made no arc');
  near(arc.r, 5, 'fillet radius');
  assert.deepEqual(await lens(), [25, 35], 'lines trimmed to the fillet');
  step = 'modify tools: undo the fillet';
  await page.keyboard.press('Control+z');
  assert.deepEqual(await types(), ['LINE', 'LINE']);
  assert.deepEqual(await lens(), [30, 40]);
  step = 'modify tools: FILLET remembers its radius per drawing';
  await typeCmd('f');
  assert.match(await page.locator('#prompt').textContent(), /radius 5\b/);
  await page.keyboard.press('Escape');

  step = 'modify tools: CHAMFER 2';
  await typeCmd('cha'); await typeCmd('d'); await typeCmd('2'); await typeCmd('2');
  await clickWorld(20, 0); await clickWorld(0, 15);
  assert.deepEqual(await lens(), [Math.round(2 * Math.SQRT2 * 1e6) / 1e6, 28, 38]);

  step = 'modify tools: BREAK between two points, JOIN back, LENGTHEN DE 10';
  const onY50 = async () => (await ents()).filter((e) => e.type === 'LINE' && e.p1.y === 50 && e.p2.y === 50);
  await typeCmd('l'); await typeCmd('10,50'); await typeCmd('70,50'); await typeCmd('');
  await typeCmd('br'); await clickWorld(20, 50); await typeCmd('30,50');
  assert.equal((await onY50()).length, 2, 'BREAK gives two lines');
  await page.evaluate((ids) => window.app.vp.setSelection(ids), (await onY50()).map((e) => e.id));
  await typeCmd('j');
  assert.equal((await onY50()).length, 1, 'JOIN gives one line');
  near((await onY50())[0].len, 60, 'joined length');
  await typeCmd('len'); await typeCmd('de'); await typeCmd('10'); await clickWorld(65, 50); await typeCmd('');
  near((await onY50())[0].len, 70, 'lengthened by 10');

  step = 'modify tools: ARRAYRECT 2 x 3 and ARRAYPOLAR 4';
  const circles = async () => (await ents()).filter((e) => e.type === 'CIRCLE');
  await typeCmd('c'); await typeCmd('90,10'); await typeCmd('2');
  const circleId = (await circles())[0].id;
  await page.evaluate((id) => window.app.vp.setSelection([id]), circleId);
  await typeCmd('ar');
  for (const [k, v] of [['rows', '2'], ['cols', '3'], ['rowSpacing', '6'], ['colSpacing', '6']]) await page.locator(`#dlg input[name=${k}]`).fill(v);
  await page.locator('#dlg button.primary').click();
  assert.equal((await circles()).length, 6, 'ARRAYRECT 2x3');
  await page.evaluate((id) => window.app.vp.setSelection([id]), circleId);
  await typeCmd('arraypolar'); await typeCmd('80,30');
  await page.locator('#dlg input[name=count]').fill('4');
  await page.locator('#dlg button.primary').click();
  assert.equal((await circles()).length, 9, 'ARRAYPOLAR adds 3 copies (4 items)');

  step = 'modify tools: STRETCH the right edge of a rectangle';
  await typeCmd('rec'); await typeCmd('20,10'); await typeCmd('@30,20');
  await typeCmd('stretch'); await typeCmd('45,5'); await typeCmd('55,35'); await typeCmd('0,0'); await typeCmd('@10,0');
  const xs = (await ents()).find((e) => e.type === 'LWPOLYLINE').vertices.map((q) => q.x);
  near(Math.max(...xs) - Math.min(...xs), 40, 'rectangle width after STRETCH');

  step = 'dimensions: DLI on a 100-long line, DCO 50 further, DRA on a circle r 25';
  await typeCmd('new');
  await page.evaluate(() => { const vp = window.app.vp; vp.view = { ...vp.view, cx: 60, cy: -20, zoom: 4 }; vp.render(); });
  const dims = () => page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'DIMENSION').map((e) => ({ m: e.measurement, t: e.dimText, layer: e.layer })));
  await typeCmd('l'); await typeCmd('0,0'); await typeCmd('100,0'); await typeCmd('');
  await typeCmd('dli'); await typeCmd('0,0'); await typeCmd('100,0'); await typeCmd('50,20');
  assert.deepEqual(await dims(), [{ m: 100, t: '100', layer: '0' }]);
  await typeCmd('dco'); await typeCmd('150,0'); await typeCmd('');
  assert.deepEqual((await dims()).map((d) => d.t), ['100', '50']);
  await typeCmd('c'); await typeCmd('0,-60'); await typeCmd('25');
  await typeCmd('dra'); await clickWorld(25, -60); await typeCmd('40,-60');
  assert.deepEqual((await dims()).map((d) => d.t), ['100', '50', 'R25']);
  await shot('dimensions');

  step = 'dimensions: style decimals 2 regenerates the texts; Undo restores';
  await page.evaluate(async () => {
    const { setDimStyle } = await import('/src/core/edit.js'); const { resolveDimStyle } = await import('/src/core/dimsStyle.js');
    const st = resolveDimStyle(window.app.doc, 'ISO-25');
    setDimStyle(window.app.session, st.name, { ...st, DIMDEC: 2, DIMZIN: 0, DIMDSEP: 46 });
  });
  assert.deepEqual((await dims()).map((d) => d.t), ['100.00', '50.00', 'R25.00']);
  await page.keyboard.press('Control+z');
  assert.deepEqual((await dims()).map((d) => d.t), ['100', '50', 'R25']);

  step = 'dimensions: save DXF and reopen keeps the dimensions';
  const reopened = await page.evaluate(async () => {
    const { writeDxf } = await import('/src/core/dxfWrite.js'); const { readDxf } = await import('/src/core/dxfRead.js');
    const back = readDxf(new TextEncoder().encode(writeDxf(window.app.doc)));
    return back.entities.filter((e) => e.type === 'DIMENSION').map((e) => back.blocks.get(e.block)?.entities.find((x) => x.type === 'MTEXT')?.text);
  });
  assert.deepEqual(reopened, ['100', '50', 'R25']);

  step = 'grips: drag a line end grip to a snapped endpoint, undo';
  await page.evaluate(() => { const vp = window.app.vp; vp.setSelection([]); vp.view = { ...vp.view, cx: 260, cy: 210, zoom: 8 }; vp.render(); });
  await typeCmd('l'); await typeCmd('200,200'); await typeCmd('240,200'); await typeCmd('');
  await typeCmd('l'); await typeCmd('200,225'); await typeCmd('260,225'); await typeCmd('');
  const byP1 = async (x, y) => (await ents()).find((e) => e.type === 'LINE' && e.p1.x === x && e.p1.y === y);
  const gl = await byP1(200, 200);
  await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => window.app.toolId), 'select');
  await page.evaluate((id) => window.app.vp.setSelection([id]), gl.id);
  const scr = async (x, y) => { const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]); const box = await page.locator('#cv').boundingBox(); return { x: box.x + s.x, y: box.y + s.y }; };
  let s0 = await scr(240, 200), s1 = await scr(259.6, 224.7);
  await page.mouse.move(s0.x, s0.y); await page.mouse.down();
  await page.mouse.move((s0.x + s1.x) / 2, (s0.y + s1.y) / 2, { steps: 3 }); await page.mouse.move(s1.x, s1.y, { steps: 3 }); await page.mouse.up();
  let gle = (await ents()).find((e) => e.id === gl.id);
  assert.deepEqual([gle.p2.x, gle.p2.y], [260, 225], 'end grip snapped to the other line end');
  await page.keyboard.press('Control+z');
  gle = (await ents()).find((e) => e.id === gl.id);
  assert.deepEqual([gle.p2.x, gle.p2.y], [240, 200], 'undo restores the end');

  step = 'grips: circle quadrant grip (click, then typed point) changes the radius';
  await typeCmd('c'); await typeCmd('300,200'); await typeCmd('10');
  const gc = (await ents()).find((e) => e.type === 'CIRCLE' && e.c.x === 300);
  await page.keyboard.press('Escape');
  await page.evaluate((id) => window.app.vp.setSelection([id]), gc.id);
  s0 = await scr(310, 200); await page.mouse.click(s0.x, s0.y);
  assert.match(await page.locator('#prompt').textContent(), /STRETCH/);
  await typeCmd('325,200');
  near((await ents()).find((e) => e.id === gc.id).r, 25, 'radius after quadrant grip');

  step = 'properties palette: circle radius 30';
  await page.evaluate((id) => window.app.vp.setSelection([id]), gc.id);
  await page.locator('#props input[data-prop="Radius"]').fill('30');
  await page.locator('#props input[data-prop="Radius"]').press('Enter');
  near((await ents()).find((e) => e.id === gc.id).r, 30, 'radius set in the palette');
  await page.keyboard.press('Escape');

  step = 'MATCHPROP: red line on layer A onto blue line on layer B';
  await typeCmd('l'); await typeCmd('200,180'); await typeCmd('240,180'); await typeCmd('');
  await typeCmd('l'); await typeCmd('200,170'); await typeCmd('240,170'); await typeCmd('');
  const ma1 = await byP1(200, 180), ma2 = await byP1(200, 170);
  await page.keyboard.press('Escape');
  await page.evaluate(async ([a, b]) => {
    const { setEntityProps } = await import('/src/core/edit.js');
    setEntityProps(window.app.session, [a], { layer: 'A', color: 1 }); setEntityProps(window.app.session, [b], { layer: 'B', color: 5 });
  }, [ma1.id, ma2.id]);
  await typeCmd('ma'); await clickWorld(220, 180); await clickWorld(220, 170); await typeCmd('');
  const mad = (await ents()).find((e) => e.id === ma2.id);
  assert.deepEqual([mad.layer, mad.color], ['A', 1], 'destination took the source layer and colour');
  assert.equal(await page.evaluate(() => window.app.toolId), 'select');

  step = 'csp';
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.deepEqual(problems, []);
  console.log('draw e2e: OK');
} catch (err) {
  console.error(`draw e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
