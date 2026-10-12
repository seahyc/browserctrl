import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BatchSession } from '../lib/batch.mjs';

const ORIGIN = 'https://example.test';

function adapterFixture({ elements, finalText = '', finalUrl = `${ORIGIN}/form` } = {}) {
  const initial = elements || [
    { ref: 'ref_1', role: 'textbox', name: 'Display name', tag: 'input', value: 'Old' },
    { ref: 'ref_2', role: 'button', name: 'Next', tag: 'button' },
  ];
  const live = new Map(initial.map((element, index) => [element.ref, {
    nodeId: index + 1,
    role: element.role,
    name: element.name,
    value: element.value ?? '',
    disabled: false,
    visible: true,
    hittable: true,
    readonly: false,
    inert: false,
    tag: element.tag,
    options: element.options ?? null,
    url: `${ORIGIN}/form`,
    inputType: element.inputType ?? (element.tag === 'input' ? 'text' : null),
    href: element.href ?? null,
  }]));
  const calls = [];
  let reads = 0;
  const adapter = {
    async readPage() {
      reads += 1;
      if (reads === 1) {
        return { token: 'token-1', url: `${ORIGIN}/form`, title: 'Fixture', text: '', elements: initial };
      }
      return { token: `poll-${reads}`, url: finalUrl, title: 'Fixture', text: finalText, elements: initial };
    },
    async evaluate(_conn, _target, expression) {
      if (expression.includes('return state.els.map(inspect)')) {
        return initial.map(element => ({ ...live.get(element.ref) }));
      }
      const match = expression.match(/Number\("(ref_\d+)"/);
      if (match) return { ...live.get(match[1]) };
      if (expression.startsWith('location.href ===')) return false;
      if (expression.includes("document.body?.innerText")) return false;
      return null;
    },
    async fill(_conn, _target, step) {
      calls.push({ kind: 'fill', ref: step.ref });
      live.get(step.ref).value = step.value;
      return { ok: true };
    },
    async selectOption(_conn, _target, step) {
      calls.push({ kind: 'select', ref: step.ref });
      live.get(step.ref).value = step.value;
      return { ok: true, value: step.value };
    },
    async click(_conn, _target, step) {
      calls.push({ kind: 'click', ref: step.ref });
      return { clicked: true };
    },
  };
  return { adapter, calls, live };
}

test('observe exposes compact stable refs and suppresses password values', async () => {
  const fixture = adapterFixture({ elements: [
    { ref: 'ref_1', role: 'textbox', name: 'Email', tag: 'input', inputType: 'email', value: 'a@example.test' },
    { ref: 'ref_2', role: 'textbox', name: 'Secret', tag: 'input', inputType: 'password' },
  ] });
  const session = new BatchSession({}, 'target', { origin: ORIGIN, adapter: fixture.adapter });

  const observed = await session.observe();

  assert.equal(observed.token, 'token-1');
  assert.equal(observed.elements[0].value, 'a@example.test');
  assert.equal('value' in observed.elements[1], false);
  assert.deepEqual(observed.elements.map(element => element.ref), ['ref_1', 'ref_2']);
});

test('runs guarded fill and final click with postcondition and zero model cost', async () => {
  const fixture = adapterFixture({ finalText: 'Done' });
  const session = new BatchSession({}, 'target', { origin: ORIGIN, adapter: fixture.adapter });
  const { token } = await session.observe();

  const result = await session.run({ token, steps: [
    { kind: 'fill', ref: 'ref_1', value: 'New private value' },
    { kind: 'click', ref: 'ref_2', after: { textIncludes: 'Done' } },
  ] });

  assert.equal(result.status, 'completed');
  assert.equal(result.uncertain, false);
  assert.deepEqual(fixture.calls, [{ kind: 'fill', ref: 'ref_1' }, { kind: 'click', ref: 'ref_2' }]);
  assert.equal(result.metrics.model_calls, 0);
  assert.equal(result.metrics.api_cost_usd, 0);
  assert.equal(result.metrics.actions_attempted, 2);
  assert.equal(typeof result.metrics.wall_ms, 'number');
  assert.equal(JSON.stringify(result).includes('New private value'), false);
});

test('rejects changed baseline value before mutation and consumes token', async () => {
  const fixture = adapterFixture();
  const session = new BatchSession({}, 'target', { origin: ORIGIN, adapter: fixture.adapter });
  const { token } = await session.observe();
  fixture.live.get('ref_1').value = 'Externally changed';

  const result = await session.run({ token, steps: [{ kind: 'fill', ref: 'ref_1', value: 'New' }] });
  assert.equal(result.status, 'needs_review');
  assert.match(result.reason, /value changed/);
  assert.equal(result.metrics.actions_attempted, 0);
  assert.deepEqual(fixture.calls, []);

  const replay = await session.run({ token, steps: [{ kind: 'fill', ref: 'ref_1', value: 'New' }] });
  assert.match(replay.reason, /already consumed/);
});

test('invalid plan consumes token and click cannot precede unseen future actions', async () => {
  const fixture = adapterFixture();
  const session = new BatchSession({}, 'target', { origin: ORIGIN, adapter: fixture.adapter });
  const { token } = await session.observe();

  const result = await session.run({ token, steps: [
    { kind: 'click', ref: 'ref_2', after: { textIncludes: 'Done' } },
    { kind: 'fill', ref: 'ref_1', value: 'New' },
  ] });
  assert.match(result.reason, /final batch boundary/);
  assert.deepEqual(fixture.calls, []);
  assert.match((await session.run({ token, steps: [] })).reason, /already consumed/);
});

test('risky and password controls are always denied', async () => {
  for (const element of [
    { ref: 'ref_1', role: 'button', name: 'Submit application', tag: 'button' },
    { ref: 'ref_1', role: 'button', name: 'Confirm', tag: 'button' },
    { ref: 'ref_1', role: 'button', name: 'Book now', tag: 'button' },
    { ref: 'ref_1', role: 'textbox', name: 'Credential', tag: 'input', inputType: 'password' },
  ]) {
    const fixture = adapterFixture({ elements: [element] });
    const session = new BatchSession({}, 'target', { origin: ORIGIN, adapter: fixture.adapter });
    const { token } = await session.observe();
    const step = element.role === 'button'
      ? { kind: 'click', ref: 'ref_1', after: { textIncludes: 'Done' } }
      : { kind: 'fill', ref: 'ref_1', value: 'secret' };
    const result = await session.run({ token, steps: [step] });
    assert.equal(result.status, 'needs_review');
    assert.deepEqual(fixture.calls, []);
  }
});

test('mutation error is uncertain and never replayed', async () => {
  const fixture = adapterFixture();
  fixture.adapter.fill = async (_conn, _target, step) => {
    fixture.calls.push({ kind: 'fill', ref: step.ref });
    throw new Error('transport closed');
  };
  const session = new BatchSession({}, 'target', { origin: ORIGIN, adapter: fixture.adapter });
  const { token } = await session.observe();

  const result = await session.run({ token, steps: [{ kind: 'fill', ref: 'ref_1', value: 'Private' }] });

  assert.equal(result.status, 'failed');
  assert.equal(result.uncertain, true);
  assert.match(result.reason, /not replayed/);
  assert.deepEqual(fixture.calls, [{ kind: 'fill', ref: 'ref_1' }]);
  assert.equal(JSON.stringify(result).includes('Private'), false);
});

test('cross-origin click postcondition stops before mutation', async () => {
  const fixture = adapterFixture({ finalUrl: 'https://outside.test/done' });
  const session = new BatchSession({}, 'target', { origin: ORIGIN, adapter: fixture.adapter });
  const { token } = await session.observe();

  const result = await session.run({
    token,
    steps: [{ kind: 'click', ref: 'ref_2', after: { urlEquals: 'https://outside.test/done' } }],
  });

  assert.equal(result.status, 'needs_review');
  assert.match(result.reason, /leaves the batch origin/);
  assert.deepEqual(fixture.calls, []);
  assert.equal(result.metrics.actions_attempted, 0);
});

test('rejects a field that becomes sensitive or is not a supported native text input', async () => {
  for (const inputType of ['password', 'checkbox']) {
    const fixture = adapterFixture({ elements: [
      { ref: 'ref_1', role: 'textbox', name: 'Field', tag: 'input', inputType: 'text', value: '' },
    ] });
    const session = new BatchSession({}, 'target', { origin: ORIGIN, adapter: fixture.adapter });
    const { token } = await session.observe();
    fixture.live.get('ref_1').inputType = inputType;

    const result = await session.run({ token, steps: [{ kind: 'fill', ref: 'ref_1', value: 'private' }] });
    assert.equal(result.status, 'needs_review');
    assert.deepEqual(fixture.calls, []);
  }
});

test('rejects a cross-origin link before clicking', async () => {
  const fixture = adapterFixture({ elements: [
    { ref: 'ref_1', role: 'link', name: 'Continue', tag: 'a', href: 'https://outside.test/next' },
  ] });
  const session = new BatchSession({}, 'target', { origin: ORIGIN, adapter: fixture.adapter });
  const { token } = await session.observe();

  const result = await session.run({
    token,
    steps: [{ kind: 'click', ref: 'ref_1', after: { textIncludes: 'Done' } }],
  });

  assert.equal(result.status, 'needs_review');
  assert.match(result.reason, /leaves the batch origin/);
  assert.deepEqual(fixture.calls, []);
  assert.equal(result.metrics.actions_attempted, 0);
});

test('verified click observation is reused once without another page read', async () => {
  const fixture = adapterFixture({ finalText: 'Done' });
  let reads = 0;
  const original = fixture.adapter.readPage;
  fixture.adapter.readPage = async (...args) => { reads++; return original(...args); };
  const session = new BatchSession({}, 'target', { origin: ORIGIN, adapter: fixture.adapter });
  const first = await session.observe();
  await session.run({ token: first.token, steps: [{ kind: 'click', ref: 'ref_2', after: { textIncludes: 'Done' } }] });
  assert.equal(reads, 2);
  const next = await session.observe({ reuseVerified: true });
  assert.equal(next.text, 'Done');
  assert.equal(reads, 2);
  await session.observe({ reuseVerified: true });
  assert.equal(reads, 3, 'cache is consumed, never reused twice');
});

test('stale verified observation falls back to a fresh read without replay', async () => {
  const fixture = adapterFixture({ finalText: 'Done' });
  const session = new BatchSession({}, 'target', { origin: ORIGIN, adapter: fixture.adapter });
  const first = await session.observe();
  await session.run({ token: first.token, steps: [{ kind: 'click', ref: 'ref_2', after: { textIncludes: 'Done' } }] });
  const original = fixture.adapter.evaluate;
  let stale = true;
  fixture.adapter.evaluate = async (...args) => {
    if (stale && args[2].includes('return state.els.map(inspect)')) { stale = false; return null; }
    return original(...args);
  };
  const next = await session.observe({ reuseVerified: true });
  assert.equal(next.token, 'poll-3');
  assert.equal(fixture.calls.length, 1);
});
