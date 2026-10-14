// ASH Draw Studio - system clipboard for drawing fragments (COPYCLIP / PASTECLIP between windows and applications).
// The renderer never names a clipboard format: it hands over DXF text and gets DXF text back; this module decides
// which formats are touched. Pure apart from the injected Electron `clipboard` (so it is unit-tested with a fake).
//
// Electron's clipboard writes each replace the whole clipboard (a custom format cannot be combined with text in one
// write), so the fragment is written as plain text - which also lets another ASH window, a text editor or a CAD
// program take it. Only plain text is read back.
export const MAX_DXF_CHARS = 64 * 1024 * 1024;
const looksDxf = (t) => /^﻿?\s*(0\s*\r?\n\s*SECTION|999\s*\r?\n)/.test(t);

export function createClipboardBridge(clipboard) {
  return {
    /** put DXF text on the clipboard; false when `dxf` is not DXF text of an acceptable size */
    write(dxf) {
      if (typeof dxf !== 'string' || dxf.length > MAX_DXF_CHARS || !looksDxf(dxf)) return false;
      clipboard.write({ text: dxf });
      return true;
    },
    /** DXF text on the clipboard (plain text that starts like a DXF, within the size cap), else null */
    read() {
      const t = clipboard.readText();
      return typeof t === 'string' && t.length <= MAX_DXF_CHARS && looksDxf(t) ? t : null;
    },
  };
}
