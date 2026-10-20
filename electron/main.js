// ASH Draw Studio - Electron main process.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, screen, session, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { promises as fs, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWrite, saveDrawingFile } from './backup.js';
import { createAutosaveStore } from './autosave.js';
import { converterProcs, sweepConverterTemp } from './converterProcs.js';
import { converterPath, createDwgBridge, DWG_OUT_VERSIONS } from './dwgBridge.js';
import { cacheLimitBytes, createDwgCache, openCached } from './dwgCache.js';
import { createHandoffStore } from './handoff.js';
import { createClipboardBridge } from './clipboard.js';
import { createDwgService, createOdaBridge, DWG_MODES, findOdaConverter, isOdaExeName, ODA_DOWNLOAD_URL, ODA_DWG_VERSIONS } from './odaConverter.js';
import { lockData, onSecondInstance } from './instance.js';
import { saveDialogDefault, openDialogDir } from './savePath.js';
import { createSymbolLibrary } from './symbols.js';
import { cleanSession, isPathString, pushRecent, startupModeOf } from './sessionLists.js';
import { createRefAccess } from './refAccess.js';
import { createAppFileServer } from './appFiles.js';
import { openedFiles } from './openedFiles.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEME = 'app';
const HOST = 'drawstudio';
const START_URL = `${SCHEME}://${HOST}/renderer/index.html`;
const SERVED_DIRS = ['renderer', 'src'].map((d) => path.join(APP_ROOT, d) + path.sep);
const IS_DEV = process.argv.includes('--dev');
const DRAWING_EXT = /\.(dxf|dwg)$/i;
const MAX_FILE_BYTES = 1536 * 1024 * 1024; // matches the DWG bridge cap: big DWGs expand to 500+ MB of DXF
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

// The lock is per userData (the Portable build has its own); the data tells a running copy which exe was refused.
if (!app.requestSingleInstanceLock(lockData({ exe: process.execPath, version: app.getVersion() }))) {
  app.quit();
  process.exit(0);
}

const libredwgDir = process.env.ASH_LIBREDWG_DIR
  || (app.isPackaged ? path.join(process.resourcesPath, 'libredwg') : path.join(APP_ROOT, 'build', 'libredwg'));
let dwg = null; // created after ready (temp path needs app)
const dwgJobs = new Map(); // dwg:open job id -> AbortController of its conversion

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

async function readGranted(p) {
  const st = await fs.stat(p);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > MAX_FILE_BYTES) throw new RangeError('file too large');
  return new Uint8Array(await fs.readFile(p));
}

// ---- converted drawings for the DXF reader worker: one-time app://drawstudio/_open/<token> URLs ----
// The DXF of a converted DWG (hundreds of MB for big drawings) is fetched by the window's reader worker instead of
// being structured-cloned through IPC on the window's thread. A token is random, served once, and expires.
const OPEN_PREFIX = '/_open/';
const handoffs = createHandoffStore({ ttlMs: 60_000, maxEntries: 2 });
const handOff = (bytes) => `${SCHEME}://${HOST}${OPEN_PREFIX}${handoffs.put(bytes)}`;
const tokenOf = (url) => { try { const u = new URL(String(url)); return u.host === HOST && u.pathname.startsWith(OPEN_PREFIX) ? u.pathname.slice(OPEN_PREFIX.length) : null; } catch { return null; } };

