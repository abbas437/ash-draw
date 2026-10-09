// ASH Draw Studio - reads a DXF off the main thread (module worker). In: {bytes: Uint8Array} (buffer transferred).
// or {url} of a converted DWG's DXF to fetch (electron/main.js handOff). Out: {progress: 0..100} while reading, then the document in batches (src/core/docBatches.js), or {error: {message, code}}.
import { readDxf } from '../src/core/dxfRead.js';
import { postDocInBatches } from '../src/core/docBatches.js';

self.onmessage = async ({ data }) => {
  let last = -1;
  if (data.url) {
    try {
      const r = await fetch(data.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = { bytes: new Uint8Array(await r.arrayBuffer()) };
    } catch (err) { self.postMessage({ error: { message: `The converted drawing could not be read (${err.message}).`, code: null } }); return; }
  }
  const onProgress = (f) => { const p = Math.floor(f * 100); if (p !== last) { last = p; self.postMessage({ progress: p }); } };
  let doc;
  try { doc = readDxf(data.bytes, { onProgress }); } catch (err) {
    self.postMessage({ error: { message: String(err?.message ?? err), code: err?.code ?? null } });
    return;
  }
  try { postDocInBatches(doc, (m) => self.postMessage(m)); } catch (err) { self.postMessage({ error: { message: `The drawing could not be handed to the window (${err.message}).`, code: null } }); }
};
