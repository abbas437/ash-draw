// tokenizeDxf's byte-level number reader (tk.num) must give exactly what parseFloat gives on the value's text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeDxf } from '../src/core/dxfRead.js';

const VALUES = ['0', '-0', '-0.0', '+1', '1.5', ' 1.5 ', '.5', '5.', '-.25', '12345.678901234', '1234567890.123456',
  '9007199254740993', '12345678901234567', '0.1', '0.3', '1.0000000000000002', '0.0000000000000000000001', '0.00000000000000000000001',
  '1e3', '1.5E-7', '-2.5e+10', 'abc', '', '.', '-', '12abc', '3.14159265358979', '1E400', '0x10', '00012.50', '\t7\t'];

test('tk.num equals parseFloat of the value text', () => {
  const text = VALUES.map((v) => `40\n${v}\n`).join('') + '  0\nEOF\n';
  const tk = tokenizeDxf(new TextEncoder().encode(text));
  assert.equal(typeof tk.num, 'function');
  VALUES.forEach((v, i) => assert.ok(Object.is(tk.num(i), parseFloat(v)), `${JSON.stringify(v)}: ${tk.num(i)} vs ${parseFloat(v)}`));
  for (let k = 0; k < 2000; k++) { // random decimals of 1..17 digits
    const d = String(Math.floor(Math.random() * 1e17)).slice(0, 1 + (k % 17));
    const at = k % (d.length + 1);
    const s = `${k & 1 ? '-' : ''}${d.slice(0, at)}.${d.slice(at)}`;
    const t = tokenizeDxf(new TextEncoder().encode(`10\n${s}\n  0\nEOF\n`));
    assert.ok(Object.is(t.num(0), parseFloat(s)), s);
  }
});
