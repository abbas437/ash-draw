#!/usr/bin/env node
// Browser end-to-end test of ATTSYNC typed at the command line like a user (block name typed, and a picked block); same harness as run.mjs.
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
  const tags = () => page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'INSERT').map((e) => (e.attribs ?? []).map((a) => `${a.attrib.tag}=${a.text}`).join(',')));

  step = 'define block TAG (a line + NAME attribute) and insert it twice through one undo step';
  await page.evaluate(async () => {
    const B = await import('/src/core/blocks.js'), M = await import('/src/core/model.js');
    const blk = { name: 'TAG', base: { x: 0, y: 0 }, entities: [M.makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }), B.makeAttdef({ x: 1, y: 1 }, 2, 'NAME', { default: 'N?' })] };
    window.app.session.transact('Setup', (tx) => {
      tx.block('TAG', blk);
      tx.add(B.instantiate(blk, { x: 0, y: 0 }, { values: { NAME: 'AHU-1' } }));
      tx.add(B.instantiate(blk, { x: 50, y: 0 }, { sx: 2, rot: 30 }));
    });
  });
  assert.deepEqual(await tags(), ['NAME=AHU-1', 'NAME=N?']);

  step = 'add a second ATTDEF (SIZE) to the definition; ATTSYNC, type TAG: both inserts get SIZE, values kept';
  await page.evaluate(async () => {
    const B = await import('/src/core/blocks.js');
    const old = window.app.doc.blocks.get('TAG');
    window.app.session.transact('Redefine', (tx) => tx.block('TAG', { ...old, entities: [...old.entities, B.makeAttdef({ x: 1, y: 4 }, 2, 'SIZE', { default: '300x200' })] }));
  });
  await typeCmd('ATTSYNC');
  assert.equal(await toolId(), 'attsync');
  await typeCmd('?');
  assert.equal(await toolId(), 'attsync', '? lists and keeps the prompt');
  await typeCmd('tag');
  assert.equal(await toolId(), 'select');
  assert.deepEqual(await tags(), ['NAME=AHU-1,SIZE=300x200', 'NAME=N?,SIZE=300x200']);
  const sizeAt = await page.evaluate(() => window.app.doc.entities[1].attribs[1].p);
  assert.ok(Math.abs(sizeAt.x - (50 + 2 * (Math.cos(Math.PI / 6) * 1 - Math.sin(Math.PI / 6) * 4))) < 1e-6, `SIZE placed through the insert transform: ${JSON.stringify(sizeAt)}`);

  step = 'one U undoes the whole ATTSYNC';
  await typeCmd('U');
  assert.deepEqual(await tags(), ['NAME=AHU-1', 'NAME=N?']);

  step = 'select the first insert, then ATTSYNC: synced from the picked block';
  await page.evaluate(() => window.app.vp.setSelection([window.app.doc.entities[0].id]));
  await typeCmd('ATTSYNC');
  assert.equal(await toolId(), 'select');
  assert.deepEqual(await tags(), ['NAME=AHU-1,SIZE=300x200', 'NAME=N?,SIZE=300x200']);

  assert.deepEqual(problems, []);
  console.log('attsync e2e: OK');
} catch (err) {
  console.error(`attsync e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
