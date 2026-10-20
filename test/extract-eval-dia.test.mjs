import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDiaAdapter, installCleanupSignals } from '../bench/extract-eval/dia.mjs';

function mock(responses) {
  const calls = [];
  const adapter = createDiaAdapter({ env: { PATH: '/installed', BROWSERCTRL_AGENT_ID: 'other' }, execute(file, args, opts, cb) {
    calls.push({ file, args, opts });
    const response = responses.shift();
    queueMicrotask(() => cb(response?.error || null, response?.stdout ?? '{}', response?.stderr || ''));
  } });
  return { adapter, calls };
}

test('Dia uses installed CLI, one owned tab and structured stopped report', async () => {
  const { adapter, calls } = mock([
    { stdout: '{"targetId":"owned"}' }, {}, { stdout: '42\n' },
    { error: { code: 3 }, stdout: '{"stopped":"absent","jev_calls":2}' }, {},
  ]);
  const tab = await adapter.newTab(null, 'https://example.com');
  await adapter.waitForReady(null, tab.targetId);
  assert.equal(await adapter.evaluate(null, 'owned', 'document.title'), 42);
  assert.equal((await adapter.runSteps(null, 'owned', ['extract "missing"'])).stopped, 'absent');
  await adapter.closeTab(null, 'unowned');
  await adapter.cleanup();
  assert.deepEqual(calls.map(c => c.args[0]), ['open', 'ready', 'eval', 'do', 'close']);
  assert.deepEqual(calls[0].args, ['open', 'https://example.com', '--until', 'none']);
  assert.ok(calls[3].args.includes('--json'));
  for (const c of calls) {
    assert.equal(c.file, 'browserctrl');
    assert.equal(c.opts.env.BROWSERCTRL_BROWSER, 'dia');
    assert.equal(c.opts.env.BROWSERCTRL_AGENT_ID, 'extract-eval');
  }
  await assert.rejects(adapter.evaluate(null, 'unowned', '1'), /not owned/);
  await assert.rejects(adapter.newTab(null, 'https://example.com'), /interrupted/);
});

test('Dia cleanup waits for in-flight open and closes it once', async () => {
  let finishOpen;
  const calls = [];
  const adapter = createDiaAdapter({ execute(_file, args, _opts, cb) {
    calls.push(args);
    if (args[0] === 'open') finishOpen = cb;
    else queueMicrotask(() => cb(null, '{}', ''));
  } });
  const opened = adapter.newTab(null, 'https://example.com');
  const rejection = assert.rejects(opened, /interrupted/);
  const cleaned = adapter.cleanup();
  finishOpen(null, '{"targetId":"late"}', '');
  await Promise.all([rejection, cleaned]);
  assert.deepEqual(calls.map(c => c[0]), ['open', 'close']);
});

test('Dia closes owned tab after failed execution and rejects malformed reports', async () => {
  const { adapter, calls } = mock([{ stdout: '{"targetId":"owned"}' }, { stdout: 'not JSON' }, {}]);
  await adapter.newTab(null, 'https://example.com');
  await assert.rejects(adapter.runSteps(null, 'owned', ['extract "x"']), /invalid JSON/);
  await adapter.cleanup();
  assert.deepEqual(calls.at(-1).args, ['close', 'owned']);
});

test('Dia command failure cannot authorize closing another tab', async () => {
  const { adapter, calls } = mock([{ error: { code: 1, message: 'failed' } }]);
  await assert.rejects(adapter.newTab(null, 'https://example.com'), /failed/);
  await adapter.cleanup();
  assert.equal(calls.length, 1);
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} closes only owned tabs before exit`, async () => {
    const { adapter, calls } = mock([{ stdout: '{"targetId":"owned"}' }, {}]);
    await adapter.newTab(null, 'https://example.com');
    const source = new EventEmitter();
    const exited = new Promise(resolve => installCleanupSignals(() => adapter.cleanup(), { source, exit: resolve }));
    source.emit(signal);
    assert.equal(await exited, code);
    assert.deepEqual(calls.map(c => c.args[0]), ['open', 'close']);
  });
}
