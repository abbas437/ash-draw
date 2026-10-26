// Sandboxed preload (runs as a classic CommonJS-style script; ESM is not supported
// in sandboxed preloads). Exposes the minimal window.api contract documented in README.md.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  isElectron: true,
  version: () => invoke('app:version'),
  openFiles: (opts) => invoke('dialog:open', opts),
  readFile: (p) => invoke('file:read', p),
  xrefRead: (hostPath, refPath) => invoke('xref:read', hostPath, refPath),
  imageRead: (hostPath, refPath) => invoke('image:read', hostPath, refPath),
  refsDecide: (hostPath, load, paths) => invoke('refs:decide', hostPath, load, paths),
  saveFile: (opts) => invoke('dialog:save', opts),
  writeFile: (p, bytes) => invoke('file:write', { path: p, bytes }),
  getLaunchFiles: () => invoke('app:launchFiles'),
  onOpenFile: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, file) => cb(file);
    ipcRenderer.on('app:openFile', listener);
    return () => ipcRenderer.removeListener('app:openFile', listener);
  },
  onCloseRequest: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('callback must be a function');
    const listener = () => cb();
    ipcRenderer.on('app:closeRequest', listener);
    return () => ipcRenderer.removeListener('app:closeRequest', listener);
  },
  closeWindow: () => invoke('app:closeWindow'),
  print: (pdfBytes) => invoke('app:print', pdfBytes),
  setTitle: (t) => invoke('app:setTitle', t),
  showItem: (p) => invoke('shell:showItem', p),
  settingsGet: (k) => invoke('app:settingsGet', k),
  clipboardWriteDxf: (dxf) => invoke('clipboard:writeDxf', dxf),
  clipboardReadDxf: () => invoke('clipboard:readDxf'),
  settingsSet: (k, v) => invoke('app:settingsSet', k, v),
  // last session and recent files (main owns both lists)
  sessionUpdate: (s) => invoke('app:sessionUpdate', s),
  sessionInfo: () => invoke('app:sessionInfo'),
  sessionRestore: () => invoke('app:sessionRestore'),
  sessionDismiss: () => invoke('app:sessionDismiss'),
  recentList: () => invoke('app:recentList'),
  recentOpen: (p) => invoke('app:recentOpen', p),
  recentClear: () => invoke('app:recentClear'),
  // autosave copies of drawings with unsaved changes (ids only, never paths)
  autosaveWrite: (id, bytes, meta) => invoke('autosave:write', id, bytes, meta),
  autosaveList: () => invoke('autosave:list'),
  autosaveRead: (id) => invoke('autosave:read', id),
  autosaveDiscard: (id) => invoke('autosave:discard', id),
  // Symbols panel library folders (ids only; files by a path relative to the folder; DWG comes back as DXF)
  symbolsAddFolder: () => invoke('symbols:addFolder'),
  symbolsFolders: () => invoke('symbols:folders'),
  symbolsRemoveFolder: (id) => invoke('symbols:removeFolder', id),
  symbolsList: (id) => invoke('symbols:list', id),
  symbolsRead: (id, rel) => invoke('symbols:read', id, rel),
  symbolsThumbGet: (id, rel) => invoke('symbols:thumbGet', id, rel),
  symbolsThumbPut: (id, rel, png) => invoke('symbols:thumbPut', id, rel, png),
  dwgAvailable: () => invoke('dwg:available'),
  dwgConfig: () => invoke('dwg:config'),
  dwgSetConfig: (c) => invoke('dwg:setConfig', c),
  dwgBrowseOda: () => invoke('dwg:browseOda'),
  openOdaDownload: () => invoke('shell:openOdaDownload'),
  // A file dropped on the window: its path comes from Electron (webUtils) for a real dropped File only, so the
  // renderer cannot name an arbitrary path; main grants it like a file chosen in the Open dialog. null if none.
  openDropped: (file) => { let p = ''; try { p = webUtils.getPathForFile(file); } catch { /* not a file on disk */ } return p ? invoke('file:dropped', p) : Promise.resolve(null); },
  openExternal: (url) => invoke('shell:openHelpLink', String(url)),
  dwgToDxf: (bytes) => invoke('dwg:toDxf', bytes),
  dwgOpen: (pathOrBytes, job) => invoke('dwg:open', pathOrBytes, job),
  dwgCancel: (job) => invoke('dwg:cancel', job),
  dwgRelease: (url) => invoke('dwg:release', url),
  dwgCacheInfo: () => invoke('dwg:cacheInfo'),
  dwgCacheClear: () => invoke('dwg:cacheClear'),
  dxfToDwg: (dxfBytes, version) => invoke('dwg:fromDxf', { dxfBytes, version }),
});
