import assert from 'node:assert/strict';
import test from 'node:test';
import { createJevSelector } from '../lib/workflow-selector.mjs';

const input = {
  snapshot: { url: 'https://example.test', title: 'Example', text: 'Sign in to continue' },
  candidates: [
    { ref: 'ref_1', role: 'button', name: 'Continue', value: 'SECRET FIELD VALUE', href: '/next', disabled: false },
    { ref: 'ref_2', role: 'button', name: 'Cancel', disabled: true },
  ],
  goal: 'Continue signing in',
  subgoal: 'Use the Continue button',
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('sends one bounded TypeSafe choice request and returns usage', async () => {
  const calls = [];
  const select = createJevSelector({ apiKey: 'private-key', fetchImpl: async (...args) => {
    calls.push(args);
    return jsonResponse({ answers: { target: { type: 'choice', choice: 'ref_1' } }, usage: { input_tokens: 31, output_tokens: 4 } });
  } });

  const result = await select(input);
  assert.equal(result.ref, 'ref_1');
  assert.deepEqual({ ...result.usage, wall_ms: 0 }, {
    requests: 1, input_tokens: 31, output_tokens: 4, wall_ms: 0,
    request_bytes: result.usage.request_bytes,
  });
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.authorization, 'Bearer private-key');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'jev-latest');
  assert.equal(body.questions.target.type, 'choice');
  assert.deepEqual(Object.keys(body.questions.target.criteria), ['none', 'ref_1', 'ref_2']);
  assert.equal(body.state.elements[0].value, undefined);
  assert.doesNotMatch(options.body, /SECRET FIELD VALUE|private-key/);
  assert.equal(result.usage.request_bytes, Buffer.byteLength(options.body));
});

test('enforces the task-wide request budget across calls, including failures', async () => {
  let calls = 0;
  const select = createJevSelector({ apiKey: 'key', maxRequests: 2, fetchImpl: async () => {
    calls += 1;
    throw new Error('network includes key');
  } });
  await assert.rejects(select(input), /request failed/);
  await assert.rejects(select(input), /request failed/);
  await assert.rejects(select(input), /budget exhausted/);
  assert.equal(calls, 2);
});

test('rejects excessive candidates and input before fetch without dropping candidates', async () => {
  let calls = 0;
  const select = createJevSelector({ apiKey: 'key', maxInputChars: 500, fetchImpl: async () => { calls += 1; } });
  await assert.rejects(select({ ...input, candidates: Array.from({ length: 255 }, (_, i) => ({ ref: `ref_${i}` })) }), /at most 254/);
  await assert.rejects(select(input), /input exceeds/);
  assert.equal(calls, 0);
});

test('rejects a response choice outside the requested refs and attaches usage', async () => {
  const select = createJevSelector({ apiKey: 'key', fetchImpl: async () => jsonResponse({
    answers: { target: { type: 'choice', choice: 'ref_999' } }, usage: { input_tokens: 8, output_tokens: 2 },
  }) });
  await assert.rejects(select(input), error => {
    assert.match(error.message, /invalid choice/);
    assert.equal(error.usage.input_tokens, 8);
    return true;
  });
});

test('maps the explicit no-match choice to null', async () => {
  const select = createJevSelector({ apiKey: 'key', fetchImpl: async () => jsonResponse({
    answers: { target: { type: 'choice', choice: 'none' } }, usage: {},
  }) });
  assert.equal((await select(input)).ref, null);
});

test('aborts at the configured timeout and reports bounded usage', async () => {
  const select = createJevSelector({ apiKey: 'key', timeoutMs: 10, fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('secret upstream detail', 'AbortError')), { once: true });
  }) });
  await assert.rejects(select(input), error => {
    assert.equal(error.message, 'Jev selector request timed out.');
    assert.equal(error.usage.requests, 1);
    assert.ok(error.usage.request_bytes > 0);
    return true;
  });
});

test('the timeout also bounds a hanging response body', async () => {
  const select = createJevSelector({ apiKey: 'key', timeoutMs: 10, fetchImpl: async () => ({
    ok: true, status: 200, json: async () => new Promise(() => {}),
  }) });
  await assert.rejects(select(input), error => {
    assert.equal(error.message, 'Jev selector request timed out.');
    assert.equal(error.usage.requests, 1);
    return true;
  });
});

test('empty candidate sets resolve locally without consuming a request', async () => {
  let calls = 0;
  const select = createJevSelector({ apiKey: 'key', maxRequests: 0, fetchImpl: async () => { calls++; } });
  const result = await select({ ...input, candidates: [] });
  assert.equal(result.ref, null);
  assert.equal(result.usage.requests, 0);
  assert.equal(calls, 0);
});

test('redacts transport and HTTP response details', async () => {
  const transport = createJevSelector({ apiKey: 'top-secret', fetchImpl: async () => { throw new Error('top-secret server body'); } });
  await assert.rejects(transport(input), error => !/top-secret|server body/.test(error.message));

  const http = createJevSelector({ apiKey: 'top-secret', fetchImpl: async () => ({
    ok: false, status: 401, json: async () => ({ detail: 'top-secret body' }),
  }) });
  await assert.rejects(http(input), error => error.message === 'Jev selector service returned HTTP 401.');
});
