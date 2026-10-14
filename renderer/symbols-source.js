// ASH Draw Studio - where the Symbols panel's symbols come from: the built-in set and the library folders the user
// added (window.api.symbols*: the desktop app's stored folders, or the browser's in-memory ones). No DOM.
//
//   const src = createSymbolSource();                 // window.api by default
//   const sources = await src.listSources();          // [{ id: 'builtin', kind: 'builtin', name }, { id, kind: 'folder', name, path }]
//   const items = await src.listSymbols(sources[1]);  // [{ key, name, category, rel, file, format, size, mtimeMs }]
//   const syms = await src.loadSymbol(sources[1], items[0]);   // symbols of the file (a block library gives several)
//   const png = await src.thumbnail(sources[1], items[0]);     // Blob (image/png) or null
//
// Thumbnails are drawn in black on transparent and cached that way (main's symbol-cache for folders), so one cached
// image serves every theme: a dark panel inverts them in CSS.
import { builtinSymbols } from '../src/core/symbols-builtin.js';
import { symbolsFromDxf, cleanSymbolName, drawSymbolThumb } from '../src/core/symbols-lib.js';

export const BUILTIN_SOURCE = Object.freeze({ id: 'builtin', kind: 'builtin', name: 'Built-in' });
export const THUMB_SIZE = 64;

const offscreen = (w, h) => new OffscreenCanvas(w, h);
const pngOf = async (canvas) => new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());

/** `api`: window.api (or a fake); `canvas(w, h)` and `encode(canvas) -> PNG bytes` default to OffscreenCanvas */
export function createSymbolSource(api = globalThis.window?.api, { canvas = offscreen, encode = pngOf, size = THUMB_SIZE } = {}) {
  const loaded = new Map(); // source id|rel|mtime|size -> Promise<symbols>
  const thumbs = new Map(); // same key -> Promise<Blob|null>
  const isBuiltin = (source) => source?.kind === 'builtin';
  const keyOf = (source, item) => (isBuiltin(source) ? `builtin|${item.key}` : `${source.id}|${item.rel}|${item.mtimeMs}|${item.size}`);
  const folderSource = (f) => ({ id: f.id, kind: 'folder', name: f.name, path: f.path ?? null });
  const memo = (map, key, make) => {
    if (!map.has(key)) map.set(key, make().catch((err) => { map.delete(key); throw err; }));
    return map.get(key);
  };

  async function load(source, item) {
    if (isBuiltin(source)) {
      const s = builtinSymbols().find((x) => x.id === item.key);
      if (!s) throw new Error(`no built-in symbol ${item.key}`);
      return [s];
    }
    const f = await api.symbolsRead(source.id, item.rel);
    return symbolsFromDxf(f.bytes, item.file).map((s) => ({ ...s, category: item.category }));
  }

  async function render(syms) {
    const c = canvas(size, size);
    if (!syms.length || !drawSymbolThumb(c.getContext('2d'), syms[0], size, size, '#000')) return null;
    return encode(c);
  }

  const loadSymbol = (source, item) => memo(loaded, keyOf(source, item), () => load(source, item));

  return {
    /** the built-in set first, then the stored folders */
    async listSources() {
      const folders = (await api.symbolsFolders?.()) ?? [];
      return [BUILTIN_SOURCE, ...folders.map(folderSource)];
    },
    /** choose a folder (dialog); its source, or null when cancelled */
    async addFolder() {
      const f = await api.symbolsAddFolder();
      return f ? folderSource(f) : null;
    },
    async removeFolder(source) { return api.symbolsRemoveFolder(source.id); },
    /** the items of a source: built-in symbols, or a folder's files (category = subfolder, name from the file name);
     *  a folder's array has `truncated` (non-enumerable) set when the listing hit its cap */
    async listSymbols(source) {
      if (isBuiltin(source)) return builtinSymbols().map((s) => ({ key: s.id, name: s.name, category: s.category }));
      const { files, truncated } = await api.symbolsList(source.id);
      const items = files.map((f) => ({
        key: f.rel, rel: f.rel, file: f.name, name: cleanSymbolName(f.name), category: f.category,
        format: /\.dwg$/i.test(f.name) ? 'dwg' : 'dxf', size: f.size, mtimeMs: f.mtimeMs,
      }));
      return Object.defineProperty(items, 'truncated', { value: !!truncated }); // the folder had more files than listed
    },
    /** the symbols of an item (usually one; a block library file gives one per top-level block); cached in memory.
     *  Rejects for an unreadable file (Error.code 'BAD_SYMBOL'), or a DWG in the browser ('DWG_DESKTOP_ONLY'). */
    loadSymbol,
    /** a PNG Blob of the item's first symbol, or null when it cannot be drawn; folder thumbnails go through the cache */
    thumbnail(source, item) {
      return memo(thumbs, keyOf(source, item), async () => {
        if (!isBuiltin(source)) {
          const hit = await api.symbolsThumbGet(source.id, item.rel).catch(() => null);
          if (hit) return new Blob([hit], { type: 'image/png' });
        }
        let png; try { png = await render(await loadSymbol(source, item)); } catch { return null; }
        if (!png) return null;
        if (!isBuiltin(source)) api.symbolsThumbPut(source.id, item.rel, png).catch(() => {});
        return new Blob([png], { type: 'image/png' });
      });
    },
  };
}
