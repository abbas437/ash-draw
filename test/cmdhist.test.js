import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandHistory, HISTORY_LIMIT } from '../src/core/cmdhist.js';

test('CommandHistory: inputs carry the prompt they answered; idle is "Command"', () => {
  const h = new CommandHistory();
  assert.equal(h.input('', ' L '), 'Command: L');
  assert.equal(h.input('LINE  first point', '10,20'), 'LINE  first point: 10,20');
  assert.equal(h.input('LINE  next point', ''), 'LINE  next point:');
  assert.deepEqual(h.lines, ['Command: L', 'LINE  first point: 10,20', 'LINE  next point:']);
});

test('CommandHistory: messages split into lines, trailing blank lines dropped', () => {
  const h = new CommandHistory();
  assert.deepEqual(h.message('LINE  Layer: 0\r\n  from 0,0\n\n'), ['LINE  Layer: 0', '  from 0,0']);
  h.message('Unknown command "xyz".');
  assert.deepEqual(h.last(2), ['  from 0,0', 'Unknown command "xyz".']);
  assert.deepEqual(h.last(0), []);
  assert.equal(h.toText(), 'LINE  Layer: 0\n  from 0,0\nUnknown command "xyz".\n');
  assert.equal(new CommandHistory().toText(), '');
});

test('CommandHistory: keeps the last 500 lines (oldest dropped first)', () => {
  assert.equal(HISTORY_LIMIT, 500);
  const h = new CommandHistory();
  for (let i = 0; i < 520; i++) h.input('', `C${i}`);
  h.message('a\nb');
  assert.equal(h.lines.length, 500);
  assert.equal(h.total, 522, 'lines ever added');
  assert.equal(h.lines[0], 'Command: C22');
  assert.deepEqual(h.last(3), ['Command: C519', 'a', 'b']);
  assert.equal(h.inputs.length, 500);
});

test('CommandHistory: Up/Down recall walks earlier inputs, skipping empty and repeated ones', () => {
  const h = new CommandHistory();
  assert.equal(h.older(), null, 'nothing to recall yet');
  assert.equal(h.newer(), null);
  h.input('', 'L'); h.input('LINE  first point', '0,0'); h.input('LINE  next point', ''); h.input('', 'ID'); h.input('', 'ID');
  h.message('X = 3  Y = 4');
  assert.equal(h.older(), 'ID');
  assert.equal(h.recalled, 'ID');
  assert.equal(h.older(), '0,0');
  assert.equal(h.older(), 'L');
  assert.equal(h.older(), 'L', 'stays at the oldest');
  assert.equal(h.newer(), '0,0');
  assert.equal(h.newer(), 'ID');
  assert.equal(h.newer(), '', 'past the newest: empty line');
  assert.equal(h.newer(), null);
  h.older(); h.resetRecall();
  assert.equal(h.recalled, '');
  assert.equal(h.older(), 'ID', 'starts again from the newest');
  h.input('', 'LIST');
  assert.equal(h.older(), 'LIST', 'a new input resets the recall');
});
