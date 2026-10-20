// The app:// protocol handler: serves renderer/ and src/ only, plus the one-time hand-off URLs (handoff.js).
// Kept out of main.js (which imports electron) so that it can be unit-tested.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2',
};
const notFound = () => new Response('Not found', { status: 404 });

/** `root`: the app folder; `servedDirs`: absolute folders (with a trailing separator) that may be served;
 *  `openPrefix` + `take(token)`: the one-time hand-offs; `readFile`: fs.promises.readFile (tests pass their own). */
export function createAppFileServer({ host, root, servedDirs, openPrefix, take, readFile = fs.readFile }) {
  return async function serveAppFile(request) {
    const url = new URL(request.url);
    if (url.host !== host) return notFound();
    if (url.pathname.startsWith(openPrefix)) {
      const bytes = request.method === 'GET' ? take(url.pathname.slice(openPrefix.length)) : null;
      if (!bytes) return notFound();
      return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
    }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return notFound(); } // a malformed escape such as %E0%A4%A
    const file = path.resolve(root, '.' + rel);
    if (!servedDirs.some((d) => file.startsWith(d))) return notFound();
    try {
      return new Response(await readFile(file), {
        headers: { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' },
      });
    } catch {
      return notFound();
    }
  };
}
