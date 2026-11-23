import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTime, sanitizeBlocks, parseScheduleText, formatTime, formatDuration, changedKeys } from '../public/schedule.js';

test('normalizeTime handles common spoken/written formats', () => {
  assert.equal(normalizeTime('9:00'), '09:00');
  assert.equal(normalizeTime('09:30'), '09:30');
  assert.equal(normalizeTime('9pm'), '21:00');
  assert.equal(normalizeTime('12:15 AM'), '00:15');
  assert.equal(normalizeTime('12 pm'), '12:00');
  assert.equal(normalizeTime('25:00'), null);
  assert.equal(normalizeTime('nope'), null);
});

test('sanitizeBlocks sorts, fills bad end times and drops junk', () => {
  const out = sanitizeBlocks([
    { start: '14:00', end: '15:00', title: 'Gym', category: 'health' },
    { start: '10:00', end: '09:00', title: 'Client call', category: 'meeting' },
    { start: 'later', end: '11:00', title: 'Bad' },
    { start: '08:00', end: '09:00', title: '' },
    null,
    { start: '09:00', end: '10:00', title: 'Proposal', category: 'not-a-category', note: '  first draft  ' }
  ]);
  assert.deepEqual(out, [
    { start: '09:00', end: '10:00', title: 'Proposal', category: 'other', note: 'first draft' },
    { start: '10:00', end: '10:30', title: 'Client call', category: 'meeting' },
    { start: '14:00', end: '15:00', title: 'Gym', category: 'health' }
  ]);
  assert.deepEqual(sanitizeBlocks('nope'), []);
});

test('formatting helpers', () => {
  assert.equal(formatTime('13:30'), '1:30 PM');
  assert.equal(formatTime('00:05'), '12:05 AM');
  assert.equal(formatDuration('09:00', '10:30'), '1h 30m');
  assert.equal(formatDuration('09:00', '09:45'), '45 min');
});

test('changedKeys flags new and moved blocks only', () => {
  const prev = [{ start: '09:00', end: '10:00', title: 'Gym' }, { start: '10:00', end: '11:00', title: 'Call' }];
  const next = [{ start: '07:00', end: '08:00', title: 'Gym' }, { start: '10:00', end: '11:00', title: 'Call' }, { start: '12:00', end: '13:00', title: 'Lunch' }];
  assert.deepEqual([...changedKeys(prev, next)].sort(), ['gym', 'lunch']);
});

test('parseScheduleText reads one block per line', () => {
  const out = parseScheduleText('10:00-10:45 | Client call | meeting\n09:00-10:00 | Deep work | work | proposal draft\n- 18:00-19:00 | Gym | health\nnot a block');
  assert.deepEqual(out.map((b) => [b.start, b.end, b.title, b.category]), [
    ['09:00', '10:00', 'Deep work', 'work'],
    ['10:00', '10:45', 'Client call', 'meeting'],
    ['18:00', '19:00', 'Gym', 'health']
  ]);
  assert.equal(out[0].note, 'proposal draft');
  assert.deepEqual(parseScheduleText(''), []);
  assert.equal(parseScheduleText('[{"start":"9:00","end":"10:00","title":"A"}]').length, 1);
});
