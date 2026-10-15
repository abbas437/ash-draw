#!/usr/bin/env node
// Contact sheet of every icon in renderer/icons.js at 16, 20 and 32 px, light and dark theme, in its tool group colour
// (the app's styles.css). Usage: node scripts/icon-sheet.mjs <out.png>. Headless Chromium via playwright-core, like test/e2e.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const out = path.resolve(process.argv[2] || path.join(ROOT, '.scratch', 'icons.png'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/sheet.html') { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><link rel="stylesheet" href="/renderer/styles.css"><body style="margin:0"></body>'); return; }
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  let body; try { body = await fs.readFile(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${server.address().port}/sheet.html`);
  await page.evaluate(async () => {
    const { ICONS, iconSvg } = await import('/renderer/icons.js');
    const { TOOL_BUTTONS, QUICK_ACCESS } = await import('/renderer/tool-panel.js');
    const group = {};
    for (const [key, ids] of QUICK_ACCESS) for (const id of ids) group[id] ??= key;
    for (const [, key, items] of TOOL_BUTTONS) for (const [id] of items) group[id] = key;
    const ids = Object.keys(ICONS);
    const sheet = (theme) => {
      const wrap = document.createElement('div');
      if (theme === 'dark') wrap.dataset.theme = 'dark';
      wrap.innerHTML = `<div id="tools" style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px 10px;padding:10px;overflow:visible;border:none;background:var(--panel);color:var(--text);font:11px system-ui"></div>`;
      const grid = wrap.firstChild;
      for (const id of ids) {
        const cell = document.createElement('div');
        cell.className = `g-${group[id] || 'file'}`;
        cell.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0';
        for (const s of [16, 20, 32]) cell.append(iconSvg(id, s));
        const name = document.createElement('span'); name.textContent = id; name.style.color = 'var(--dim)';
        cell.append(name);
        grid.append(cell);
      }
      return wrap;
    };
    document.body.style.cssText = 'margin:0;display:grid;grid-template-columns:1fr 1fr;width:1600px';
    document.body.append(sheet('light'), sheet('dark'));
  });
  await fs.mkdir(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, fullPage: true });
  console.log(out);
} finally { await browser.close(); server.close(); }
