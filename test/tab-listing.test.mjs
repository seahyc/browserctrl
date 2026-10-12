import test from 'node:test';
import assert from 'node:assert/strict';
import { tabs, resolveTab } from '../lib/ops.mjs';
import * as anonymousContexts from '../lib/anonymous.mjs';

test('listing and resolving never dispose a stale anonymous context', async () => {
  const port = 65432;
  const staleOriginalTarget = 'anonymous-original-target';
  const replacementTarget = 'anonymous-replacement-target';
  const ordinaryTarget = 'ordinary-target';
  const calls = [];
  const conn = {
    port,
    async browser(method, params) {
      calls.push({ method, params });
      assert.equal(method, 'Target.getTargets');
      return {
        targetInfos: [
          {
            targetId: replacementTarget,
            browserContextId: 'anonymous-context',
            type: 'page',
            title: 'Replacement tab',
            url: 'https://example.test/replacement',
            attached: false,
          },
          {
            targetId: ordinaryTarget,
            type: 'page',
            title: 'Ordinary tab',
            url: 'https://example.test/ordinary',
            attached: false,
          },
        ],
      };
    },
  };

  anonymousContexts.record(port, staleOriginalTarget, 'anonymous-context');
  try {
    const listed = await tabs(conn);
    assert.deepEqual(listed.map(tab => tab.targetId), [replacementTarget, ordinaryTarget]);
    assert.equal(listed[0].anonymous, false);

    const resolved = await resolveTab(conn, ordinaryTarget);
    assert.equal(resolved.targetId, ordinaryTarget);
    assert.deepEqual(calls.map(call => call.method), ['Target.getTargets', 'Target.getTargets']);
    assert.equal(anonymousContexts.get(port, staleOriginalTarget)?.browserContextId, 'anonymous-context');
  } finally {
    anonymousContexts.release(port, staleOriginalTarget);
  }
});
