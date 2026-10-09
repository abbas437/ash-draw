// ASH Draw Studio - Electron main process.
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen, session, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { promises as fs, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDwgBridge, DWG_OUT_VERSIONS } from './dwgBridge.js';
import { createDwgService, createOdaBridge, DWG_MODES, findOdaConverter, isOdaExeName, ODA_DOWNLOAD_URL } from './odaConverter.js';
import { cleanSession, isPathString, pushRecent, startupModeOf } from './sessionLists.js';
import { xrefCandidates } from '../src/core/xref.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEME = 'app';
const HOST = 'drawstudio';
const START_URL = `${SCHEME}://${HOST}/renderer/index.html`;
const SERVED_DIRS = ['renderer', 'src'].map((d) => path.join(APP_ROOT, d) + path.sep);
const IS_DEV = process.argv.includes('--dev');
const DRAWING_EXT = /\.(dxf|dwg)$/i;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.gif': 'image/gif' };

// Portable build: keep all state next to the .exe instead of %APPDATA%.
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'ASH-Draw-Studio-data'));
}
app.enableSandbox();

// The renderer is served from the privileged scheme app://drawstudio/, confined to renderer/ and src/.
// A real origin makes CSP 'self', import maps, ES modules and fetch() behave as on a web server.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const libredwgDir = process.env.ASH_LIBREDWG_DIR
  || (app.isPackaged ? path.join(process.resourcesPath, 'libredwg') : path.join(APP_ROOT, 'build', 'libredwg'));
let dwg = null; // created after ready (temp path needs app)

/** @type {BrowserWindow|null} */
let win = null;
let rendererReady = false;
const pendingFiles = [];

// ---- path grants: only paths chosen in a dialog or passed on argv this session ----
const granted = new Set();
const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const grant = (p) => { granted.add(key(p)); return path.resolve(p); };
function grantedPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0')) throw new TypeError('invalid path');
  if (!granted.has(key(p))) throw new Error('path was not opened or chosen in this session');
  return path.resolve(p);
}

// ---- validation helpers ----
function asBytes(b, what = 'bytes') {
  if (b instanceof Uint8Array) {
    if (b.byteLength > MAX_FILE_BYTES) throw new RangeError(`${what} too large`);
    return b;
  }
  if (b instanceof ArrayBuffer) return asBytes(new Uint8Array(b), what);
  throw new TypeError(`${what} must be a Uint8Array`);
}
function asFilters(f) {
  if (f == null) return [];
  if (!Array.isArray(f) || f.length > 20) throw new TypeError('filters must be an array');
  return f.map((x) => {
    if (!x || typeof x.name !== 'string' || x.name.length > 80 || !Array.isArray(x.extensions) || x.extensions.length > 30) throw new TypeError('invalid filter');
    for (const e of x.extensions) if (typeof e !== 'string' || !/^(\*|[A-Za-z0-9]{1,10})$/.test(e)) throw new TypeError('invalid filter extension');
    return { name: x.name, extensions: [...x.extensions] };
  });
}
const plainObject = (o) => o == null ? {} : (typeof o === 'object' && !Array.isArray(o) ? o : (() => { throw new TypeError('options must be an object'); })());

async function atomicWrite(target, bytes) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, bytes, { flag: 'wx' });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
async function readGranted(p) {
  const st = await fs.stat(p);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > MAX_FILE_BYTES) throw new RangeError('file too large');
  return new Uint8Array(await fs.readFile(p));
}

// ---- small JSON stores in userData ----
const storePath = (n) => path.join(app.getPath('userData'), n);
async function loadJson(n) { try { return JSON.parse(await fs.readFile(storePath(n), 'utf8')); } catch { return {}; } }
async function saveJson(n, obj) { await fs.mkdir(app.getPath('userData'), { recursive: true }); await atomicWrite(storePath(n), JSON.stringify(obj, null, 2)); }
let settings = null;

