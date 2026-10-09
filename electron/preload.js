// Sandboxed preload (runs as a classic CommonJS-style script; ESM is not supported
// in sandboxed preloads). Exposes the minimal window.api contract documented in README.md.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  isElectron: true,
  version: () => invoke('app:version'),
  openFiles: (opts) => invoke('dialog:open', opts),
  readFile: (p) => invoke('file:read', p),
  xrefRead: (hostPath, refPath) => invoke('xref:read', hostPath, refPath),
  imageRead: (hostPath, refPath) => invoke('image:read', hostPath, refPath),
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
  settingsSet: (k, v) => invoke('app:settingsSet', k, v),
  // last session and recent files (main owns both lists)
  sessionUpdate: (s) => invoke('app:sessionUpdate', s),
  sessionInfo: () => invoke('app:sessionInfo'),
  sessionRestore: () => invoke('app:sessionRestore'),
  sessionDismiss: () => invoke('app:sessionDismiss'),
  recentList: () => invoke('app:recentList'),
  recentOpen: (p) => invoke('app:recentOpen', p),
  recentClear: () => invoke('app:recentClear'),
  dwgAvailable: () => invoke('dwg:available'),
  dwgConfig: () => invoke('dwg:config'),
  dwgSetConfig: (c) => invoke('dwg:setConfig', c),
  dwgBrowseOda: () => invoke('dwg:browseOda'),
  openOdaDownload: () => invoke('shell:openOdaDownload'),
  dwgToDxf: (bytes) => invoke('dwg:toDxf', bytes),
  dwgOpen: (pathOrBytes) => invoke('dwg:open', pathOrBytes),
  dxfToDwg: (dxfBytes, version) => invoke('dwg:fromDxf', { dxfBytes, version }),
});
