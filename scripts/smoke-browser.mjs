#!/usr/bin/env node
// Browser smoke test: serves the project folder over http and loads renderer/index.html
// in headless Chromium. Fails on console errors, page errors, failed requests or CSP violations.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('app')?.textContent.includes('ready'), null, { timeout: 10000 });

  const r = await page.evaluate(async () => {
    const out = { isElectron: window.api.isElectron, dwg: await window.api.dwgAvailable() };
    const { parseDxf } = await import('../src/core/dxfRead.js');
    const { writeDxf } = await import('../src/core/dxfWrite.js');
    const dxf = '0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n';
    const parsed = parseDxf(dxf);
    out.entities = parsed.entities.map((e) => e.type);
    out.resaved = writeDxf(parsed).length;
    const { PDFDocument } = await import('pdf-lib');
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    doc.addPage();
    out.pdfBytes = (await doc.save()).length;
    out.csp = window.__csp;
    return out;
  });
  if (r.isElectron !== false) problems.push(`isElectron=${r.isElectron}`);
  if (r.dwg.available !== false) problems.push('dwgAvailable should be false in browser');
  if (r.entities.length !== 1 || r.entities[0] !== 'LINE') problems.push(`entities=${JSON.stringify(r.entities)}`);
  if (!(r.pdfBytes > 100)) problems.push(`pdf bytes=${r.pdfBytes}`);
  for (const v of r.csp) problems.push(`CSP violation: ${v}`);
  if (!(r.resaved > 500)) problems.push(`resaved=${r.resaved}`);
  console.log(`isElectron=${r.isElectron} entities=${r.entities.join(',')} pdfBytes=${r.pdfBytes} dwg.reason="${r.dwg.reason}"`);
} finally {
  await browser.close();
  server.close();
}
if (problems.length) {
  console.error(`SMOKE FAIL\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('SMOKE OK');
