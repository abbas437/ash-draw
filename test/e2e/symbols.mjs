#!/usr/bin/env node
// Browser end-to-end test of the Symbols side panel section: built-in grid, search, SYMBOLINSERT (repeat placement,
// typed rotation, one undo step each), and a library folder added through the browser's folder picker.
// Uses the browser fallback of window.api (shim.js); the desktop folder store is covered by electron/symbols.test.mjs.
import http from 'node:http';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { newDocument, addEntity, makeLine, makeCircle, makeRect } from '../../src/core/model.js';
import { makeAttdef } from '../../src/core/blocks.js';
import { writeDxf } from '../../src/core/dxfWrite.js';

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

/** a CIBSE-style symbol file (AC1015, mm, model-space geometry around 0,0) */
function symbolDxf(withTag) {
  const d = newDocument(); d.units = 4;
  addEntity(d, makeRect({ x: -300, y: -300 }, { x: 300, y: 300 }));
  addEntity(d, makeCircle({ x: 0, y: 0 }, 150));
  addEntity(d, makeLine({ x: -300, y: 0 }, { x: 300, y: 0 }));
  if (withTag) addEntity(d, makeAttdef({ x: 0, y: -400 }, 100, 'REF', { prompt: 'Reference', default: 'R1' }));
  return writeDxf(d);
}
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-symbols-e2e-'));
const lib = path.join(tmp, 'CIBSE');
const FILES = {
  'Ventilation/Air Terminals/Mech_Vent_AirTerminals_Ceiling_Return.dxf': symbolDxf(true),
  'Ventilation/Air Terminals/Mech_Vent_AirTerminals_Ceiling_Supply.dxf': symbolDxf(false),
  'Ventilation/Dampers/Mech_Vent_Dampers_Fire_Damper.dxf': symbolDxf(false),
};
for (const [rel, text] of Object.entries(FILES)) {
  await fs.mkdir(path.dirname(path.join(lib, rel)), { recursive: true });
  await fs.writeFile(path.join(lib, rel), text);
}

