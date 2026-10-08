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
  // One permanent 'filechooser' listener. page.waitForEvent() per dialog toggles Playwright's chooser interception on and
  // off around every call, and a chooser opened right after such a toggle is sometimes lost (the page's input.click() ran,
  // no event ever arrived). Keeping the interception on for the whole run removes that window.
  let chooserWaiter = null;
  page.on('filechooser', (c) => { const w = chooserWaiter; chooserWaiter = null; w?.(c); });
  const pickFile = async (f) => {
    const chooser = new Promise((r) => { chooserWaiter = r; });
    await page.keyboard.press('Control+o');
    await (await chooser).setFiles(path.join(ROOT, 'test', 'fixtures', f));
  };
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
    await pickFile(f);
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
    await pickFile(f);
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

  step = 'dialogs: a button click does not cancel the dialog opened right after it';
  {
    // close() queues its 'close' event; it used to arrive after the next modal() had installed its handler and cancelled it
    const r = await page.evaluate(async () => {
      const { modal } = await import('/renderer/ui.js');
      const first = modal('one', 'x', [{ label: 'A', value: 'a', primary: true }]);
      document.querySelector('#dlg button').click();
      let second = 'pending';
      const p2 = modal('two', 'y', [{ label: 'B', value: 'b', primary: true }]).then((v) => { second = v; });
      await new Promise((res) => setTimeout(res, 50)); // let the stale close event fire
      const during = second;
      document.querySelector('#dlg button').click(); await p2;
      return { first: await first, during, second };
    });
    assert.deepEqual(r, { first: 'a', during: 'pending', second: 'b' });
  }

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
    await pickFile('binary_sentinel.dxf');
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
  const nearPt = (p, x, y, msg = 'point') => { near(p.x, x, `${msg} x`); near(p.y, y, `${msg} y`); };
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

  step = 'DIMORDINATE: DOR, click a point, click above: vertical leader = X datum, text is the X coordinate';
  await typeCmd('dor'); await clickWorld(62.5, -30); await clickWorld(62.5, -10);
  const ord = (await page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'DIMENSION').at(-1)).then((e) => ({ k: e.def.kind, x: e.def.xType, t: e.dimText, m: e.measurement, dt: e.dimType })));
  assert.deepEqual(ord, { k: 'ordinate', x: true, t: '62,5', m: 62.5, dt: 70 });
  await page.keyboard.press('Control+z'); // leave the drawing as the following steps expect it
  assert.equal((await dims()).length, 3);

  step = 'DIMANGULAR: two lines at 90 degrees, then 3-point (Enter) at 45 degrees';
  const dimTexts = () => page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'DIMENSION').map((e) => e.dimText));
  await page.evaluate(() => { const vp = window.app.vp; vp.setSelection([]); vp.view = { ...vp.view, cx: 70, cy: -150, zoom: 4 }; vp.render(); });
  await typeCmd('l'); await typeCmd('0,-150'); await typeCmd('40,-150'); await typeCmd('');
  await typeCmd('l'); await typeCmd('0,-150'); await typeCmd('0,-110'); await typeCmd('');
  await typeCmd('dan'); await clickWorld(20, -150); await clickWorld(0, -130); await typeCmd('15,-135');
  assert.equal((await dimTexts()).at(-1), '90°');
  await typeCmd('dan'); await typeCmd(''); await typeCmd('100,-150'); await typeCmd('140,-150'); await typeCmd('140,-110'); await typeCmd('125,-145');
  assert.equal((await dimTexts()).at(-1), '45°');

  step = 'DIMSTYLE: New "ASH-1" from ISO-25 (text 5, 2 decimals, period), set current, DLI shows 100.00';
  const dlgBtn = (t) => page.locator('#dlg button', { hasText: t }).first();
  await typeCmd('d');
  await page.locator('#dlg select[name=styles]').selectOption('ISO-25');
  await dlgBtn('New').click();
  await page.locator('#dlg input').fill('ASH-1'); await page.locator('#dlg button.primary').click();
  await page.locator('#dlg input[name=DIMTXT]').fill('5'); await page.locator('#dlg input[name=DIMDEC]').fill('2');
  await page.locator('#dlg select[name=DIMDSEP]').selectOption('46'); await page.locator('#dlg input[name=DIMZIN]').uncheck();
  await page.locator('#dlg button.primary').click();
  assert.equal(await page.locator('#dlg select[name=styles]').inputValue(), 'ASH-1');
  await dlgBtn('Set current').click(); await dlgBtn('Close').click();
  assert.equal(await page.locator('#dimstyle').inputValue(), 'ASH-1');
  await typeCmd('dli'); await typeCmd('0,-200'); await typeCmd('100,-200'); await typeCmd('50,-190');
  const ash = await page.evaluate(() => { const d = window.app.doc, e = d.entities.at(-1); return { t: e.dimText, style: e.style, h: d.blocks.get(e.block).entities.find((x) => x.type === 'MTEXT')?.height }; });
  assert.deepEqual(ash, { t: '100.00', style: 'ASH-1', h: 5 });

  step = 'DIMSTYLE: Modify ISO-25 decimals regenerates its dimensions; Undo restores';
  await typeCmd('d');
  await page.locator('#dlg select[name=styles]').selectOption('ISO-25');
  await dlgBtn('Modify').click();
  await page.locator('#dlg input[name=DIMDEC]').fill('3'); await page.locator('#dlg input[name=DIMZIN]').uncheck();
  await page.locator('#dlg button.primary').click(); await dlgBtn('Close').click();
  assert.deepEqual(await dimTexts(), ['100,000', '50,000', 'R25,000', '90°', '45°', '100.00']);
  await typeCmd('u');
  assert.deepEqual(await dimTexts(), ['100', '50', 'R25', '90°', '45°', '100.00']);

  step = 'DIMSTYLE: save DXF and reopen keeps the current style';
  assert.equal(await page.evaluate(async () => {
    const { writeDxf } = await import('/src/core/dxfWrite.js'); const { readDxf } = await import('/src/core/dxfRead.js'); const { dimVarsOf } = await import('/renderer/tools-dims.js');
    return dimVarsOf(readDxf(new TextEncoder().encode(writeDxf(window.app.doc)))).style;
  }), 'ASH-1');

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

  step = 'MATCHPROP Settings: untick Layer -> destination keeps its layer, takes the colour';
  await page.evaluate(() => { const vp = window.app.vp; vp.view = { ...vp.view, cx: 240, cy: 155, zoom: 8 }; vp.render(); });
  await typeCmd('l'); await typeCmd('200,160'); await typeCmd('240,160'); await typeCmd('');
  const ma3 = await byP1(200, 160);
  await page.keyboard.press('Escape');
  await page.evaluate(async (b) => { const { setEntityProps } = await import('/src/core/edit.js'); setEntityProps(window.app.session, [b], { layer: 'B', color: 5 }); }, ma3.id);
  await typeCmd('ma'); await clickWorld(220, 180);
  assert.match(await page.locator('#prompt').textContent(), /S = settings/);
  await typeCmd('s');
  await page.locator('#dlg input[name=layer]').uncheck();
  assert.equal(await page.locator('#dlg input[type=checkbox]:checked').count(), await page.locator('#dlg input[type=checkbox]').count() - 1);
  await page.locator('#dlg button.primary').click();
  await clickWorld(220, 160); await typeCmd('');
  const mad3 = (await ents()).find((e) => e.id === ma3.id);
  assert.deepEqual([mad3.layer, mad3.color], ['B', 1], 'layer kept (setting off), colour copied');

  step = 'grip modes: end grip, Space twice -> ROTATE, 90 -> rotated about that grip';
  await typeCmd('l'); await typeCmd('200,150'); await typeCmd('240,150'); await typeCmd('');
  const gr = await byP1(200, 150);
  await page.keyboard.press('Escape');
  await page.evaluate((id) => window.app.vp.setSelection([id]), gr.id);
  s0 = await scr(240, 150); await page.mouse.click(s0.x, s0.y);
  assert.match(await page.locator('#prompt').textContent(), /\*\* STRETCH \*\*/);
  await page.keyboard.press('Space');
  assert.match(await page.locator('#prompt').textContent(), /\*\* MOVE \*\*/);
  await page.keyboard.press('Space');
  assert.match(await page.locator('#prompt').textContent(), /\*\* ROTATE \*\*/);
  await typeCmd('90');
  let grl = (await ents()).find((e) => e.id === gr.id);
  near(grl.p1.x, 240, 'rotated p1.x'); near(grl.p1.y, 110, 'rotated p1.y'); near(grl.p2.x, 240, 'p2 (base) x'); near(grl.p2.y, 150, 'p2 (base) y');
  assert.doesNotMatch(await page.locator('#prompt').textContent(), /\*\*/, 'grip mode ends after one rotate');

  step = 'grip MOVE + Copy: two copies, Esc, one undo removes both (whole grip command = one undo step)';
  const n0 = await count();
  await page.evaluate((id) => window.app.vp.setSelection([id]), gr.id);
  s0 = await scr(240, 150); await page.mouse.click(s0.x, s0.y);
  await page.keyboard.press('Space');
  await typeCmd('c');
  assert.match(await page.locator('#prompt').textContent(), /\*\* MOVE \(multiple\) \*\*/);
  await typeCmd('@10,0'); await typeCmd('@20,0');
  assert.equal(await count(), n0 + 2, 'two copies made');
  await page.keyboard.press('Escape');
  assert.doesNotMatch(await page.locator('#prompt').textContent(), /\*\*/);
  grl = (await ents()).find((e) => e.id === gr.id);
  near(grl.p2.x, 240, 'original stays');
  await page.keyboard.press('Control+z');
  assert.equal(await count(), n0, 'one undo removes both copies');
  near((await ents()).find((e) => e.id === gr.id).p1.y, 110, 'the earlier rotate is a separate step');
  await page.keyboard.press('Escape');

  step = 'blocks: ATTDEF + BLOCK (convert) + INSERT with attribute values';
  await typeCmd('new');
  await page.evaluate(() => { const vp = window.app.vp; vp.view = { ...vp.view, cx: 60, cy: 30, zoom: 6 }; vp.render(); });
  const dlgOk = () => page.locator('#dlg button.primary').click();
  await typeCmd('rec'); await typeCmd('0,0'); await typeCmd('20,10');
  await typeCmd('att');
  await page.locator('#dlg input[name=tag]').fill('TAG1'); await page.locator('#dlg input[name=default]').fill('X');
  await page.locator('#dlg input[name=height]').fill('2'); await dlgOk();
  await typeCmd('5,4');
  assert.deepEqual(await types(), ['LWPOLYLINE', 'TEXT']);
  await page.evaluate(() => window.app.vp.setSelection(window.app.doc.entities.map((e) => e.id)));
  await typeCmd('b');
  await page.locator('#dlg input[name=name]').fill('TAGBOX'); await dlgOk();
  assert.deepEqual(await types(), ['INSERT'], 'convert replaces the objects by an INSERT');
  const insVals = () => page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'INSERT').map((e) => ({ id: e.id, p: e.p, rot: e.rot, a: e.attribs?.map((x) => ({ text: x.text, p: x.p, rot: x.rot })) })));
  assert.equal((await insVals())[0].a[0].text, 'X');
  for (const [pt, v] of [['100,0', 'A'], ['100,50', 'B']]) {
    await typeCmd('i');
    assert.equal(await page.locator('#dlg select[name=block]').inputValue(), 'TAGBOX');
    assert.ok(await page.evaluate(() => { const c = document.querySelector('#dlg canvas.block-thumb'); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((x) => x); }), 'preview thumbnail drawn');
    await dlgOk(); await typeCmd(pt);
    await page.locator('#dlg input[name=att-TAG1]').fill(v); await dlgOk();
  }
  let iv = await insVals();
  assert.deepEqual(iv.map((x) => x.a[0].text), ['X', 'A', 'B']);
  nearPt(iv[2].a[0].p, 105, 54);

  step = 'blocks: double-click an INSERT edits its attribute, one undo step';
  await page.keyboard.press('Escape');
  const sB = await scr(110, 50);
  await page.mouse.dblclick(sB.x, sB.y);
  await page.locator('#dlg[open] input[name=att-TAG1]').fill('C'); await dlgOk();
  assert.equal((await insVals())[2].a[0].text, 'C');
  await page.keyboard.press('Control+z');
  assert.equal((await insVals())[2].a[0].text, 'B', 'undo restores B');

  step = 'blocks: rotation set in Properties carries the attribute';
  await page.evaluate((id) => window.app.vp.setSelection([id]), iv[2].id);
  await page.locator('#props input[data-prop="Rotation"]').fill('90');
  await page.locator('#props input[data-prop="Rotation"]').press('Enter');
  iv = await insVals();
  near(iv[2].rot, 90, 'insert rotation'); near(iv[2].a[0].rot, 90, 'attribute rotation'); nearPt(iv[2].a[0].p, 96, 55);
  await page.keyboard.press('Escape');

  step = 'blocks: attribute values survive save DXF + reopen';
  {
    const dl = page.waitForEvent('download');
    await page.locator('#menubar .menu > button', { hasText: 'File' }).click();
    await page.locator('#menubar .drop button', { hasText: 'Save as DXF…' }).click();
    const fname = `ash-e2e-blocks-${process.pid}.dxf`, p = path.join(os.tmpdir(), fname);
    await (await dl).saveAs(p);
    const chooser = new Promise((r) => { chooserWaiter = r; });
    await page.keyboard.press('Control+o');
    await (await chooser).setFiles(p);
    await page.waitForFunction((n) => window.app.file.name === n, fname, { timeout: 8000 });
    await fs.rm(p, { force: true });
    iv = await insVals();
    assert.deepEqual(iv.map((x) => x.a[0].text), ['X', 'A', 'B']);
    near(iv[2].a[0].rot, 90, 'attribute rotation after reopen');
  }


  step = 'MTEXT editor: MT two corners, Bold, Enter, Ctrl+Enter';
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const vp = window.app.vp; vp.view = { ...vp.view, cx: 600, cy: 600, zoom: 4 }; vp.selection.clear(); vp.render(); });
  const mtexts = () => page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'MTEXT').map((e) => ({ id: e.id, text: e.text, p: e.p })));
  const mtBefore = (await mtexts()).length;
  const ed = '.mt-editor .mt-edit';
  const selectText = (needle) => page.evaluate(([sel, t]) => {
    const root = document.querySelector(sel), w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(t);
      if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + t.length); getSelection().removeAllRanges(); getSelection().addRange(r); return true; }
    }
    return false;
  }, [ed, needle]);
  await typeCmd('mt'); await clickWorld(580, 620); await clickWorld(640, 590);
  await page.locator(ed).waitFor();
  await page.keyboard.type('Hello');
  assert.ok(await selectText('Hello'));
  await page.locator('.mt-toolbar [data-cmd="bold"]').click();
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('line2');
  await page.keyboard.press('Control+Enter');
  assert.equal(await page.locator('.mt-editor').count(), 0, 'editor closed on Ctrl+Enter');
  const mt1 = (await mtexts()).at(-1);
  assert.equal((await mtexts()).length, mtBefore + 1);
  assert.match(mt1.text, /^\{\\f[^;|]*\|b1\|i0;Hello\}\\P/, `bold group then \\P: ${mt1.text}`);
  assert.match(mt1.text, /line2/);

  step = 'MTEXT editor: double-click, Italic on line2, Undo';
  await clickWorld(-1000, -1000); await page.keyboard.press('Escape');
  const hit = await page.evaluate((id) => window.app.vp.scene.items.find((it) => it.mt && window.app.doc.entities.find((e) => e.id === id && e.p.x === it.p.x && e.p.y === it.p.y))?.bbox, mt1.id);
  const dbl = async (x, y) => { const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]); const box = await page.locator('#cv').boundingBox(); await page.mouse.dblclick(box.x + s.x, box.y + s.y); };
  await dbl(mt1.p.x + 2, (hit.maxy + hit.miny) / 2 + (hit.maxy - hit.miny) / 4);
  await page.locator(ed).waitFor();
  assert.equal(await page.evaluate((sel) => { const r = document.createRange(); const root = document.querySelector(sel); const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const n = w.nextNode(); return n.data === 'Hello' && getComputedStyle(n.parentNode).fontWeight; }, ed), '700', 'editor shows Hello in bold');
  assert.ok(await selectText('line2'));
  await page.locator('.mt-toolbar [data-cmd="italic"]').click();
  await page.keyboard.press('Control+Enter');
  const mt2 = (await mtexts()).find((e) => e.id === mt1.id);
  assert.match(mt2.text, /\|i1;line2\}/, `italic code: ${mt2.text}`);
  assert.match(mt2.text, /\|b1\|i0;Hello\}/);
  await page.mouse.click(5, 300); await page.keyboard.press('Control+z');
  assert.equal((await mtexts()).find((e) => e.id === mt1.id).text, mt1.text, 'undo restores the previous content');

  step = 'MTEXT editor: unknown codes survive an edit elsewhere';
  const rawId = await page.evaluate(async () => {
    const { addEntities } = await import('/src/core/edit.js');
    const { makeMText } = await import('/src/core/model.js');
    return addEntities(window.app.session, [makeMText({ x: 600, y: 560 }, 4, 'A\\Xzz;B tail', { width: 60 })])[0];
  });
  const rawEnt = (await mtexts()).at(-1);
  assert.ok(rawId != null && rawEnt.text === 'A\\Xzz;B tail');
  await page.evaluate(async (id) => { const { openMTextEditor } = await import('/renderer/mtext-editor.js'); openMTextEditor(window.app, window.app.doc.entities.find((e) => e.id === id)); }, rawEnt.id);
  await page.locator(ed).waitFor();
  assert.ok(await selectText('tail'));
  await page.locator('.mt-toolbar [data-cmd="bold"]').click();
  await page.mouse.click(5, 300);   // click outside commits
  const rawAfter = (await mtexts()).find((e) => e.id === rawEnt.id).text;
  assert.match(rawAfter, /\|b1\|i0;tail\}/, `bold applied: ${rawAfter}`);
  assert.ok(rawAfter.includes('\\Xzz;'), `unknown code kept: ${rawAfter}`);
  await page.keyboard.press('Escape');

  step = 'layouts: Model / Layout tabs, sheet, viewport at 1:50, viewport-frozen layer, MV';
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const { readDxf } = await import('/src/core/dxfRead.js');
    const bytes = new Uint8Array(await (await fetch('/test/fixtures/layouts_r2000.dxf')).arrayBuffer());
    window.app.installDoc(readDxf(bytes), { path: null, name: 'layouts.dxf', format: 'dxf' });
  });
  assert.deepEqual(await page.locator('#spacebar button').allTextContents(), ['Model', 'Layout1', 'Layout2']);
  await page.click('#spacebar button[data-space="Layout1"]');
  assert.equal(await page.evaluate(() => window.app.vp.layout?.name), 'Layout1');
  // ink pixels (dark on the white sheet) inside a paper-space rectangle, at 2 px per paper mm
  const ink = (x0, y0, x1, y1) => page.evaluate(([x0, y0, x1, y1]) => {
    const vp = window.app.vp;
    vp.view = { ...vp.view, cx: 200, cy: 150, zoom: 2 }; vp.render();
    const k = vp.canvas.width / vp.view.width, a = vp.toScreen({ x: x0, y: y1 }), b = vp.toScreen({ x: x1, y: y0 });
    const w = Math.max(1, Math.round((b.x - a.x) * k)), h = Math.max(1, Math.round((b.y - a.y) * k));
    const d = vp.ctx.getImageData(Math.round(a.x * k), Math.round(a.y * k), w, h).data;
    const xs = [];
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 600) xs.push(((i / 4) % w) / k);
    return { n: xs.length, span: xs.length ? Math.max(...xs) - Math.min(...xs) : 0 };
  }, [x0, y0, x1, y1]);
  assert.ok((await ink(299, 19, 340, 26)).n > 20, 'paper-space title text drawn on the sheet');
  // model line (0,0)-(1000,0) through a 1:50 viewport centred on (500,0): 20 mm of paper = 40 px, on y=150
  const line = await ink(170, 149.5, 230, 150.5);
  assert.ok(Math.abs(line.span - 40) <= 3, `model line 1:50 length ${line.span}px, expected 40`);
  // circle on HIDE (frozen in the viewport): centre (500,500) r 200 -> paper (200,160) r 4
  assert.equal((await ink(194, 157, 206, 166)).n, 0, 'viewport-frozen HIDE layer not drawn');
  const vpsBefore = await page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'VIEWPORT').length);
  await typeCmd('mv'); await typeCmd('20,200'); await typeCmd('120,260');
  const vps = await page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'VIEWPORT'));
  assert.equal(vps.length, vpsBefore + 1, 'MV adds a viewport to the layout');
  assert.equal(await page.evaluate(() => window.app.fileDoc.entities.some((e) => e.type === 'VIEWPORT')), false, 'model space untouched');
  const vpReread = await page.evaluate(async () => {
    const { writeDxf } = await import('/src/core/dxfWrite.js'); const { readDxf } = await import('/src/core/dxfRead.js');
    const d = readDxf(new TextEncoder().encode(writeDxf(window.app.fileDoc)));
    return d.layouts.find((l) => l.name === 'Layout1').entities.filter((e) => e.type === 'VIEWPORT').map((e) => [e.c.x, e.c.y, e.width, e.height]);
  });
  assert.ok(vpReread.some(([x, y, w, h]) => Math.abs(x - 70) < 1e-6 && Math.abs(y - 230) < 1e-6 && Math.abs(w - 100) < 1e-6 && Math.abs(h - 60) < 1e-6), `MV viewport saved and reopened: ${JSON.stringify(vpReread)}`);
  await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'VIEWPORT').length), vpsBefore, 'undo removes the MV viewport');
  await page.click('#spacebar button[data-space="Model"]');
  assert.equal(await page.evaluate(() => window.app.vp.layout), null);

  step = 'MLD: create "SUPPLY AIR", Undo removes it, Redo restores it, DXF save and reopen keeps it';
  await typeCmd('new');
  await page.evaluate(() => { const vp = window.app.vp; vp.view = { ...vp.view, cx: 30, cy: 10, zoom: 8 }; vp.render(); });
  const mls = () => page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'MLEADER').map((e) => e.text));
  await typeCmd('mld'); await typeCmd('0,0'); await typeCmd('30,20');
  await page.locator('#dlg textarea').fill('SUPPLY AIR'); await page.locator('#dlg button.primary').click();
  await page.waitForFunction(() => window.app.doc.entities.some((e) => e.type === 'MLEADER'));
  assert.deepEqual(await mls(), ['SUPPLY AIR']);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await mls(), []);
  await page.keyboard.press('Control+y');
  assert.deepEqual(await mls(), ['SUPPLY AIR']);
  const mlBack = await page.evaluate(async () => {
    const { writeDxf } = await import('/src/core/dxfWrite.js'); const { readDxf } = await import('/src/core/dxfRead.js');
    return readDxf(new TextEncoder().encode(writeDxf(window.app.doc))).entities.filter((e) => e.type === 'MLEADER').map((e) => e.text);
  });
  assert.deepEqual(mlBack, ['SUPPLY AIR']);

  step = 'COMPARE: two drawings in tabs, counts, Next zooms, green/red pixels';
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const mk = (extra) => {
      const d = M.newDocument(); d.units = 4;
      for (let i = 0; i < 30; i++) M.addEntity(d, M.makeLine({ x: i * 3, y: 0 }, { x: i * 3, y: 60 }));
      for (const e of extra) M.addEntity(d, e);
      return d;
    };
    const a = mk([M.makeCircle({ x: 300, y: 0 }, 10), M.makeText({ x: 0, y: 300 }, 5, 'NOTE'), M.makeLine({ x: 150, y: 300 }, { x: 200, y: 300 }, { color: 1 })]);
    const b = mk([M.makeLine({ x: 300, y: 200 }, { x: 340, y: 200 }), M.makeText({ x: 3, y: 302 }, 5, 'NOTE'), M.makeLine({ x: 150, y: 300 }, { x: 200, y: 300 }, { color: 5 })]);
    b.entities.reverse();
    window.app.installDoc(a, { path: null, name: 'rev-a.dxf', format: 'dxf' });
    window.app.installDoc(b, { path: null, name: 'rev-b.dxf', format: 'dxf' });
  });
  await typeCmd('compare');
  await page.locator('#dlg[open] #cmp-a').waitFor({ timeout: 3000 });
  assert.equal(await page.locator('#cmp-a option:checked').textContent(), 'rev-a.dxf');
  assert.equal(await page.locator('#cmp-b option:checked').textContent(), 'rev-b.dxf');
  await page.locator('#dlg button.primary').click();
  await page.locator('#compare-panel:not([hidden])').waitFor({ timeout: 3000 });
  assert.match(await page.evaluate(() => window.app.active.file.name), /^Compare rev-a\.dxf vs rev-b\.dxf$/);
  const counts = await page.locator('#compare-panel .cmp-counts').textContent();
  assert.match(counts, /Added 1/); assert.match(counts, /Removed 1/); assert.match(counts, /Changed 2/); assert.match(counts, /Unchanged 30/);
  // the strongest pixel of a colour family in a small window around a world point
  const colourAt = (x, y) => page.evaluate(([wx, wy]) => {
    const vp = window.app.vp; vp.showCross = false; vp.selection.clear(); vp.render();
    const s = vp.toScreen({ x: wx, y: wy }), k = vp.dpr;
    const px = vp.ctx.getImageData(Math.round(s.x * k) - 4, Math.round(s.y * k) - 4, 9, 9).data;
    let red = 0, green = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 180 && px[i + 1] < 90 && px[i + 2] < 90) red++;
      if (px[i + 1] > 150 && px[i] < 100 && px[i + 2] < 100) green++;
    }
    return { red, green };
  }, [x, y]);
  await page.mouse.move(2, 2);
  await page.evaluate(() => window.app.vp.zoomExtents());
  const atRemoved = await colourAt(310, 0), atAdded = await colourAt(320, 200), atSame = await colourAt(30, 30);
  assert.ok(atRemoved.red > 0 && atRemoved.green === 0, `removed circle drawn red: ${JSON.stringify(atRemoved)}`);
  assert.ok(atAdded.green > 0 && atAdded.red === 0, `added line drawn green: ${JSON.stringify(atAdded)}`);
  assert.ok(atSame.red === 0 && atSame.green === 0, 'unchanged objects are neither red nor green');
  const fitZoom = await page.evaluate(() => window.app.vp.view.zoom);
  await page.click('#cmp-next');
  const v1 = await page.evaluate(() => ({ ...window.app.vp.view, box: window.app.active.compare.r.clusters[0].mark }));
  assert.ok(v1.zoom > fitZoom * 2, `Next zooms in to a cluster (${v1.zoom} vs ${fitZoom})`);
  assert.ok(v1.cx >= v1.box.minx && v1.cx <= v1.box.maxx && v1.cy >= v1.box.miny && v1.cy <= v1.box.maxy, 'view centred on the cluster');
  assert.match(await page.locator('#compare-panel .cmp-pos').textContent(), /^1 of 4$/);
  await page.click('#cmp-next');
  assert.match(await page.locator('#compare-panel .cmp-pos').textContent(), /^2 of 4$/);
  await page.evaluate(() => window.app.activateIndex(window.app.tabs.findIndex((t) => t.file.name === 'rev-b.dxf')));
  assert.ok(await page.locator('#compare-panel').isHidden(), 'panel hidden on a drawing tab');

  step = 'markups: MKC + comment, panel, status persists through save and reopen, CSV, Show markups, Undo';
  await page.evaluate(() => { localStorage.removeItem('ash-draw:markup.author'); window.app.newDrawing(true); });
  if (await page.locator('#dlg[open]').count()) await page.locator('#dlg button', { hasText: "Don't save" }).click();
  await page.evaluate(() => { const vp = window.app.vp; vp.view = { ...vp.view, cx: 0, cy: 0, zoom: 4 }; vp.render(); });
  await page.locator('#mk-author').click();
  await page.locator('#dlg[open] input').fill('A. Reviewer'); await page.locator('#dlg button.primary').click();
  assert.equal(await page.evaluate(() => window.api.settingsGet('markup.author')), 'A. Reviewer');
  await page.click('#tools button[data-tool="mkc"]');
  await clickWorld(0, 0); await clickWorld(20, 0);
  await page.locator('#dlg[open] textarea').fill('Check damper access'); await page.locator('#dlg button.primary').click();
  const mk = await page.evaluate(() => window.app.doc.entities.map((e) => ({ type: e.type, layer: e.layer, color: e.color, lt: e.linetype, text: e.text })));
  const mkc = mk.find((e) => e.type === 'CIRCLE');
  assert.ok(mkc && mkc.layer === 'ASH-MARKUP' && mkc.color === 1 && mkc.lt === 'DASHED', `dashed red circle on ASH-MARKUP: ${JSON.stringify(mk)}`);
  assert.ok(mk.some((e) => e.type === 'MTEXT' && e.layer === 'ASH-MARKUP' && e.text === '1: Check damper access'), 'comment text beside the circle');
  assert.equal(await page.locator('#markups .mk-row').count(), 1);
  assert.equal(await page.locator('#markups .mk-comment').textContent(), 'Check damper access');
  assert.match(await page.locator('#markups .mk-meta').textContent(), /A\. Reviewer/);
  await page.evaluate(() => window.app.vp.zoomExtents());
  await page.locator('#markups .mk-row').click();
  assert.equal(await page.evaluate(() => window.app.vp.selection.size), mk.length, 'clicking the row selects the markup');
  await page.locator('#markups .mk-status').click();
  assert.equal(await page.locator('#markups .mk-status').textContent(), 'Closed');
  const saved = page.waitForEvent('download');
  await page.evaluate(() => window.app.saveAs('dxf'));
  const dxfPath = await (await saved).path();
  await page.evaluate(() => window.app.newDrawing(true));
  const chooser = new Promise((r) => { chooserWaiter = r; });
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'markup-saved.dxf', mimeType: 'application/dxf', buffer: await fs.readFile(dxfPath) });
  await page.waitForFunction(() => window.app.file.name === 'markup-saved.dxf');
  assert.equal(await page.locator('#markups .mk-row').count(), 1);
  assert.equal(await page.locator('#markups .mk-status').textContent(), 'Closed', 'status Closed persists after save and reopen');
  await page.selectOption('#mk-filter', 'Open');
  assert.equal(await page.locator('#markups .mk-row').count(), 0, 'filter by status');
  await page.selectOption('#mk-filter', 'all');
  const csvDl = page.waitForEvent('download');
  await page.click('#mk-csv');
  const csv = await fs.readFile(await (await csvDl).path(), 'utf8');
  assert.match(csv, /^No,Comment,Author,Date,Status\r\n1,Check damper access,A\. Reviewer,\d{4}-\d\d-\d\d,Closed\r\n$/);
  const mkVisible = () => page.evaluate(() => window.app.doc.layers.get('ASH-MARKUP').visible);
  await page.locator('#menubar .menu > button', { hasText: 'View' }).click();
  await page.locator('#menubar .menu.open button', { hasText: 'Show markups' }).click();
  assert.equal(await mkVisible(), false, 'View > Show markups off hides them');
  assert.equal(await page.evaluate(() => window.app.vp.pick({ x: 20, y: 0 }, { tol: 1 })), null, 'hidden markup is not drawn / pickable');
  await page.locator('#menubar .menu > button', { hasText: 'View' }).click();
  await page.locator('#menubar .menu.open button', { hasText: 'Show markups' }).click();
  assert.equal(await mkVisible(), true);
  const mkBefore = await count();
  await page.evaluate(() => { const vp = window.app.vp; vp.view = { ...vp.view, cx: 0, cy: 0, zoom: 4 }; vp.render(); });
  await typeCmd('mkr');
  await clickWorld(40, 10); await clickWorld(60, 20);
  await page.locator('#dlg[open] textarea').fill('Second'); await page.locator('#dlg button.primary').click();
  assert.equal(await page.locator('#markups .mk-row').count(), 2);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  assert.equal(await count(), mkBefore, 'Undo removes the new markup in one step');
  assert.equal(await page.locator('#markups .mk-row').count(), 1);
  await page.locator('#markups .mk-del').click();
  assert.equal(await page.locator('#markups .mk-row').count(), 0);
  await page.keyboard.press('Control+z');
  assert.equal(await page.locator('#markups .mk-row').count(), 1, 'delete is one undo step');

  step = 'drawScene pixel parity with the reference renderer (3 zoom levels, browser canvas)';
  const parity = await page.evaluate(async () => {
    const R = await import('/src/core/render.js');
    const { drawSceneRef } = await import('/test/ref/drawSceneRef.js');
    const { mixedDoc } = await import('/test/ref/mixedDoc.js');
    const scene = R.buildScene(mixedDoc());
    const W = 500, H = 320, fit = R.fitView(scene.bbox, W, H);
    const px = (draw, v) => { const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const c = cv.getContext('2d'); draw(c, scene, v, { background: '#ffffff' }); return c.getImageData(0, 0, W, H).data; };
    return [[2, 300, 200], [6, 620, 410], [16, 150, 520]].map(([k, cx, cy]) => {
      const v = { ...fit, zoom: fit.zoom * k, cx, cy }, a = px(drawSceneRef, v), b = px(R.drawScene, v);
      let diff = 0, ink = 0;
      for (let i = 0; i < a.length; i += 4) { if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++; if (a[i] < 250 || a[i + 1] < 250 || a[i + 2] < 250) ink++; }
      return { k, diff: diff / (W * H), ink };
    });
  });
  for (const p of parity) { assert.ok(p.ink > 500, `parity view ${p.k}x is not empty`); assert.ok(p.diff <= 0.005, `parity view ${p.k}x: ${(p.diff * 100).toFixed(3)} % pixels differ`); }

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
