import test from 'node:test';
import assert from 'node:assert/strict';
import { withExportProgress } from '../renderer/files.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeUi = () => {
  const log = { shown: 0, closed: 0, fractions: [], cancel: null };
  return { log, show: (onCancel) => { log.shown++; log.cancel = onCancel; return { set: (f) => log.fractions.push(f), close: () => { log.closed++; } }; } };
};
// an export that ends after `ms`, or rejects CANCELLED when its signal aborts
const fakeExport = (ms) => async ({ onProgress, signal }) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
    onProgress(1 - (end - Date.now()) / ms);
    await sleep(5);
  }
  return 'bytes';
};

test('withExportProgress: a fast export shows no dialog', async () => {
  const ui = fakeUi();
  const r = await withExportProgress(fakeExport(20), { delayMs: 200, show: ui.show });
  assert.deepEqual(r, { cancelled: false, value: 'bytes' });
  assert.equal(ui.log.shown, 0);
});

test('withExportProgress: a slow export shows it after the delay and closes it at the end', async () => {
  const ui = fakeUi();
  const r = await withExportProgress(fakeExport(150), { delayMs: 30, show: ui.show });
  assert.equal(r.value, 'bytes');
  assert.equal(ui.log.shown, 1);
  assert.equal(ui.log.closed, 1);
  assert.ok(ui.log.fractions.length > 1);
});

test('withExportProgress: Cancel aborts the signal and resolves as cancelled', async () => {
  const ui = fakeUi();
  const p = withExportProgress(fakeExport(400), { delayMs: 20, show: ui.show });
  await sleep(60);
  ui.log.cancel();
  const r = await p;
  assert.deepEqual(r, { cancelled: true });
  assert.equal(ui.log.closed, 1);
});

test('withExportProgress: other errors are rethrown and the dialog is closed', async () => {
  const ui = fakeUi();
  await assert.rejects(withExportProgress(async () => { await sleep(60); throw new Error('boom'); }, { delayMs: 10, show: ui.show }), /boom/);
  assert.equal(ui.log.closed, 1);
});
