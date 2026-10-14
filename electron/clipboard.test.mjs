import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClipboardBridge, CLIP_FORMAT } from './clipboard.js';

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

test('read: only the fixed custom format and plain text are read; non-DXF text gives null', () => {
  const cb = fake(), b = createClipboardBridge(cb);
  cb.store.text = 'hello';
  assert.equal(b.read(), null);
  cb.store.text = DXF;
  assert.equal(b.read(), DXF);
  cb.store.buffers.set(CLIP_FORMAT, Buffer.from(DXF.replace('ENTITIES', 'BLOCKS')));
  assert.match(b.read(), /BLOCKS/);
  const formats = new Set(cb.calls.filter((c) => c[0] === 'readBuffer').map((c) => c[1]));
  assert.deepEqual([...formats], [CLIP_FORMAT]);
});
