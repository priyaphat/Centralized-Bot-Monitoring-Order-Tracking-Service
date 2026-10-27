import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/retry.js';

test('retries transient work and returns the successful result', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('temporary');
    return 'ok';
  }, { attempts: 3, baseDelayMs: 1 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('throws after the configured number of attempts', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw new Error('down'); }, { attempts: 2, baseDelayMs: 1 }), /down/);
  assert.equal(calls, 2);
});