// ---- launch files (argv / second instance / macOS open-file) ----
function drawingArgs(argv, cwd) {
  return argv.slice(1).filter((a) => typeof a === 'string' && !a.startsWith('-') && DRAWING_EXT.test(a))
    .map((a) => path.resolve(cwd ?? process.cwd(), a))
    .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
}
function forwardFile(p) {
  const file = { path: grant(p), name: path.basename(p) };
  if (rendererReady && win && !win.isDestroyed()) win.webContents.send('app:openFile', file);
  else pendingFiles.push(file);
}
app.on('open-file', (e, p) => { e.preventDefault(); if (DRAWING_EXT.test(p)) forwardFile(p); });
app.on('second-instance', (_e, argv, cwd) => {
  for (const p of drawingArgs(argv, cwd)) forwardFile(p);
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
for (const p of drawingArgs(process.argv)) forwardFile(p);

// ---- last session and recent files ----
// Main owns both lists. The renderer only reports its tabs' paths (app:sessionUpdate); paths that were not granted
// this session are dropped, and a recorded path is granted again only when the user chooses to reopen it.
let current = { files: [], active: null }; // the open tabs' granted paths, saved as session.json at quit
let savedSession = { files: [], active: null }; // the previous run's tabs
let sessionOffer = null; // { auto }: the previous session may be reopened once, until answered
let recent = []; // paths, newest first (recent.json)
function readJsonSync(n) { try { return JSON.parse(readFileSync(storePath(n), 'utf8')); } catch { return null; } }
function writeJsonSync(n, value) { // sync: also runs in will-quit
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    const tmp = `${storePath(n)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, storePath(n));
  } catch (err) { console.error('could not save', n, err.message); }
}
const isFile = (p) => fs.stat(p).then((s) => s.isFile(), () => false);
function loadSessionAndRecent() {
  savedSession = cleanSession(readJsonSync('session.json'), () => true, key) ?? { files: [], active: null };
  const r = readJsonSync('recent.json');
  recent = pushRecent(Array.isArray(r) ? r : [], [], key);
}
function saveSession() {
  // Never answered and nothing open: keep the previous session for the next start.
  const s = !current.files.length && sessionOffer ? savedSession : current;
  writeJsonSync('session.json', { version: 1, ...s });
}
app.on('will-quit', saveSession);
// Reopens the previous session: existing files are granted again and returned; deleted or moved ones in `missing`.
async function restoreSession() {
  sessionOffer = null;
  const files = [];
  const missing = [];
  for (const p of savedSession.files) {
    if (await isFile(p)) files.push({ path: grant(p), name: path.basename(p) });
    else missing.push(p);
  }
  const active = files.some((f) => key(f.path) === key(savedSession.active ?? '')) ? savedSession.active : null;
  return { files, active, missing };
}

// ---- window ----
function visibleBounds(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  const ok = screen.getAllDisplays().some(({ workArea: w }) => b.x < w.x + w.width - 50 && b.x + b.width > w.x + 50 && b.y >= w.y - 10 && b.y < w.y + w.height - 50);
  return ok ? { x: b.x, y: b.y, width: Math.max(640, b.width), height: Math.max(480, b.height) } : null;
}

async function createWindow() {
  const state = await loadJson('window-state.json');
  const bounds = visibleBounds(state.bounds) ?? { width: 1400, height: 900 };
  win = new BrowserWindow({
    ...bounds, minWidth: 640, minHeight: 480, show: false, backgroundColor: '#e9edef', title: 'ASH Draw Studio',
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(APP_ROOT, 'electron', 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      webviewTag: false, spellcheck: false, devTools: IS_DEV,
    },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  // The renderer sets a beforeunload guard while a drawing has unsaved changes; without this handler Electron would
  // silently refuse to close the window. The renderer then asks about each drawing (Save / Don't save / Cancel) and
  // calls app:closeWindow when the user has answered all of them; if the renderer is not ready, ask here instead.
  win.webContents.on('will-prevent-unload', (event) => {
    if (rendererReady) { win.webContents.send('app:closeRequest'); return; }
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Keep working', 'Discard changes and close'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'Unsaved changes', message: 'There are unsaved changes.', detail: 'If you close now, they will be lost.',
    });
    if (choice === 1) event.preventDefault(); // preventDefault = ignore the guard and unload
  });
  win.on('close', () => {
    saveJson('window-state.json', { bounds: win.getNormalBounds(), maximized: win.isMaximized() }).catch(() => {});
  });
  win.on('closed', () => { win = null; rendererReady = false; });
  if (IS_DEV) {
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
    });
  }
  await win.loadURL(START_URL);
}

// ---- app:// protocol: serve renderer/ and src/ only ----
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2',
};
async function serveAppFile(request) {
  const url = new URL(request.url);
  if (url.host !== HOST) return new Response('Not found', { status: 404 });
  const file = path.resolve(APP_ROOT, '.' + decodeURIComponent(url.pathname));
  if (!SERVED_DIRS.some((d) => file.startsWith(d))) return new Response('Not found', { status: 404 });
  try {
    return new Response(await fs.readFile(file), {
      headers: { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// Every web contents: no new windows, no navigation away, no webviews.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-redirect', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

// ---- IPC ----
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    const url = event.senderFrame?.url ?? '';
    if (url.split(/[?#]/)[0] !== START_URL || event.sender !== win?.webContents) throw new Error('unauthorised sender');
    return fn(...args);
  });
}

function registerIpc() {
  handle('dialog:open', async (opts) => {
    const o = plainObject(opts);
    const r = await dialog.showOpenDialog(win, {
      filters: asFilters(o.filters),
      properties: o.multiple === true ? ['openFile', 'multiSelections'] : ['openFile'],
    });
    if (r.canceled) return [];
    const out = [];
    for (const p of r.filePaths) out.push({ path: grant(p), name: path.basename(p), bytes: await readGranted(p) });
    return out;
  });
  handle('file:read', (p) => readGranted(grantedPath(p)));
  // An external reference of an open drawing: the host must be a granted file; only the .dxf/.dwg files that the xref
  // search order yields (host folder + relative path, the path itself, the file name in the host folder) are read.
  // The renderer never names an arbitrary file, and the xref is not granted. DWG comes back converted to DXF.
  handle('xref:read', async (hostPath, refPath) => {
    const host = grantedPath(hostPath);
    if (typeof refPath !== 'string' || !refPath || refPath.length > 1024 || refPath.includes('\0')) throw new TypeError('invalid xref path');
    for (const p of xrefCandidates(host, refPath, path)) {
      const ext = path.extname(p).toLowerCase();
      if ((ext !== '.dxf' && ext !== '.dwg') || !(await isFile(p))) continue;
      const bytes = await readGranted(p);
      return { path: p, name: path.basename(p), format: ext.slice(1), bytes: ext === '.dwg' ? (await dwg.toDxf(bytes)).dxfBytes : bytes };
    }
    return null;
  });
  // A raster image of an open drawing (IMAGE entity): same search order and host check as xref:read; only
  // png/jpg/jpeg/bmp/gif files up to MAX_IMAGE_BYTES are read.
  handle('image:read', async (hostPath, refPath) => {
    const host = grantedPath(hostPath);
    if (typeof refPath !== 'string' || !refPath || refPath.length > 1024 || refPath.includes('\0')) throw new TypeError('invalid image path');
    for (const p of xrefCandidates(host, refPath, path)) {
      const ext = path.extname(p).toLowerCase();
      if (!IMAGE_MIME[ext] || !(await isFile(p))) continue;
      if ((await fs.stat(p)).size > MAX_IMAGE_BYTES) throw new RangeError('image file too large');
      return { path: p, name: path.basename(p), mime: IMAGE_MIME[ext], bytes: new Uint8Array(await fs.readFile(p)) };
    }
    return null;
  });
  handle('dialog:save', async (opts) => {
    const o = plainObject(opts);
    const bytes = asBytes(o.bytes);
    if (o.defaultPath != null && (typeof o.defaultPath !== 'string' || o.defaultPath.length > 255)) throw new TypeError('invalid defaultPath');
    // Only the file name is honoured; the folder is the user's Documents folder.
    const name = o.defaultPath ? path.basename(o.defaultPath) : 'drawing.dxf';
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), name), filters: asFilters(o.filters) });
    if (r.canceled || !r.filePath) return null;
    await atomicWrite(r.filePath, bytes);
    return { path: grant(r.filePath) };
  });
  handle('file:write', async (opts) => {
    const o = plainObject(opts);
    const p = grantedPath(o.path);
    await atomicWrite(p, asBytes(o.bytes));
    return { path: p };
  });
  handle('app:launchFiles', () => { rendererReady = true; return pendingFiles.splice(0); });
  // Print a plot: the renderer builds the PDF; it is written to a private temp folder, shown in a hidden window by
  // Electron's PDF viewer and printed from there with the system print dialog (printer, copies). Never the app window.
  handle('app:print', async (bytes) => {
    const pdf = asBytes(bytes, 'PDF data');
    if (Buffer.from(pdf.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new TypeError('not a PDF document');
    const dir = await fs.mkdtemp(path.join(app.getPath('temp'), 'ash-draw-print-')); // created 0700
    const file = path.join(dir, 'plot.pdf');
    let pw = null;
    try {
      await fs.writeFile(file, pdf, { flag: 'wx', mode: 0o600 });
      pw = new BrowserWindow({
        show: false, parent: win,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, plugins: true, devTools: false },
      });
      await pw.loadURL(pathToFileURL(file).href);
      return await new Promise((resolve) => {
        pw.webContents.print({ silent: false }, (ok, reason) => resolve({ ok, reason: ok ? undefined : reason }));
      });
    } finally {
      if (pw && !pw.isDestroyed()) pw.destroy();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  handle('app:closeWindow', () => { setImmediate(() => win?.close()); return true; });
  handle('app:version', () => app.getVersion());
  handle('app:setTitle', (t) => {
    if (typeof t !== 'string') throw new TypeError('title must be a string');
    win.setTitle(t.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200));
  });
  handle('shell:showItem', (p) => { shell.showItemInFolder(grantedPath(p)); return true; });
  handle('app:settingsGet', async (k) => {
    if (typeof k !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(k)) throw new TypeError('invalid settings key');
    settings ??= await loadJson('settings.json');
    return Object.hasOwn(settings, k) ? settings[k] : undefined;
  });
  handle('app:settingsSet', async (k, v) => {
    if (typeof k !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(k)) throw new TypeError('invalid settings key');
    const json = JSON.stringify(v ?? null);
    if (json.length > 64 * 1024) throw new RangeError('settings value too large');
    settings ??= await loadJson('settings.json');
    settings[k] = JSON.parse(json);
    await saveJson('settings.json', settings);
  });
  // ---- last session and recent files (see "last session and recent files" above)
  handle('app:sessionUpdate', (v) => {
    const next = cleanSession(v, (p) => granted.has(key(p)), key);
    if (!next) throw new TypeError('sessionUpdate: { files: [path], active } expected');
    const before = new Set(current.files.map(key));
    current = next;
    const added = next.files.filter((p) => !before.has(key(p)));
    if (added.length) { recent = pushRecent(recent, added, key); writeJsonSync('recent.json', recent); }
    return true;
  });
  // { mode, offer: { count, auto } | null }
  handle('app:sessionInfo', async () => {
    settings ??= await loadJson('settings.json');
    const count = savedSession.files.length;
    return { mode: startupModeOf(settings['startup.mode']), offer: sessionOffer && count ? { count, auto: sessionOffer.auto } : null };
  });
  handle('app:sessionRestore', () => (sessionOffer ? restoreSession() : null));
  handle('app:sessionDismiss', () => { sessionOffer = null; return true; });
  handle('app:recentList', () => Promise.all(recent.map(async (p) => ({ path: p, name: path.basename(p), folder: path.dirname(p), exists: await isFile(p) }))));
  // An entry of the recent list, granted again after a check that it still exists; null when it is missing.
  handle('app:recentOpen', async (p) => {
    if (!isPathString(p) || !recent.some((q) => key(q) === key(p))) throw new Error('recentOpen: not in the recent files list');
    if (!(await isFile(p))) return null;
    return { path: grant(p), name: path.basename(p) };
  });
  handle('app:recentClear', () => { recent = []; writeJsonSync('recent.json', recent); return true; });
  // DWG converter preference: settings 'dwg.converter' (auto | oda | libredwg) and 'dwg.odaPath' (validated at use).
  handle('dwg:config', async () => { settings ??= await loadJson('settings.json'); return { mode: settings['dwg.converter'] ?? 'auto', odaPath: settings['dwg.odaPath'] ?? '' }; });
  handle('dwg:setConfig', async (opts) => {
    const o = plainObject(opts);
    if (!DWG_MODES.includes(o.mode)) throw new RangeError(`mode must be one of ${DWG_MODES.join(', ')}`);
    if (o.odaPath !== '' && (!isPathString(o.odaPath) || !path.isAbsolute(o.odaPath) || !isOdaExeName(o.odaPath))) throw new TypeError('the ODA path must be the full path of ODAFileConverter.exe');
    settings ??= await loadJson('settings.json');
    settings['dwg.converter'] = o.mode; settings['dwg.odaPath'] = o.odaPath;
    await saveJson('settings.json', settings);
    return true;
  });
  handle('dwg:browseOda', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Locate ODAFileConverter.exe', filters: [{ name: 'ODA File Converter', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }], properties: ['openFile'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  // Only this fixed https address is ever opened (allow-list of one); the renderer passes nothing.
  handle('shell:openOdaDownload', () => {
    const u = new URL(ODA_DOWNLOAD_URL);
    if (u.protocol !== 'https:' || u.hostname !== 'www.opendesign.com') throw new Error('download address not allowed');
    return shell.openExternal(u.href).then(() => true);
  });
  handle('dwg:available', () => dwg.available());
  handle('dwg:toDxf', (bytes) => dwg.toDxf(asBytes(bytes, 'DWG data')));
  handle('dwg:fromDxf', (opts) => {
    const o = plainObject(opts);
    const version = o.version ?? 'r2000';
    if (!DWG_OUT_VERSIONS.includes(version)) throw new RangeError(`version must be one of ${DWG_OUT_VERSIONS.join(', ')}`);
    return dwg.fromDxf(asBytes(o.dxfBytes, 'DXF data'), version);
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle(SCHEME, serveAppFile);
  const tmpRoot = app.getPath('temp');
  const programFiles = [...new Set([process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files'].filter(Boolean))];
  dwg = createDwgService({
    libre: createDwgBridge(libredwgDir, process.platform, { tmpRoot }),
    getConfig: () => ({ mode: settings?.['dwg.converter'], odaPath: settings?.['dwg.odaPath'] || '' }),
    detectOda: () => (process.platform === 'win32' ? findOdaConverter(programFiles) : Promise.resolve(null)),
    makeOda: (exe) => createOdaBridge(exe, { tmpRoot }),
  });
  registerIpc();
  // Files given at start-up take priority: the previous session is then only offered, never reopened automatically.
  settings ??= await loadJson('settings.json');
  loadSessionAndRecent();
  const mode = startupModeOf(settings['startup.mode']);
  if (mode !== 'new' && savedSession.files.length) sessionOffer = { auto: mode === 'restore' && pendingFiles.length === 0 };
  await createWindow();
});

app.on('window-all-closed', () => app.quit());
