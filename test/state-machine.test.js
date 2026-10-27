import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTransition, canTransition } from '../src/state-machine.js';

test('allows the required happy-path order lifecycle', () => {
  assert.equal(canTransition('pending_payment', 'queued'), true);
  assert.equal(canTransition('queued', 'in_progress'), true);
  assert.equal(canTransition('in_progress', 'completed'), true);
});

test('allows recovery paths from delayed and failed', () => {
  assert.equal(canTransition('in_progress', 'delayed'), true);
  assert.equal(canTransition('delayed', 'queued'), true);
  assert.equal(canTransition('failed', 'queued'), true);
});

test('rejects illegal transitions', () => {
  assert.throws(() => assertTransition('completed', 'in_progress'), /invalid order transition/);
  assert.throws(() => assertTransition('pending_payment', 'completed'), /invalid order transition/);
});
