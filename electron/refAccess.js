// Which files an open drawing's references (xrefs, raster images) may make main read (reviewer #22).
// A candidate in the host drawing's folder or a subfolder of it, or a path the user opened or chose this session
// (granted), is read without asking. Any other path - another folder, another drive, a mapped drive, a UNC share
// (\\server\share, //server/share) - is not touched at all (no stat: on Windows a stat of a UNC path already contacts
// the server) until the user has agreed for that host drawing: main reports such candidates as `refused`, the window
// asks once, and refs:decide hands the answer back here. Only paths main itself reported for that host can be
// approved; a "Don't load" holds for the host for the rest of the session.
import { xrefCandidates } from '../src/core/xref.js';

/** `pathLib`: node's path module (path.win32 / path.posix in tests); `isFile(p)`: async, the only fs access made here;
 *  `isGranted(p)`: a path the user opened or chose this session. */
export function createRefAccess({ pathLib, isFile, isGranted = () => false }) {
  const win = pathLib.sep === '\\';
  const key = (p) => (win ? pathLib.resolve(p).toLowerCase() : pathLib.resolve(p));
  const hosts = new Map(); // key(host) -> { offered: Set<key>, approved: Set<key>, declined }
  const stateOf = (host) => {
    let s = hosts.get(key(host));
    if (!s) hosts.set(key(host), (s = { offered: new Set(), approved: new Set(), declined: false }));
    return s;
  };
  /** in the folder of `host` or below it (compared case-insensitively on Windows) */
  const inside = (host, p) => {
    const rel = pathLib.relative(key(pathLib.dirname(host)), key(p));
    return rel !== '' && !rel.startsWith('..') && !pathLib.isAbsolute(rel);
  };

  return {
    inside,
    /** The first readable candidate of `refPath` whose extension `accept`s: { path } | { refused: [paths], declined }
     *  (no allowed candidate exists, but outside ones were not looked at) | null (not found). */
    async find(host, refPath, accept) {
      const s = stateOf(host);
      const refused = [];
      for (const p of xrefCandidates(host, refPath, pathLib)) {
        if (!accept(pathLib.extname(p).toLowerCase())) continue;
        const k = key(p);
        if (!inside(host, p) && !isGranted(p) && !s.approved.has(k)) { refused.push(p); continue; }
        if (await isFile(p)) return { path: p };
      }
      if (!refused.length) return null;
      if (!s.declined) for (const p of refused) s.offered.add(key(p));
      return { refused, declined: s.declined };
    },
    /** the user's answer for `host`: load (only `paths` that find() reported for this host) or don't load */
    decide(host, load, paths) {
      const s = stateOf(host);
      if (!load) { s.declined = true; return true; }
      if (s.declined || !Array.isArray(paths)) return false;
      for (const p of paths) if (typeof p === 'string' && s.offered.has(key(p))) s.approved.add(key(p));
      return true;
    },
  };
}
