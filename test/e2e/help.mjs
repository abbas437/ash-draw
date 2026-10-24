#!/usr/bin/env node
// End-to-end test of the in-app help (renderer/help/help-engine.js + renderer/help-adapter.js) in headless Chromium:
// F1 / search / Show me spotlight / guided tour / real tool event / F1 context / dialog "?" / welcome card /
// external links / no page errors. Prints "HELP OK".
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_PATH || process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const problems = [];
const server = http.createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(await fs.readFile(file)); } catch { problems.push(`404 ${req.url}`); res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));

  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', body), arg);
  const H = 'const H = await import("/renderer/help/help-engine.js"); const data = (await import("/renderer/help/help-data.js")).default;';
  const hev = (body, arg) => ev(`${H}\n${body}`, arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const rect = (sel) => ev('const e = document.querySelector(arg); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom };', sel);
  const overlap = (a, b) => !!a && !!b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const waitFor = (fn, arg, what) => page.waitForFunction(fn, arg, { timeout: 5000 }).catch(() => { throw new Error(`timed out waiting for ${what}`); });
  const text = (sel) => ev('return document.querySelector(arg)?.textContent?.trim() ?? null;', sel);
  const stepN = () => ev('return document.querySelector(".ah-pop .ah-step .ah-step-n")?.textContent ?? "";');
  const atStep = (n) => waitFor((k) => new RegExp(`· ${k} /`).test(document.querySelector('.ah-pop .ah-step .ah-step-n')?.textContent ?? ''), n, `tour step ${n}`);
  const panelOpen = () => waitFor(() => { const p = document.querySelector('.ash-help'); return p && !p.hidden; }, null, 'help panel');
  const menuItem = async (menu, label) => {
    await page.click(`#menubar .menu > button[data-menu="${menu}"]`);
    await page.locator('#menubar .menu .drop button', { hasText: label }).first().click();
  };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });
  // A permanent 'filechooser' listener (as test/e2e/run.mjs does): a per-call waitForEvent can lose a chooser opened right after it.
  let chooserWaiter = null;
  page.on('filechooser', (c) => { const w = chooserWaiter; chooserWaiter = null; w?.(c); });
  const chooser = new Promise((r) => { chooserWaiter = r; });
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles(path.join(ROOT, 'test', 'fixtures', 'basic_r2000.dxf'));
  await waitFor(() => window.app.doc.entities.length > 0, null, 'fixture to open');
  await frames();
  check(!(await page.$('.ah-welcome')), 'welcome card must be suppressed under webdriver');

  step = 'F1 opens welcome';
  const welcomeTitle = await hev('return data.topics.find((t) => t.id === "welcome").title;');
  const cb = await page.locator('#cv').boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2); // the drawing canvas has no context key
  await page.keyboard.press('F1');
  await panelOpen();
  check((await text('.ah-body h1')) === welcomeTitle, `F1 topic title "${await text('.ah-body h1')}" != "${welcomeTitle}"`);

  step = 'search layer';
  const layersTitle = await hev('return data.topics.find((t) => t.id === "layers").title;');
  // "layer" alone ranks "Layer states" first (exact title word beats the "Layers" prefix): known ranking quirk, so the query is "layers"
  await page.fill('.ah-search', 'layers');
  await waitFor(() => document.querySelector('.ah-result'), null, 'search results');
  const first = await text('.ah-result .ah-rt');
  check(first === layersTitle, `first result is "${first}", want "${layersTitle}"`);
  await page.press('.ah-search', 'Enter');
  await waitFor((t) => document.querySelector('.ah-body h1')?.textContent?.trim() === t, layersTitle, 'Layers topic');

  step = 'show me spotlight';
  const showme = await ev('return [...document.querySelectorAll("a.help-showme")].map((a) => a.dataset.showme);');
  const target = showme.includes('panel:layers') ? 'panel:layers' : showme.find((s) => s.startsWith('tool:'));
  check(target, `no usable Show me link on the Layers topic: ${JSON.stringify(showme)}`);
  const targetSel = target === 'panel:layers' ? '.panel[data-sec="layers"]' : `#tools button[data-tool="${target.slice(5)}"]`;
  await page.click(`a.help-showme[data-showme="${target}"]`);
  await waitFor(() => document.querySelector('.ah-spot') && document.querySelector('.ash-help.ah-folded'), null, 'spotlight + folded panel');
  await frames();
  check(overlap(await rect('.ah-spot'), await rect(targetSel)), `spotlight does not overlap ${targetSel}`);
  await page.keyboard.press('Escape');
  await waitFor(() => !document.querySelector('.ah-spot') && !document.querySelector('.ash-help.ah-folded'), null, 'spotlight to end and panel to unfold');

  step = 'tour';
  await page.click('.ah-home');
  await page.click('.ah-tourbtn[data-tour="first-steps"]');
  await atStep(1);
  await page.click('.ah-pop .ah-step-btns .ah-primary');
  await atStep(2);
  await page.click('.ah-pop .ah-step-btns button:not(.ah-primary):nth-last-child(2)'); // Back
  await atStep(1);
  const evIdx = await hev('return data.tours.find((t) => t.id === "first-steps").steps.findIndex((s) => s.advanceOn?.startsWith("event:"));');
  check(evIdx >= 0, 'first-steps has no event step');
  for (let i = 0; i < evIdx; i++) { await page.click('.ah-pop .ah-step-btns .ah-primary'); await atStep(i + 2); }
  const adv = await hev('return data.tours.find((t) => t.id === "first-steps").steps[arg].advanceOn;', evIdx);
  await hev('H.helpEvent("not-this-one");');
  await page.waitForTimeout(300);
  check(new RegExp(`· ${evIdx + 1} /`).test(await stepN()), 'an unrelated event advanced the tour');
  await hev('H.helpEvent(arg); H.helpEvent(arg);', adv.slice(6)); // a repeated event moves on one step only
  await atStep(evIdx + 2);
  await page.waitForTimeout(400);
  check(new RegExp(`· ${evIdx + 2} /`).test(await stepN()), 'a repeated event skipped a step');
  await page.keyboard.press('Escape');
  await waitFor(() => !document.querySelector('.ah-pop'), null, 'tour to end on Esc');

  step = 'real tool event advances the tour';
  await hev('H.openHelp();');
  await page.click('.ah-home');
  await page.click('.ah-tourbtn[data-tour="first-steps"]');
  await atStep(1);
  const toolIdx = await hev('return data.tours.find((t) => t.id === "first-steps").steps.findIndex((s) => s.advanceOn === "event:tool:line");');
  check(toolIdx >= 0, 'first-steps has no event:tool:line step');
  for (let i = 0; i < toolIdx; i++) { await page.click('.ah-pop .ah-step-btns .ah-primary'); await atStep(i + 2); }
  await page.click('#tools button[data-tool="line"]');
  await atStep(toolIdx + 2);
  await page.keyboard.press('Escape');
  await waitFor(() => !document.querySelector('.ah-pop'), null, 'tour to end on Esc');
  await ev('const p = document.querySelector(".ash-help"); if (p && !p.hidden) document.querySelector(".ah-close")?.click();');

  step = 'F1 context';
  check((await hev('return data.context["#tools button[data-tool=\\"line\\"]"];')) === 'draw-lines-shapes', 'context key for the Line tool missing');
  const ctxTitle = await hev('return data.topics.find((t) => t.id === "draw-lines-shapes").title;');
  await ev('document.activeElement?.blur?.();');
  const tr = await rect('#tools button[data-tool="line"]');
  await page.mouse.move((tr.l + tr.r) / 2, (tr.t + tr.b) / 2);
  await page.keyboard.press('F1');
  await waitFor((t) => document.querySelector('.ash-help:not([hidden]) .ah-body h1')?.textContent?.trim() === t, ctxTitle, `"${ctxTitle}" from F1 over the Line tool`);
  await page.keyboard.press('Escape');
  await waitFor(() => document.querySelector('.ash-help')?.hidden, null, 'panel to close');

  step = 'dialog ?';
  const dTopic = await hev('return data.context["dialog:Drawing units"];');
  const dTitle = await hev('return data.topics.find((t) => t.id === arg.split("/")[0]).title;', dTopic);
  await menuItem('Format', 'Units…');
  await waitFor(() => document.querySelector('#dlg[open][data-help] .ah-q'), null, '#dlg[data-help] with a ? button');
  check((await text('#dlg h2')) === 'Drawing units', `dialog h2 is "${await text('#dlg h2')}" (the ? must sit beside the title, not in it)`);
  await page.click('#dlg .ah-q');
  await waitFor(() => document.querySelector('#dlg .ash-help:not([hidden])'), null, 'help panel inside #dlg');
  await waitFor((t) => document.querySelector('#dlg .ash-help .ah-body h1')?.textContent?.trim() === t, dTitle, `panel to show "${dTitle}"`);
  await page.fill('.ah-search', 'layer');
  await page.press('.ah-search', 'Enter');
  await page.waitForTimeout(200);
  check(await ev('return document.getElementById("dlg").open;'), 'Enter in the help search closed the dialog');
  await page.keyboard.press('Escape'); // closes the panel first
  await waitFor(() => document.querySelector('.ash-help')?.hidden, null, 'panel to close');
  check(await ev('return document.getElementById("dlg").open;'), 'Esc closed the dialog together with the help panel');
  await page.keyboard.press('Escape');
  await waitFor(() => !document.getElementById('dlg').open, null, 'dialog to close');

  step = 'welcome card';
  await ev('await window.api.settingsSet("help.welcomeShown", false);');
  check(await hev('return await H.maybeWelcome();'), 'maybeWelcome() returned false with the pref cleared');
  await waitFor(() => document.querySelector('.ah-welcome'), null, 'welcome card');
  await page.click('.ah-welcome [data-welcome="no"]');
  await waitFor(() => !document.querySelector('.ah-welcome'), null, 'welcome card to go');
  await page.waitForTimeout(150);
  check(!(await hev('return await H.maybeWelcome();')), 'maybeWelcome() showed the card again after Not now');
  check(!(await page.$('.ah-welcome')), 'welcome card is back after Not now');

  step = 'external link';
  await ev('window.open = () => null; (window.__ashShim ??= { opened: [] }).opened.length = 0;');
  await hev('H.openHelp("troubleshooting");');
  await waitFor(() => document.querySelector('.ah-content a.help-ext'), null, 'troubleshooting topic');
  await page.click('.ah-content a.help-ext');
  const opened = await ev('return [...window.__ashShim.opened];');
  check(opened.length >= 1 && opened[0].startsWith('https'), `openExternal got ${JSON.stringify(opened)}`);

  step = 'page errors';
  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('HELP OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
