#!/usr/bin/env node
// Real Electron app, fresh portable data dir: last-session restore, missing files, start-up modes, recent files,
// and main ignoring a session entry whose path was never granted. Launched like electron.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdtemp, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const electronBin = process.env.ELECTRON_BIN || createRequire(import.meta.url)('electron');
const tmp = await mkdtemp(join(tmpdir(), 'ash-draw-session-'));
const dataDir = join(tmp, 'ASH-Draw-Studio-data');
const fixture = async (src, name) => { const p = join(tmp, name); await copyFile(join(root, 'test', 'fixtures', src), p); return p; };
const a = await fixture('basic_r2000.dxf', 'a.dxf');
const b = await fixture('text_r2000.dxf', 'b.dxf');
const c = await fixture('colors_r2000.dxf', 'c.dxf');
const never = await fixture('basic_r2000.dxf', 'never-granted.dxf');
const readJson = (f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8'));

let step = 'launch';
let app = null;
const problems = [];
const expect = (what, got, ok) => { if (!ok) throw new Error(`${what}: got ${got}`); };
async function launch(...files) {
  app = await electron.launch({
    executablePath: electronBin, args: ['--disable-gpu', root, ...files], cwd: root,
    env: { ...process.env, PORTABLE_EXECUTABLE_DIR: tmp },
  });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  win.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await win.waitForFunction(() => window.app && window.app.doc, null, { timeout: 30000 });
  return win;
}
async function quit() { await app.close(); app = null; }
const tabs = (win) => win.evaluate(() => window.app.tabs.map((t) => t.file.name));
const waitTabs = (win, names) => win.waitForFunction((n) => JSON.stringify(window.app.tabs.map((t) => t.file.name)) === JSON.stringify(n), names, { timeout: 30000 });

try {
  step = 'run 1: two DXFs from the command line are recorded';
  let win = await launch(a, b);
  await waitTabs(win, ['a.dxf', 'b.dxf']);
  await win.evaluate(() => window.app.switchTo(window.app.tabs[0]));
  await win.waitForTimeout(500);
  await quit();
  let s = readJson('session.json');
  expect('saved session', JSON.stringify(s), JSON.stringify(s.files) === JSON.stringify([a, b]) && s.active === a);
  expect('recent list', JSON.stringify(readJson('recent.json')), JSON.stringify(readJson('recent.json')) === JSON.stringify([b, a]));

  step = 'run 2: the drawing area offers 2 files; Reopen opens both tabs';
  win = await launch();
  const offer = await win.locator('[data-session="reopen"]').textContent({ timeout: 10000 });
  expect('offer text', offer, offer === 'Reopen last session (2 files)');
  await win.click('[data-session="reopen"]');
  await waitTabs(win, ['a.dxf', 'b.dxf']);
  const active = await win.evaluate(() => window.app.file.name);
  expect('restored active tab', active, active === 'a.dxf');
  expect('panel gone', '', !(await win.locator('.session-offer').count()));

  step = 'run 2: sessionUpdate with a never-granted path is ignored';
  await win.waitForTimeout(500);
  const r = await win.evaluate(([a, b, never]) => window.api.sessionUpdate({ files: [a, never, b], active: never }), [a, b, never]);
  expect('sessionUpdate result', r, r === true);
  await quit();
  s = readJson('session.json');
  expect('session without the ungranted path', JSON.stringify(s), JSON.stringify(s.files) === JSON.stringify([a, b]) && s.active === null);
  expect('recent without the ungranted path', JSON.stringify(readJson('recent.json')), !readJson('recent.json').includes(never));

  step = 'run 3: a deleted file is listed as unavailable, the other opens';
  await unlink(b);
  win = await launch();
  await win.click('[data-session="reopen"]', { timeout: 10000 });
  await win.waitForSelector('#dlg[open] .session-missing', { timeout: 30000 });
  const title = await win.locator('#dlg h2').textContent();
  expect('missing dialog title', title, title === 'Some files are not available');
  const listed = await win.locator('#dlg li .file-name').allTextContents();
  expect('missing list', JSON.stringify(listed), JSON.stringify(listed) === '["b.dxf"]');
  await win.locator('#dlg .dlg-btns button').click();
  await waitTabs(win, ['a.dxf']);

  step = 'run 3: recent files lists both, the deleted one as Not found';
  await win.locator('#menubar .menu > button', { hasText: 'File' }).click();
  await win.locator('#menubar .menu.open button', { hasText: 'Recent files' }).click();
  const items = win.locator('#dlg[open] .recent-item');
  await items.first().waitFor({ timeout: 10000 });
  const rows = await items.evaluateAll((els) => els.map((e) => [e.querySelector('.file-name').textContent, e.disabled, e.querySelector('.file-missing')?.textContent ?? '']));
  expect('recent rows', JSON.stringify(rows), JSON.stringify(rows) === JSON.stringify([['a.dxf', false, ''], ['b.dxf', true, 'Not found']]));
  await win.keyboard.press('Escape');
  await win.evaluate(() => window.api.settingsSet('startup.mode', 'restore'));
  await quit();

  step = "run 4: 'restore' with a file on the command line opens only that file; the offer stays available";
  win = await launch(c);
  await waitTabs(win, ['c.dxf']);
  await win.waitForTimeout(1500);
  expect('tabs', JSON.stringify(await tabs(win)), JSON.stringify(await tabs(win)) === '["c.dxf"]');
  expect('session still offered', '', (await win.locator('[data-session="reopen"]').count()) === 1);
  await win.evaluate(() => window.api.settingsSet('startup.mode', 'new'));
  await quit();
  s = readJson('session.json');
  expect('session after run 4', JSON.stringify(s), JSON.stringify(s.files) === JSON.stringify([c]));

  step = "run 5: 'new' opens nothing and offers nothing";
  win = await launch();
  await win.waitForTimeout(1500);
  expect('tabs', JSON.stringify(await tabs(win)), JSON.stringify(await tabs(win)) === '["Untitled.dxf"]');
  expect('no offer', '', (await win.locator('.session-offer').count()) === 0);
  await quit();

  step = 'no renderer errors';
  if (problems.length) throw new Error(problems.join('\n'));
  console.log('draw electron session e2e: OK');
} catch (err) {
  console.error(`draw electron session e2e FAILED at step "${step}":`, err.message);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  if (existsSync(tmp)) await rm(tmp, { recursive: true, force: true });
}