const problems = [];
let step = 'start';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });

  const cmd = async (s) => { await page.locator('#cmd').fill(s); await page.locator('#cmd').press('Enter'); };
  const cells = page.locator('#sym-grid .sym-cell');
  const inserts = () => page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'INSERT').map((e) => ({ block: e.block, rot: e.rot, sx: e.sx, attribs: (e.attribs ?? []).map((a) => a.text) })));
  /** click the canvas at a world point */
  const clickWorld = async (x, y) => {
    const s = await page.evaluate(([wx, wy]) => { const r = window.app.vp.canvas.getBoundingClientRect(), q = window.app.vp.toScreen({ x: wx, y: wy }); return { x: r.left + q.x, y: r.top + q.y }; }, [x, y]);
    await page.mouse.move(s.x - 5, s.y - 5); await page.mouse.move(s.x, s.y); await page.mouse.click(s.x, s.y);
  };
  const view = () => page.evaluate(() => { const v = window.app.vp.view; return { cx: v.cx, cy: v.cy, w: v.width / v.zoom }; });

  step = 'SYMBOLS shows the section unfolded and focuses its search box';
  await page.locator('#side .panel[data-sec=symbols] .phead').click();
  assert.equal(await page.locator('#sym-grid').isVisible(), false, 'folded by its header');
  await cmd('SYMBOLS');
  assert.equal(await page.locator('#sym-grid').isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sym-search');

  step = 'built-in grid: at least 30 symbols, status line, thumbnails rendered as they come into view';
  await page.waitForFunction(() => document.querySelectorAll('#sym-grid .sym-cell').length >= 30, null, { timeout: 5000 });
  const total = await cells.count();
  assert.match(await page.locator('#sym-status').textContent(), new RegExp(`^${total} symbols`));
  assert.equal(await page.locator('#sym-source').inputValue(), 'builtin');
  assert.equal(await page.locator('#sym-remove').isDisabled(), true, 'the built-in set cannot be removed');
  await page.waitForFunction(() => document.querySelectorAll('#sym-grid .sym-cell.ready').length >= 4, null, { timeout: 5000 });
  const lazy = await page.evaluate(() => [...document.querySelectorAll('#sym-grid .sym-cell')].filter((c) => c.classList.contains('loading')).length);
  assert.ok(lazy > 0, 'cells below the fold wait for their thumbnail');

  step = 'search "diffuser" filters by name, case-insensitive';
  await page.locator('#sym-search').fill('diffuser');
  const names = await page.locator('#sym-grid .sym-name').allTextContents();
  assert.ok(names.length >= 2 && names.length < total, `filtered ${names.length}`);
  assert.ok(names.every((n) => /diffuser/i.test(n)), names.join(', '));
  assert.match(await page.locator('#sym-status').textContent(), new RegExp(`^${names.length} of ${total} symbols`));

  step = 'dark theme inverts the thumbnails';
  await page.evaluate(() => window.app.setTheme('dark', false));
  assert.equal(await page.locator('#sym-grid .sym-thumb').first().evaluate((i) => getComputedStyle(i).filter), 'invert(1)');
  await page.evaluate(() => window.app.setTheme('light', false));
  assert.equal(await page.locator('#sym-grid .sym-thumb').first().evaluate((i) => getComputedStyle(i).filter), 'none');

  step = 'pick Round Diffuser: placed twice (Enter = 0, typed 90), Esc ends; one undo step each';
  await page.locator('#sym-grid .sym-cell', { hasText: /^Round Diffuser$/ }).click();
  assert.equal(await page.evaluate(() => window.app.toolId), 'symbolinsert');
  const v = await view();
  const a = { x: v.cx - v.w / 6, y: v.cy }, b = { x: v.cx + v.w / 6, y: v.cy };
  await clickWorld(a.x, a.y);
  assert.match(await page.locator('#prompt').textContent(), /rotation/);
  await cmd('');
  await clickWorld(b.x, b.y);
  await cmd('90');
  assert.equal(await page.evaluate(() => window.app.toolId), 'symbolinsert', 'repeats until Esc');
  await page.locator('#cv').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.app.toolId), 'select');
  let ins = await inserts();
  assert.equal(ins.length, 2);
  assert.deepEqual(ins.map((e) => [e.block, e.rot]), [['Round Diffuser', 0], ['Round Diffuser', 90]]);
  await page.keyboard.press('Control+z');
  ins = await inserts();
  assert.deepEqual(ins.map((e) => e.rot), [0], 'Ctrl+Z removed the last placement only');

  step = 'Drawing scale 1:N is kept in settings';
  await page.locator('#sym-dscale').fill('50'); await page.locator('#sym-dscale').press('Enter');
  await page.waitForFunction(() => localStorage.getItem('ash-draw:symbols.drawingScale') === '50', null, { timeout: 3000 });

  step = 'add a folder (browser folder picker): categories from subfolders, cleaned names, thumbnails';
  await page.locator('#sym-search').fill('');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#sym-add').click();
  await (await chooser).setFiles(lib);
  await page.waitForFunction(() => document.querySelectorAll('#sym-grid .sym-cell').length === 3, null, { timeout: 5000 });
  assert.match(await page.locator('#sym-source option:checked').textContent(), /CIBSE/);
  assert.equal(await page.locator('#sym-remove').isDisabled(), false);
  assert.match(await page.locator('#sym-status').textContent(), /^3 symbols/);
  const cats = await page.locator('#sym-cat option').allTextContents();
  assert.deepEqual(cats, ['All categories', 'Ventilation › Air Terminals', 'Ventilation › Dampers']);
  assert.deepEqual((await page.locator('#sym-grid .sym-name').allTextContents()).sort(), ['Ceiling Return', 'Ceiling Supply', 'Fire Damper']);
  assert.equal(await cells.first().getAttribute('title'), 'Mech_Vent_AirTerminals_Ceiling_Return.dxf');
  await page.waitForFunction(() => document.querySelectorAll('#sym-grid .sym-cell.ready').length === 3, null, { timeout: 5000 });
  await page.locator('#sym-cat').selectOption('Ventilation/Dampers');
  assert.deepEqual(await page.locator('#sym-grid .sym-name').allTextContents(), ['Fire Damper']);
  await page.locator('#sym-cat').selectOption('');

  step = 'place a folder symbol with an attribute: values asked before placing; rotation by a second click';
  await cells.filter({ hasText: 'Ceiling Return' }).click();
  await clickWorld(a.x, a.y + v.w / 8);
  await clickWorld(a.x, a.y + v.w / 4); // straight up: 90 degrees
  await page.locator('#dlg input[name="att-REF"]').fill('RG-01');
  await page.locator('#dlg button.primary').click();
  await page.locator('#cv').focus();
  await page.keyboard.press('Escape');
  ins = await inserts();
  assert.equal(ins.length, 2);
  assert.equal(ins[1].block, 'Ceiling Return');
  assert.ok(Math.abs(ins[1].rot - 90) < 1e-6, `rotation ${ins[1].rot}`);
  assert.deepEqual(ins[1].attribs, ['RG-01']);
  assert.equal(ins[1].sx, 1, 'equipment-size file symbol: the drawing scale does not apply');

  step = 'Remove folder goes back to the built-in set';
  await page.locator('#sym-remove').click();
  await page.waitForFunction(() => document.getElementById('sym-source').value === 'builtin', null, { timeout: 5000 });
  assert.equal(await page.locator('#sym-source option').count(), 1);

  step = 'SYMCOUNT: two Round Diffusers and one other built-in symbol counted 2 and 1';
  await page.evaluate(() => { window.app.selectAll(); window.app.deleteSelection(); window.app.vp.setSelection([]); });
  await page.waitForFunction(() => document.querySelectorAll('#sym-grid .sym-cell').length >= 30, null, { timeout: 5000 });
  const placeSym = async (name, pts) => {
    await page.locator('#sym-grid .sym-cell', { hasText: new RegExp(`^${name}$`) }).click();
    for (const p of pts) { await clickWorld(p.x, p.y); await cmd(''); }
    await page.locator('#cv').focus(); await page.keyboard.press('Escape');
  };
  const other = (await page.locator('#sym-grid .sym-name').allTextContents()).find((n) => n !== 'Round Diffuser');
  await placeSym('Round Diffuser', [a, b]);
  await placeSym(other, [{ x: v.cx, y: v.cy + v.w / 8 }]);
  assert.equal((await inserts()).length, 3);
  await cmd('SYMCOUNT');
  const rowsShown = () => page.locator('#dlg .symc-table tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.cells].slice(0, 2).map((c) => c.textContent)));
  assert.deepEqual((await rowsShown()).sort(), [['Round Diffuser', '2'], [other, '1']].sort());
  assert.match(await page.locator('#dlg .symc-total').textContent(), /Total: 3/);

  step = 'SYMCOUNT: Excel (.xlsx)… saves a zip (PK) named after the drawing';
  const dl = page.waitForEvent('download');
  await page.locator('#symc-xlsx').click();
  const download = await dl;
  assert.match(download.suggestedFilename(), /-symbol-count\.xlsx$/);
  const xbytes = await fs.readFile(await download.path());
  assert.equal(xbytes.subarray(0, 2).toString('latin1'), 'PK');

  step = 'SYMCOUNT: Place in drawing adds the schedule on SYMBOL-SCHEDULE (2 INSERTs in the picture column); one undo removes it';
  const before = await page.evaluate(() => window.app.doc.entities.length);
  await page.locator('#dlg .dlg-btns button', { hasText: 'Place in drawing' }).click();
  assert.equal(await page.evaluate(() => window.app.toolId), 'pickpoint');
  await clickWorld(v.cx + v.w / 4, v.cy + v.w / 6);
  const added = await page.evaluate((n) => window.app.doc.entities.slice(n).map((e) => ({ type: e.type, layer: e.layer, block: e.block, text: e.text })), before);
  assert.ok(added.length > 10, `${added.length} entities added`);
  assert.ok(added.every((e) => e.layer === 'SYMBOL-SCHEDULE'), 'all on SYMBOL-SCHEDULE');
  assert.deepEqual(added.filter((e) => e.type === 'INSERT').map((e) => e.block).sort(), ['Round Diffuser', other].sort());
  assert.ok(added.some((e) => e.type === 'LINE'), 'grid lines');
  for (const t of ['SYMBOL SCHEDULE', 'Symbol', 'Description', 'Qty', 'Round Diffuser', '2', '1']) assert.ok(added.some((e) => e.type === 'TEXT' && e.text === t), `text ${t}`);
  assert.equal(await page.evaluate(() => window.app.toolId), 'select');
  await page.locator('#cv').focus();
  await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(() => window.app.doc.entities.length), before, 'one undo removed the whole schedule');
  assert.equal(await page.evaluate(() => window.app.doc.entities.filter((e) => e.layer === 'SYMBOL-SCHEDULE').length), 0);

  step = 'the Symbols panel Count… button opens the same count; Close dismisses it';
  await page.locator('#sym-count').click();
  assert.deepEqual((await rowsShown()).sort(), [['Round Diffuser', '2'], [other, '1']].sort());
  await page.locator('#dlg .dlg-btns button', { hasText: 'Close' }).click();
  assert.equal(await page.locator('#dlg').evaluate((d) => d.open), false);

  assert.deepEqual(problems, []);
  console.log('symbols e2e: OK');
} catch (err) {
  console.error(`symbols e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
