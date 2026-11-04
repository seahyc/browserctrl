import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldIdleShutdown } from '../lib/daemon.mjs';

const idle = {
  openClients: 0, runningRequests: 0, elapsedMs: 120001, idleMs: 120000,
  recording: false, protectedEntry: false, protectedFill: false,
};

test('idle shutdown waits for protected fill and authentication state to clear', () => {
  assert.equal(shouldIdleShutdown({...idle, protectedFill: true}), false);
  assert.equal(shouldIdleShutdown({...idle, protectedEntry: true}), false);
  assert.equal(shouldIdleShutdown({...idle, protectedFill: true, protectedEntry: true}), false);
  assert.equal(shouldIdleShutdown(idle), true);
});

test('idle shutdown still respects live clients, requests, recordings and timeout', () => {
  assert.equal(shouldIdleShutdown({...idle, openClients: 1}), false);
  assert.equal(shouldIdleShutdown({...idle, runningRequests: 1}), false);
  assert.equal(shouldIdleShutdown({...idle, recording: true}), false);
  assert.equal(shouldIdleShutdown({...idle, elapsedMs: idle.idleMs}), false);
});
