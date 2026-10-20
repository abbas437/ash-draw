import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createAppFileServer } from './appFiles.js';

const root = path.resolve('/app');
const reads = [];
const serve = createAppFileServer({
  host: 'drawstudio', root, servedDirs: ['renderer', 'src'].map((d) => path.join(root, d) + path.sep), openPrefix: '/_open/',
  take: (t) => (t === 'tok' ? new Uint8Array([1, 2]) : null),
  readFile: async (f) => { reads.push(f); if (f.endsWith('missing.js')) throw new Error('ENOENT'); return Buffer.from('x'); },
});
const get = (u) => serve(new Request(u));

// reviewer #23: decodeURIComponent throws URIError on a malformed escape; that must be a 404, not a rejected handler
test('a request path with a malformed escape is a 404', async () => {
  for (const p of ['/%E0%A4%A', '/renderer/%', '/src/%zz.js']) {
    const r = await get(`app://drawstudio${p}`);
    assert.equal(r.status, 404, p);
  }
  assert.deepEqual(reads, []);
});

test('files under renderer/ and src/ are served with their type; others are 404', async () => {
  const ok = await get('app://drawstudio/renderer/a%20b.js');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(reads.at(-1), path.join(root, 'renderer', 'a b.js'));
  for (const u of ['app://drawstudio/electron/main.js', 'app://drawstudio/renderer/%2e%2e/electron/main.js', 'app://other/renderer/x.js', 'app://drawstudio/renderer/missing.js']) {
    assert.equal((await get(u)).status, 404, u);
  }
});

test('a hand-off token is served on GET only', async () => {
  const r = await get('app://drawstudio/_open/tok');
  assert.equal(r.status, 200);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), new Uint8Array([1, 2]));
  assert.equal((await get('app://drawstudio/_open/nope')).status, 404);
});
