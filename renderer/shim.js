// Browser fallback for window.api (same contract as electron/preload.js).
// In Electron the preload has already exposed window.api and this file does nothing.
(function () {
  'use strict';
  if ('api' in window) return;
  const NO_DESKTOP = 'requires the desktop app';
  const toBytes = async (file) => new Uint8Array(await file.arrayBuffer());
  const accept = (filters) => (Array.isArray(filters) ? filters : [])
    .flatMap((f) => (Array.isArray(f && f.extensions) ? f.extensions : []))
    .filter((e) => typeof e === 'string' && e !== '*').map((e) => '.' + e).join(',');

  function openFiles(opts) {
    const o = opts || {};
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = !!o.multiple;
      const a = accept(o.filters);
      if (a) input.accept = a;
      input.addEventListener('cancel', () => resolve([]));
      input.addEventListener('change', () => {
        Promise.all(Array.from(input.files || []).map(async (f) => ({ path: null, name: f.name, bytes: await toBytes(f) })))
          .then(resolve, reject);
      });
      input.click();
    });
  }

  function saveFile(opts) {
    const o = opts || {};
    if (!(o.bytes instanceof Uint8Array || o.bytes instanceof ArrayBuffer)) return Promise.reject(new TypeError('bytes must be a Uint8Array'));
    const name = String(o.defaultPath || 'drawing').split(/[\\/]/).pop() || 'drawing';
    const url = URL.createObjectURL(new Blob([o.bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return Promise.resolve({ path: null });
  }

  // Symbols panel library folders: chosen with a folder picker, held in memory for this page only (same shapes as the
  // desktop's electron/symbols.js). DWG files are listed but cannot be read: their conversion needs the desktop app.
  const SYMBOL_EXT = /\.(dxf|dwg)$/i;
  const MAX_SYMBOL_FILES = 2000;
  const MAX_SYMBOL_FILE_BYTES = 8 * 1024 * 1024;
  const MAX_THUMB_BYTES = 256 * 1024;
  const symFolders = new Map(); // id -> { id, path: null, name, files: Map(rel -> File) }
  const symThumbs = new Map(); // id|rel|lastModified|size -> PNG bytes
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  const symInfo = (rel, f) => ({ rel, name: f.name, category: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '', size: f.size, mtimeMs: f.lastModified });
  const symListing = (fo) => {
    const files = [...fo.files].map(([rel, f]) => symInfo(rel, f));
    return { files, truncated: !!fo.truncated };
  };
  const symFolder = (id) => {
    const fo = typeof id === 'string' ? symFolders.get(id) : null;
    if (!fo) return Promise.reject(new Error('unknown symbol folder'));
    return Promise.resolve(fo);
  };
  const symFile = (id, rel) => symFolder(id).then((fo) => {
    const f = typeof rel === 'string' ? fo.files.get(rel) : null;
    if (!f) throw new TypeError('invalid symbol path');
    return f;
  });
  function symbolsAddFolder() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.webkitdirectory = true;
      input.multiple = true;
      input.addEventListener('cancel', () => resolve(null));
      input.addEventListener('change', () => {
        try {
          const all = Array.from(input.files || []).filter((f) => SYMBOL_EXT.test(f.name))
            .map((f) => ({ f, parts: String(f.webkitRelativePath || f.name).split('/') }))
            .sort((a, b) => a.parts.join('/').localeCompare(b.parts.join('/')));
          if (!all.length) { resolve(null); return; }
          const name = all[0].parts.length > 1 ? all[0].parts[0] : 'Symbols';
          const files = new Map();
          for (const { f, parts } of all.slice(0, MAX_SYMBOL_FILES)) files.set(parts.length > 1 ? parts.slice(1).join('/') : parts[0], f);
          const fo = { id: newId(), path: null, name, files, truncated: all.length > MAX_SYMBOL_FILES };
          symFolders.set(fo.id, fo);
          resolve({ id: fo.id, path: null, name, ...symListing(fo) });
        } catch (err) { reject(err); }
      });
      input.click();
    });
  }
  const thumbId = (id, rel, f) => `${id}|${rel}|${f.lastModified}|${f.size}`;

  const KEY = 'ash-draw:';
  window.api = Object.freeze({
    isElectron: false,
    version: () => Promise.resolve('web'),
    openFiles,
    readFile: () => Promise.reject(new Error('readFile ' + NO_DESKTOP)),
    xrefRead: () => Promise.resolve(null), // no folder access in the browser: xrefs stay "Not found"
    imageRead: () => Promise.resolve(null), // likewise raster images
    refsDecide: () => Promise.resolve(true),
    // drawing fragments as DXF text through the browser clipboard; rejects without one (the window keeps its own copy)
    clipboardWriteDxf: (dxf) => (navigator.clipboard?.writeText ? navigator.clipboard.writeText(dxf).then(() => true) : Promise.reject(new Error('no clipboard'))),
    clipboardReadDxf: () => (navigator.clipboard?.readText ? navigator.clipboard.readText() : Promise.resolve(null)),

    saveFile,
    writeFile: () => Promise.reject(new Error('writeFile ' + NO_DESKTOP)),
    getLaunchFiles: () => Promise.resolve([]),
    onOpenFile: () => () => {},
    onCloseRequest: () => () => {},
    closeWindow: () => Promise.resolve(false),
    // browser preview: print the PDF from a hidden frame (the browser's own PDF viewer and print dialog)
    print: (pdfBytes) => new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob([pdfBytes], { type: 'application/pdf' }));
      const f = Object.assign(document.createElement('iframe'), { src: url, style: 'position:fixed;width:0;height:0;border:0' });
      f.onload = () => { try { f.contentWindow.print(); resolve({ ok: true }); } catch (err) { resolve({ ok: false, reason: String(err) }); } setTimeout(() => { f.remove(); URL.revokeObjectURL(url); }, 60000); };
      document.body.append(f);
    }),
    setTitle: (t) => { document.title = String(t).slice(0, 200); return Promise.resolve(); },
    showItem: () => Promise.resolve(false),
    // help links open in a new browser tab (recorded for the e2e tests)
    openExternal: (url) => { (window.__ashShim ??= { opened: [] }).opened.push(String(url)); window.open(String(url), '_blank', 'noopener'); return Promise.resolve(true); },
    settingsGet: (k) => {
      try { const v = localStorage.getItem(KEY + k); return Promise.resolve(v == null ? undefined : JSON.parse(v)); } catch { return Promise.resolve(undefined); }
    },
    settingsSet: (k, v) => {
      try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* storage unavailable */ }
      return Promise.resolve();
    },
    sessionUpdate: () => Promise.resolve(true),
    sessionInfo: () => Promise.resolve({ mode: 'ask', offer: null }),
    sessionRestore: () => Promise.resolve(null),
    sessionDismiss: () => Promise.resolve(true),
    recentList: () => Promise.resolve([]),
    recentOpen: () => Promise.resolve(null),
    recentClear: () => Promise.resolve(true),
    symbolsAddFolder,
    symbolsFolders: () => Promise.resolve([...symFolders.values()].map((fo) => ({ id: fo.id, path: null, name: fo.name }))),
    symbolsRemoveFolder: (id) => symFolder(id).then((fo) => symFolders.delete(fo.id)),
    symbolsList: (id) => symFolder(id).then(symListing),
    symbolsRead: (id, rel) => symFile(id, rel).then(async (f) => {
      if (/\.dwg$/i.test(f.name)) throw Object.assign(new Error(`${f.name}: DWG symbols ${NO_DESKTOP} (DWG conversion); save the symbol as DXF to use it here`), { code: 'DWG_DESKTOP_ONLY' });
      if (f.size > MAX_SYMBOL_FILE_BYTES) throw new RangeError('symbol file too large');
      return { name: f.name, format: 'dxf', sourceFormat: 'dxf', bytes: await toBytes(f) };
    }),
    symbolsThumbGet: (id, rel) => symFile(id, rel).then((f) => symThumbs.get(thumbId(id, rel, f)) ?? null),
    symbolsThumbPut: (id, rel, png) => symFile(id, rel).then((f) => {
      if (!(png instanceof Uint8Array) || png.byteLength > MAX_THUMB_BYTES) throw new TypeError('thumbnail must be a PNG of at most 256 KB');
      symThumbs.set(thumbId(id, rel, f), png);
      return true;
    }),
    dwgAvailable: () => Promise.resolve({ available: false, version: null, reason: 'DWG conversion ' + NO_DESKTOP }),
    dwgToDxf: () => Promise.reject(new Error('DWG conversion ' + NO_DESKTOP)),
    dxfToDwg: () => Promise.reject(new Error('DWG conversion ' + NO_DESKTOP)),
  });
})();