// ---- small JSON stores in userData ----
const storePath = (n) => path.join(app.getPath('userData'), n);
async function loadJson(n) { try { return JSON.parse(await fs.readFile(storePath(n), 'utf8')); } catch { return {}; } }
async function saveJson(n, obj) { await fs.mkdir(app.getPath('userData'), { recursive: true }); await atomicWrite(storePath(n), JSON.stringify(obj, null, 2)); }
let settings = null;
// converted-drawing cache: <userData>/dwg-cache, limit from the setting 'dwg.cacheMaxMB' (default 2 GB, 0 = off)
const dwgCache = createDwgCache({ dir: () => path.join(app.getPath('userData'), 'dwg-cache'), limitBytes: () => cacheLimitBytes(settings?.['dwg.cacheMaxMB']) });
const autosave = createAutosaveStore({ dir: () => path.join(app.getPath('userData'), 'autosave'), appVersion: app.getVersion() });
// Symbols panel folders: only a folder chosen in the dialog becomes a root (its own store, not settings.json)
const symbols = createSymbolLibrary({
  dir: () => app.getPath('userData'),
  pickFolder: async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0] ?? null; },
  toDxf: (bytes) => dwg.toDxf(bytes),
  newId: () => randomBytes(8).toString('hex'),
});

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
// A started copy's files open here, also when it is another build sharing our settings (which gets a non-blocking notice).
app.on('second-instance', (_e, argv, cwd, additionalData) => onSecondInstance({ argv, cwd, additionalData }, {
  me: { exe: process.execPath, version: app.getVersion() },
  drawingArgs,
  openFile: forwardFile,
  notify: (message) => { dialog.showMessageBox({ type: 'info', title: 'ASH Draw Studio', message, buttons: ['OK'] }).catch(() => {}); },
  focus: () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } },
}));
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
const refs = createRefAccess({ pathLib: path, isFile, isGranted: (p) => granted.has(key(p)) }); // xref/image paths (reviewer #22)
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
// Also written shortly after every tab change, so an abnormal end (crash, power loss, Windows update) still restores the tabs.
let sessionTimer = null;
function saveSessionSoon() { clearTimeout(sessionTimer); sessionTimer = setTimeout(() => { sessionTimer = null; saveSession(); }, 1000); }
app.on('will-quit', () => { clearTimeout(sessionTimer); sessionTimer = null; saveSession(); });
// A conversion still running at quit: kill the converters (with ODA's own processes) and remove their temp folders, which
// can hold a DWG and a 500 MB DXF. Not on before-quit: closing the window may still be cancelled at the unsaved-changes prompt.
app.on('will-quit', () => converterProcs.killAll());
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

