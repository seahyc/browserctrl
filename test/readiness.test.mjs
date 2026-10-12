import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { waitForBackgroundReady } from '../lib/readiness.mjs';

function fixture(states, { body = 'Expected content', href = 'https://example.test/ready', visible = true } = {}) {
  const calls = [];
  const conn = { async send(target, method, params, timeoutMs, options) {
    calls.push({ target, method, timeoutMs, options });
    const readyState = states[Math.min(calls.length - 1, states.length - 1)];
    const element = { getBoundingClientRect: () => ({ width: visible ? 100 : 0, height: 20 }) };
    const document = { readyState, body: { innerText: body }, title: 'Fixture', hasFocus: () => false,
      querySelector: selector => selector === '#ready' ? element : null };
    return { result: { value: vm.runInNewContext(params.expression, {
      document, location: { href }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    }) } };
  } };
  return { conn, calls };
}

test('background readiness observes changing state without focus or navigation', async () => {
  const { conn, calls } = fixture(['loading', 'interactive', 'complete']);
  const result = await waitForBackgroundReady(conn, 'owned-tab', { timeoutMs: 1000 });
  assert.equal(result.ready, true);
  assert.equal(result.focused, false);
  assert.equal(result.title, 'Fixture');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.method === 'Runtime.evaluate' && call.target === 'owned-tab'));
  assert.ok(calls.every(call => call.options.light === true && call.timeoutMs > 0 && call.timeoutMs <= 1000));
});

test('DOMContentLoaded accepts interactive state and combines visible selector, text and URL', async () => {
  const { conn } = fixture(['interactive']);
  assert.equal((await waitForBackgroundReady(conn, 'tab', {
    waitUntil: 'domcontentloaded', selector: '#ready', text: 'Expected', url: '/ready',
  })).ready, true);
});

for (const options of [{ selector: '#absent' }, { text: 'missing' }, { url: '/missing' }]) {
  test(`unmet condition ${JSON.stringify(options)} times out`, async () => {
    const { conn } = fixture(['complete']);
    await assert.rejects(waitForBackgroundReady(conn, 'tab', { ...options, timeoutMs: 25 }), /timed out/);
  });
}

test('zero-sized selector does not count as visible', async () => {
  const { conn } = fixture(['complete'], { visible: false });
  await assert.rejects(waitForBackgroundReady(conn, 'tab', { selector: '#ready', timeoutMs: 25 }), /timed out/);
});

test('hung protocol call has an outer deadline and is not replayed', async () => {
  let calls = 0;
  const conn = { send() { calls++; return new Promise(() => {}); } };
  await assert.rejects(waitForBackgroundReady(conn, 'tab', { timeoutMs: 25 }), /timed out/);
  assert.equal(calls, 1);
});

test('closed connection and page exceptions are surfaced without retry', async () => {
  for (const send of [async () => { throw new Error('connection closed'); },
    async () => ({ exceptionDetails: { exception: { description: 'invalid selector' } } })]) {
    let calls = 0;
    await assert.rejects(waitForBackgroundReady({ send(...args) { calls++; return send(...args); } }, 'tab'),
      /connection closed|invalid selector/);
    assert.equal(calls, 1);
  }
});

test('invalid options fail before protocol access', async () => {
  const conn = { send() { assert.fail('must not access browser'); } };
  for (const timeoutMs of [0, -1, Infinity, NaN, 120001, '100']) {
    await assert.rejects(waitForBackgroundReady(conn, 'tab', { timeoutMs }), /timeoutMs/);
  }
  await assert.rejects(waitForBackgroundReady(conn, 'tab', { waitUntil: 'networkidle' }), /waitUntil/);
  await assert.rejects(waitForBackgroundReady(conn, 'tab', { selector: 3 }), /selector/);
});
