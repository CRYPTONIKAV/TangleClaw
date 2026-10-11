'use strict';

// #2270: sendSystemMessage posts with fetch and no timeout — a bridge that
// accepts and never answers leaves the call unsettled. The send is bounded
// by AbortSignal.timeout and settles like an unreachable bridge.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const medusa = require('../lib/medusa');
const { setLevel } = require('../lib/logger');

setLevel('error');

function hungFetch() {
  // A bridge that accepts and never answers. Tolerates a missing signal so
  // the same fake models pristine (no signal: hangs forever).
  return (_url, { signal } = {}) => new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
}

function okFetch() {
  return async () => ({ ok: true, status: 200, json: async () => ({ success: true, status: 'received', id: 'm1' }) });
}

describe('sendSystemMessage timeout (#2270)', () => {
  it('a hung bridge settles as unreachable instead of hanging', { timeout: 10000 }, async () => {
    // AbortSignal.timeout's timer is unref'd: hold the loop during the wait,
    // the way a live server process always does.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const started = Date.now();
      await assert.rejects(
        medusa.sendSystemMessage({ to: 'ws1', message: 'hello', fetchImpl: hungFetch(), timeoutMs: 50 }),
        (err) => {
          assert.match(err.message, /unreachable/i);
          assert.equal(err.code, 'BRIDGE_UNREACHABLE');
          return true;
        }
      );
      assert.ok(Date.now() - started < 5000, 'bounded, not hanging');
    } finally {
      clearInterval(keepAlive);
    }
  });

  it('a healthy send is unchanged', async () => {
    const res = await medusa.sendSystemMessage({ to: 'ws1', message: 'hello', fetchImpl: okFetch() });
    assert.equal(res.status, 'received');
    assert.equal(res.id, 'm1');
  });
});