// ---- app:// protocol: serve renderer/ and src/ only (electron/appFiles.js) ----
const serveAppFile = createAppFileServer({ host: HOST, root: APP_ROOT, servedDirs: SERVED_DIRS, openPrefix: OPEN_PREFIX, take: (t) => handoffs.take(t) });

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
    const isDir = (d) => { try { return statSync(d).isDirectory(); } catch { return false; } };
    const r = await dialog.showOpenDialog(win, {
      defaultPath: openDialogDir(o.defaultPath, { isDir }), // the active drawing's folder, else the last-used one
      filters: asFilters(o.filters),
      properties: o.multiple === true ? ['openFile', 'multiSelections'] : ['openFile'],
    });
    if (r.canceled) return [];
    return openedFiles(r.filePaths, { grant, read: readGranted }); // a .dwg without bytes: dwg:open converts it from the path
  });
  handle('file:read', (p) => readGranted(grantedPath(p)));
  // An external reference of an open drawing: the host must be a granted file; only the .dxf/.dwg files that the xref
  // search order yields (host folder + relative path, the path itself, the file name in the host folder) are read, and
  // one outside the host's folder only after the user agreed (refAccess.js, refs:decide); until then it comes back in
  // { refused, declined } without being touched. The renderer never names an arbitrary file, and the xref is not
  // granted. DWG comes back converted to DXF.
  handle('xref:read', async (hostPath, refPath) => {
    const host = grantedPath(hostPath);
    if (typeof refPath !== 'string' || !refPath || refPath.length > 1024 || refPath.includes('\0')) throw new TypeError('invalid xref path');
    const r = await refs.find(host, refPath, (ext) => ext === '.dxf' || ext === '.dwg');
    if (!r?.path) return r;
    const p = r.path, ext = path.extname(p).toLowerCase();
    const bytes = await readGranted(p);
    return { path: p, name: path.basename(p), format: ext.slice(1), bytes: ext === '.dwg' ? (await dwg.toDxf(bytes)).dxfBytes : bytes };
  });
  // A raster image of an open drawing (IMAGE entity): same search order, host check and outside-folder rule as
  // xref:read; only png/jpg/jpeg/bmp/gif files up to MAX_IMAGE_BYTES are read.
  handle('image:read', async (hostPath, refPath) => {
    const host = grantedPath(hostPath);
    if (typeof refPath !== 'string' || !refPath || refPath.length > 1024 || refPath.includes('\0')) throw new TypeError('invalid image path');
    const r = await refs.find(host, refPath, (ext) => !!IMAGE_MIME[ext]);
    if (!r?.path) return r;
    const p = r.path;
    if ((await fs.stat(p)).size > MAX_IMAGE_BYTES) throw new RangeError('image file too large');
    return { path: p, name: path.basename(p), mime: IMAGE_MIME[path.extname(p).toLowerCase()], bytes: new Uint8Array(await fs.readFile(p)) };
  });
  // The user's answer to "This drawing refers to files outside its folder": load (the listed paths; only those that
  // xref:read / image:read refused for this host are approved) or don't load (this host, for the rest of the session).
  handle('refs:decide', (hostPath, load, paths) => {
    const host = grantedPath(hostPath);
    if (typeof load !== 'boolean') throw new TypeError('load must be a boolean');
    if (!Array.isArray(paths) || paths.length > 1000) throw new TypeError('paths must be an array');
    return refs.decide(host, load, paths.filter((p) => isPathString(p)));
  });
  handle('dialog:save', async (opts) => {
    const o = plainObject(opts);
    const bytes = asBytes(o.bytes);
    if (o.defaultPath != null && (typeof o.defaultPath !== 'string' || o.defaultPath.length > 1024)) throw new TypeError('invalid defaultPath');
    // The dialog opens in the drawing's folder when defaultPath carries an existing one, else in Documents.
    const isDir = (d) => { try { return statSync(d).isDirectory(); } catch { return false; } };
    const r = await dialog.showSaveDialog(win, { defaultPath: saveDialogDefault(o.defaultPath, { documents: app.getPath('documents'), isDir }), filters: asFilters(o.filters) });
    if (r.canceled || !r.filePath) return null;
    const { backup, warning } = await saveDrawingFile(r.filePath, bytes); // an existing .dxf/.dwg is copied to .bak first
    return { path: grant(r.filePath), backup, ...(warning ? { warning } : {}) };
  });
  handle('file:write', async (opts) => {
    const o = plainObject(opts);
    const p = grantedPath(o.path);
    return saveDrawingFile(p, asBytes(o.bytes)); // an existing .dxf/.dwg is copied to .bak first
  });
  // ---- autosave (reviewer #29): copies of drawings with unsaved changes in <userData>/autosave, named by id only
  handle('autosave:write', (id, bytes, meta) => autosave.write(id, asBytes(bytes, 'DXF data'), plainObject(meta)));
  handle('autosave:list', () => autosave.list());
  handle('autosave:read', (id) => autosave.read(id));
  handle('autosave:discard', (id) => autosave.discard(id));
  // ---- Symbols panel: folders by opaque id, files by a path relative to one (electron/symbols.js validates both)
  handle('symbols:addFolder', () => symbols.addFolder());
  handle('symbols:folders', () => symbols.folders());
  handle('symbols:removeFolder', (id) => symbols.removeFolder(id));
  handle('symbols:list', (id) => symbols.list(id));
  handle('symbols:read', (id, rel) => symbols.read(id, rel));
  handle('symbols:thumbGet', (id, rel) => symbols.thumbGet(id, rel));
  handle('symbols:thumbPut', (id, rel, png) => symbols.thumbPut(id, rel, png));
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
  const clip = createClipboardBridge(clipboard); // drawing fragments as DXF text; the renderer never names a format
  handle('clipboard:writeDxf', (dxf) => clip.write(dxf));
  handle('clipboard:readDxf', () => clip.read());
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
    saveSessionSoon();
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
  // Opening a DWG: the source is a granted path (read here, not in the window) or the DWG bytes; the DXF comes back
  // as a one-time URL (handOff) that the window's reader worker fetches.
  // A DWG opened from a path goes through the converted-drawing cache (electron/dwgCache.js): an unchanged file is
  // not converted again.
  // `job` (optional, from the window): dwg:cancel(job) kills that open's conversion (the progress toast's Cancel)
  handle('dwg:open', async (src, job) => {
    const ac = new AbortController();
    const id = typeof job === 'string' && job.length <= 64 ? job : null;
    if (id) dwgJobs.set(id, ac);
    try { return await openDwg(src, ac.signal); } finally { if (id && dwgJobs.get(id) === ac) dwgJobs.delete(id); }
  });
  handle('dwg:cancel', (job) => { if (typeof job === 'string') dwgJobs.get(job)?.abort(); });
  async function openDwg(src, signal) {
    if (typeof src === 'string') {
      const p = grantedPath(src);
      settings ??= await loadJson('settings.json');
      const av = await dwg.available();
      const binStat = async (f) => { try { const st = await fs.stat(f); return [st.size, st.mtimeMs]; } catch { return null; } }; // the binary itself, not only its reported version
      const converter = JSON.stringify([av.mode, av.libredwg?.version ?? null, await binStat(converterPath(libredwgDir, process.platform, 'dwg2dxf')),
        av.oda?.available ? (av.oda.path ?? null) : null, av.oda?.version ?? null, av.oda?.available && av.oda.path ? await binStat(av.oda.path) : null]);
      const { dxfBytes, warnings, engine, converter: conv, errorCount, log, dwgSize, header, cached } = await openCached(dwgCache, p, { converter, read: readGranted, convert: (b) => dwg.toDxf(b, { signal }) });
      return { url: handOff(dxfBytes), size: dxfBytes.byteLength, dwgSize, header, warnings, engine, converter: conv, errorCount, log, cached };
    }
    const bytes = asBytes(src, 'DWG data');
    const { dxfBytes, warnings, engine, converter, errorCount, log } = await dwg.toDxf(bytes, { signal });
    const header = Buffer.from(bytes.subarray(0, 6)).toString('latin1'); // "AC1032": the DWG version, kept for Save in the same version
    return { url: handOff(dxfBytes), size: dxfBytes.byteLength, dwgSize: bytes.byteLength, header, warnings, engine, converter, errorCount, log };
  }
  handle('dwg:cacheInfo', async () => {
    settings ??= await loadJson('settings.json');
    return { ...(await dwgCache.info()), limitBytes: cacheLimitBytes(settings['dwg.cacheMaxMB']) };
  });
  handle('dwg:cacheClear', () => dwgCache.clear());
  // the window gives a hand-off back unserved (a cancelled or failed open), so main does not hold the DXF until it expires
  handle('dwg:release', (url) => { const t = tokenOf(url); if (t) handoffs.release(t); });
  handle('dwg:fromDxf', (opts) => {
    const o = plainObject(opts);
    const version = o.version ?? 'r2000';
    const versions = [...Object.keys(ODA_DWG_VERSIONS), ...DWG_OUT_VERSIONS]; // ODA versions, then LibreDWG's
    if (!versions.includes(version)) throw new RangeError(`version must be one of ${versions.join(', ')}`);
    return dwg.fromDxf(asBytes(o.dxfBytes, 'DXF data'), version);
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle(SCHEME, serveAppFile);
  const tmpRoot = app.getPath('temp');
  sweepConverterTemp(tmpRoot).catch(() => {}); // folders a killed conversion left behind (older than 2 hours)
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
