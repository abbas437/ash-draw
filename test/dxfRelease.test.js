// After a read, the reader keeps nothing of the DXF: its bytes (and the token arrays) can be collected. A big
// drawing's DXF is hundreds of MB, held otherwise by the reader's per-parse state until the next read.
import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { readDxf } from '../src/core/dxfRead.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

const DXF = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '5', '1F', '8', '0', '10', '0', '20', '0', '11', '10', '21', '5',
  '0', 'INSERT', '5', '20', '8', '0', '2', 'B', '10', '0', '20', '0', '102', '{ACAD_XDICTIONARY', '360', '30', '102', '}',
  '0', 'ENDSEC', '0', 'SECTION', '2', 'OBJECTS', '0', 'DICTIONARY', '5', '30', '3', 'ACAD_FILTER', '360', '31',
  '0', 'DICTIONARY', '5', '31', '3', 'SPATIAL', '360', '32', '0', 'SPATIAL_FILTER', '5', '32', '0', 'ENDSEC', '0', 'EOF', ''].join('\n');

test('readDxf does not keep the DXF bytes alive', async () => {
  let freed = false;
  const reg = new FinalizationRegistry(() => { freed = true; });
  let doc;
  (() => {
    const bytes = new TextEncoder().encode(DXF);
    reg.register(bytes.buffer, 'dxf');
    doc = readDxf(bytes);
  })();
  for (let i = 0; i < 10 && !freed; i++) { gc(); await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(doc.entities.length, 2);
  assert.ok(freed, 'the DXF bytes are still referenced after the read');
});
