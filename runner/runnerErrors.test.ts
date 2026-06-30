// Global exception visibility (meta-lesson A). describeError must extract a loggable message+stack from
// ANYTHING thrown without itself throwing — so the visibility helper never becomes the swallowed failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError, INVOCATION_ID } from './runnerErrors.js';

test('describeError: an Error yields its message + stack', () => {
  const e = new Error('boom');
  const d = describeError(e);
  assert.equal(d.message, 'boom');
  assert.ok(d.stack && d.stack.includes('boom'), 'stack captured');
});

test('describeError: a thrown string yields the string, no stack', () => {
  assert.deepEqual(describeError('plain failure'), { message: 'plain failure', stack: null });
});

test('describeError: a thrown object is JSON-serialised', () => {
  assert.deepEqual(describeError({ code: 500, detail: 'dismiss' }), {
    message: '{"code":500,"detail":"dismiss"}',
    stack: null,
  });
});

test('describeError: a CIRCULAR object never throws (falls back to String)', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const d = describeError(circular); // JSON.stringify would throw — must be caught
  assert.equal(typeof d.message, 'string');
  assert.equal(d.stack, null);
});

test('INVOCATION_ID is a stable per-process uuid', () => {
  assert.match(INVOCATION_ID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
