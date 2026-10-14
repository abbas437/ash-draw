import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClipboardBridge, MAX_DXF_CHARS } from './clipboard.js';

const DXF = '0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n';
function fake() {
  const calls = [];
  const store = { text: '', buffers: new Map() };
  return {
    calls, store,
    write(o) { calls.push(['write', Object.keys(o)]); store.text = o.text ?? ''; store.buffers.clear(); },
    writeBuffer(f, b) { calls.push(['writeBuffer', f]); store.buffers.set(f, b); },
    readBuffer(f) { calls.push(['readBuffer', f]); return store.buffers.get(f) ?? Buffer.alloc(0); },
    readText() { calls.push(['readText']); return store.text; },
  };
}

test('write: DXF text only, as plain text; anything else refused', () => {
  const cb = fake(), b = createClipboardBridge(cb);
  assert.equal(b.write(DXF), true);
  assert.deepEqual(cb.calls, [['write', ['text']]]);
  assert.equal(b.write('rm -rf /'), false);
  assert.equal(b.write({ format: 'text/html', data: 'x' }), false);
  assert.equal(b.write(42), false);
  assert.equal(cb.calls.length, 1);
});

test('read: only plain text is read; non-DXF text gives null', () => {
  const cb = fake(), b = createClipboardBridge(cb);
  cb.store.text = 'hello';
  assert.equal(b.read(), null);
  cb.store.text = DXF;
  assert.equal(b.read(), DXF);
  assert.ok(cb.calls.every((c) => c[0] === 'readText'), 'no custom format is read');
});

test('size cap: a fragment over MAX_DXF_CHARS is neither written nor read', () => {
  const cb = fake(), b = createClipboardBridge(cb);
  const big = DXF + ' '.repeat(MAX_DXF_CHARS - DXF.length + 1);
  assert.equal(big.length, MAX_DXF_CHARS + 1);
  assert.equal(b.write(big), false);
  assert.deepEqual(cb.calls, []);
  const ok = DXF + ' '.repeat(MAX_DXF_CHARS - DXF.length);
  assert.equal(b.write(ok), true, 'exactly the cap is accepted');
  cb.store.text = big;
  assert.equal(b.read(), null);
  cb.store.text = ok;
  assert.equal(b.read(), ok);
});
