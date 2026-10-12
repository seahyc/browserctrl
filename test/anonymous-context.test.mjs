import test from 'node:test';
import assert from 'node:assert/strict';
import { newTab, closeTab } from '../lib/ops.mjs';

test('anonymous contexts have one explicit cleanup owner', async () => {
  const calls = [];
  const conn = {
    port: 65431,
    async browser(method, params) {
      calls.push({ method, params });
      if (method === 'Target.createBrowserContext') return { browserContextId: 'context-1' };
      if (method === 'Target.createTarget') return { targetId: 'target-1' };
      if (method === 'Target.closeTarget') return { success: true };
      if (method === 'Target.disposeBrowserContext') return {};
      throw new Error(`Unexpected method: ${method}`);
    },
  };

  const tab = await newTab(conn, 'about:blank', { anonymous: true });
  try {
    assert.deepEqual(calls[0], {
      method: 'Target.createBrowserContext',
      params: { disposeOnDetach: false },
    });
    await closeTab(conn, tab.targetId);
    assert.deepEqual(
      calls.slice(2).map(call => call.method),
      ['Target.closeTarget', 'Target.disposeBrowserContext'],
    );
  } finally {
    await closeTab(conn, tab.targetId).catch(() => {});
  }
});
