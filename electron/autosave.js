// Autosave store (reviewer #29): timed copies of drawings with unsaved changes, kept in <userData>/autosave as
// <id>.dxf + <id>.json, so a crash does not lose the edits; offered for recovery at the next start. The renderer names
// an entry only by its id (/^[a-z0-9-]{1,64}$/), never by a path. No Electron imports: testable in plain Node.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './backup.js';

const ID = /^[a-z0-9-]{1,64}$/;
const str = (v, max) => (typeof v === 'string' && v.length <= max && !v.includes('\0') ? v : null);

/** the id, or a TypeError for anything that is not 1-64 of [a-z0-9-] (no path can be named) */
export function checkId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new TypeError('invalid autosave id');
  return id;
}

/** `dir()`: the autosave folder (a function, so main can resolve userData late); `now`, `appVersion` injectable */
export function createAutosaveStore({ dir, appVersion = '', now = () => Date.now() }) {
  const files = (id) => ({ dxf: path.join(dir(), `${checkId(id)}.dxf`), json: path.join(dir(), `${id}.json`) });
  return {
    /** write the drawing, then its description (the .json marks a complete entry); both atomically */
    async write(id, bytes, meta = {}) {
      const f = files(id);
      if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
      const m = meta && typeof meta === 'object' ? meta : {};
      const info = {
        originalPath: str(m.originalPath, 1024), name: str(m.name, 260) ?? 'Drawing.dxf',
        format: m.format === 'dwg' ? 'dwg' : 'dxf', savedAt: new Date(now()).toISOString(), appVersion,
      };
      await fs.mkdir(dir(), { recursive: true });
      await atomicWrite(f.dxf, bytes);
      await atomicWrite(f.json, JSON.stringify(info, null, 2));
      return { id, ...info };
    },
    /** complete entries (a .json with its .dxf), newest first */
    async list() {
      let names;
      try { names = await fs.readdir(dir()); } catch { return []; }
      const out = [];
      for (const n of names) {
        const id = n.endsWith('.json') ? n.slice(0, -5) : null;
        if (!id || !ID.test(id)) continue;
        const f = files(id);
        try {
          const info = JSON.parse(await fs.readFile(f.json, 'utf8'));
          const st = await fs.stat(f.dxf);
          if (st.isFile()) out.push({ id, originalPath: str(info.originalPath, 1024), name: str(info.name, 260) ?? `${id}.dxf`, format: info.format === 'dwg' ? 'dwg' : 'dxf', savedAt: str(info.savedAt, 64), appVersion: str(info.appVersion, 64) ?? '', size: st.size });
        } catch { /* incomplete or unreadable entry: not offered */ }
      }
      return out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    },
    /** the entry's DXF bytes */
    async read(id) { return new Uint8Array(await fs.readFile(files(id).dxf)); },
    /** remove the entry (no error when it does not exist) */
    async discard(id) {
      const f = files(id);
      await fs.rm(f.json, { force: true });
      await fs.rm(f.dxf, { force: true });
      return true;
    },
  };
}
