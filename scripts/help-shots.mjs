#!/usr/bin/env node
// Help screenshots: renders the shots listed in help/shots.json into help/img/<name>.png using the
// browser build (same static-server harness as the e2e tests). Run: npm run help:shots [name …]
// help/shots.json: [{ name, viewport?: {width, height}, open?: <number of sample PDFs to open>,
//   keys?: ["t", …] (pressed after opening), eval?: "<async JS body run in the page>",
//   wait?: <ms>, clip?: "<selector>" (default: the whole window), pad?: <px around the clip> }]
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' };

const only = process.argv.slice(2);
const shots = JSON.parse(await readFile(join(root, 'help', 'shots.json'), 'utf8')).filter((s) => !only.length || only.includes(s.name));
const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  let body;
  try { body = await readFile(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
await mkdir(join(root, 'help', 'img'), { recursive: true });
let failed = 0;
try {
  for (const s of shots) {
    const page = await browser.newPage({ viewport: s.viewport ?? { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    try {
      await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.app?.vp && window.app.doc, null, { timeout: 15_000 });
      for (const f of s.open ?? []) {
        const chooser = page.waitForEvent('filechooser');
        await page.keyboard.press('Control+o');
        await (await chooser).setFiles(join(root, 'test', 'fixtures', f));
        await page.waitForFunction((n) => window.app.tabs.some((t) => t.file?.name === n), f, { timeout: 15_000 });
      }
      await page.waitForTimeout(300);
      for (const k of s.keys ?? []) { await page.keyboard.press(k); await page.waitForTimeout(80); }
      if (s.eval) await page.evaluate(new Function(`return (async () => { ${s.eval} })();`));
      await page.waitForTimeout(s.wait ?? 400);
      let clip;
      if (s.clip) {
        const r = await page.$eval(s.clip, (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
        const p = s.pad ?? 0;
        clip = { x: Math.max(0, r.x - p), y: Math.max(0, r.y - p), width: r.width + 2 * p, height: r.height + 2 * p };
      }
      await page.screenshot({ path: join(root, 'help', 'img', `${s.name}.png`), clip });
      console.log(`help shot: ${s.name}.png`);
    } catch (err) {
      failed++;
      console.error(`help shot ${s.name} FAILED: ${err.message}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
