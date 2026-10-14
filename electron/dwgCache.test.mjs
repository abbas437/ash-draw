// Unit tests for the converted-drawing cache. Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheKey, cacheLimitBytes, createDwgCache, DEFAULT_CACHE_MB, openCached } from './dwgCache.js';

const dxf = (n) => { const b = new Uint8Array(n).fill(65); b.set(Buffer.from('  0\nEOF\n'), n - 8); return b; };

async function withCache(fn, limit = 1 << 20) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-dwgcache-'));
  const dir = path.join(root, 'dwg-cache');
  let t = Date.parse('2026-10-15T10:00:00Z');
  const cache = createDwgCache({ dir: () => dir, limitBytes: () => limit, now: () => (t += 1000) });
  try { await fn({ cache, dir, root }); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

/** a DWG file on disk and a mocked converter that counts its calls */
async function dwgFile(root, name = 'plan.dwg', content = 'AC1032 drawing') {
  const p = path.join(root, name);
  await fs.writeFile(p, content);
  const calls = [];
  const convert = async (bytes) => { calls.push(bytes.byteLength); return { dxfBytes: dxf(100), engine: 'libredwg', converter: 'LibreDWG', errorCount: 3, log: 'ERROR x' }; };
  const read = async (q) => new Uint8Array(await fs.readFile(q));
  return { p, calls, convert, read };
}

test('a second open of an unchanged DWG is served from the cache: the converter is not run', async () => withCache(async ({ cache, root }) => {
  const { p, calls, convert, read } = await dwgFile(root);
  const a = await openCached(cache, p, { converter: 'LibreDWG 0.13', read, convert });
  assert.equal(a.cached, false);
  assert.equal(await a.stored, true);
  const b = await openCached(cache, p, { converter: 'LibreDWG 0.13', read: () => assert.fail('a hit must not read the DWG'), convert });
  assert.equal(calls.length, 1, 'converted once');
  assert.equal(b.cached, true);
  assert.deepEqual(b.dxfBytes, a.dxfBytes);
  const fields = ({ dxfBytes, cached, stored, ...rest }) => rest;
  assert.deepEqual(fields(b), fields(a), 'same result fields');
  assert.equal(b.header, 'AC1032');
  assert.equal(b.dwgSize, 14);
  assert.equal(b.errorCount, 3);
}));

test('a changed modification time, size or converter misses', async () => withCache(async ({ cache, root }) => {
  const { p, calls, convert, read } = await dwgFile(root);
  await (await openCached(cache, p, { converter: 'L1', read, convert })).stored;
  const later = new Date(Date.now() + 60_000);
  await fs.utimes(p, later, later);
  const r = await openCached(cache, p, { converter: 'L1', read, convert });
  assert.equal(r.cached, false);
  assert.equal(calls.length, 2, 'mtime changed: converted again');
  await r.stored;
  await (await openCached(cache, p, { converter: 'L2', read, convert })).stored;
  assert.equal(calls.length, 3, 'another converter: converted again');
  assert.notEqual(cacheKey({ path: p, size: 1, mtimeMs: 5, converter: 'L1' }), cacheKey({ path: p, size: 2, mtimeMs: 5, converter: 'L1' }));
}));

test('the least recently used entries are evicted over the limit; an entry over the limit is not stored', async () => withCache(async ({ cache, dir }) => {
  const k = (c) => c.repeat(64);
  assert.equal(await cache.put(k('a'), dxf(400), {}), true);
  assert.equal(await cache.put(k('b'), dxf(400), {}), true);
  assert.ok(await cache.get(k('a')), 'a used again: b is now the least recently used');
  assert.equal(await cache.put(k('c'), dxf(400), {}), true); // 3 x (400 + json) > 1000
  assert.equal(await cache.get(k('b')), null, 'b evicted');
  assert.ok(await cache.get(k('a')));
  assert.ok(await cache.get(k('c')));
  assert.equal(await cache.put(k('d'), dxf(2000), {}), false, 'larger than the whole cache');
  assert.equal(await cache.get(k('d')), null);
  const info = await cache.info();
  assert.equal(info.entries, 2);
  assert.ok(info.bytes <= 1000);
  assert.equal(await cache.clear(), 2);
  assert.deepEqual(await fs.readdir(dir), []);
}, 1000));

test('a damaged entry is ignored and deleted, and the DWG converted again', async () => withCache(async ({ cache, dir, root }) => {
  const { p, calls, convert, read } = await dwgFile(root);
  await (await openCached(cache, p, { converter: 'L', read, convert })).stored;
  const [dxfName] = (await fs.readdir(dir)).filter((n) => n.endsWith('.dxf'));
  await fs.writeFile(path.join(dir, dxfName), 'truncated'); // a drawing cut short (no EOF, wrong size)
  const r = await openCached(cache, p, { converter: 'L', read, convert });
  assert.equal(r.cached, false);
  assert.equal(calls.length, 2);
  await r.stored;
  assert.equal((await openCached(cache, p, { converter: 'L', read, convert })).cached, true, 'stored again');
  const [jsonName] = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
  await fs.writeFile(path.join(dir, jsonName), '{not json');
  assert.equal(await cache.get(jsonName.slice(0, 64)), null, 'unreadable description');
  assert.deepEqual(await fs.readdir(dir), [], 'both files of the damaged entry deleted');
}));

test('the limit setting; keys are hashes only', async () => {
  assert.equal(cacheLimitBytes(undefined), DEFAULT_CACHE_MB * 1048576);
  assert.equal(cacheLimitBytes(0), 0);
  assert.equal(cacheLimitBytes(512), 512 * 1048576);
  assert.equal(cacheLimitBytes(-1), DEFAULT_CACHE_MB * 1048576);
  assert.equal(cacheLimitBytes('5'), DEFAULT_CACHE_MB * 1048576);
  await assert.rejects(createDwgCache({ dir: () => '/x' }).get('../evil'), TypeError);
});

test('limit 0 (cache off): nothing is stored and an existing entry is not served', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-dwgcache-'));
  try {
    let limit = 1 << 20;
    const cache = createDwgCache({ dir: () => path.join(root, 'c'), limitBytes: () => limit });
    const { p, calls, convert, read } = await dwgFile(root);
    await (await openCached(cache, p, { converter: 'L1', read, convert })).stored;
    limit = 0;
    const r = await openCached(cache, p, { converter: 'L1', read, convert });
    assert.equal(r.cached, false, 'the entry on disk is not served while the cache is off');
    assert.equal(calls.length, 2);
    assert.equal(await r.stored, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a .dxf without its .json and an old .tmp are deleted; other files and fresh .tmp stay', async () => withCache(async ({ cache, dir }) => {
  await fs.mkdir(dir, { recursive: true });
  const k = (c) => c.repeat(64);
  const orphan = path.join(dir, `${k('a')}.dxf`);
  const oldTmp = path.join(dir, `.${k('b')}.json.123-abcd1234.tmp`);
  const freshTmp = path.join(dir, `.${k('c')}.dxf.123-abcd1234.tmp`);
  const foreign = path.join(dir, 'notes.dxf');
  for (const f of [orphan, oldTmp, freshTmp, foreign]) await fs.writeFile(f, 'x');
  const old = new Date(Date.now() - 2 * 3600_000);
  await fs.utimes(oldTmp, old, old);
  assert.deepEqual(await cache.info(), { entries: 0, bytes: 0 });
  const left = (await fs.readdir(dir)).sort();
  assert.deepEqual(left, [path.basename(freshTmp), 'notes.dxf'].sort());
}));

test('a DWG that changes while it is read is converted but not cached', async () => withCache(async ({ cache, root }) => {
  const { p, convert } = await dwgFile(root);
  const read = async (q) => { const b = new Uint8Array(await fs.readFile(q)); const t = new Date(Date.now() + 90_000); await fs.utimes(q, t, t); return b; };
  const r = await openCached(cache, p, { converter: 'L1', read, convert });
  assert.equal(r.cached, false);
  assert.equal(await r.stored, false);
  assert.equal((await cache.info()).entries, 0);
}));

test('inode and change time are part of the key', () => {
  const base = { path: '/a.dwg', size: 1, mtimeMs: 5, converter: 'L1' };
  assert.notEqual(cacheKey({ ...base, ino: 1, ctimeMs: 7 }), cacheKey({ ...base, ino: 2, ctimeMs: 7 }));
  assert.notEqual(cacheKey({ ...base, ino: 1, ctimeMs: 7 }), cacheKey({ ...base, ino: 1, ctimeMs: 8 }));
});
