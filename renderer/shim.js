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

  const KEY = 'ash-draw:';
  window.api = Object.freeze({
    isElectron: false,
    version: () => Promise.resolve('web'),
    openFiles,
    readFile: () => Promise.reject(new Error('readFile ' + NO_DESKTOP)),
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
    dwgAvailable: () => Promise.resolve({ available: false, version: null, reason: 'DWG conversion ' + NO_DESKTOP }),
    dwgToDxf: () => Promise.reject(new Error('DWG conversion ' + NO_DESKTOP)),
    dxfToDwg: () => Promise.reject(new Error('DWG conversion ' + NO_DESKTOP)),
  });
})();
