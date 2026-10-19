#!/usr/bin/env node
// Opt-in live benchmark: `node test/batch-live.mjs --browser dia`.
// Uses only a loopback fixture and one owned background tab; no paid models or user data.
import assert from 'node:assert/strict';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

import { BatchSession } from '../lib/batch.mjs';
import * as claims from '../lib/claims.mjs';
import { connect } from '../lib/daemon.mjs';
import { requireBrowser } from '../lib/discovery.mjs';
import * as ops from '../lib/ops.mjs';
import { closeTab, evaluate, navigate, waitForReady } from '../lib/ops.mjs';

const ITERATIONS = 10;

function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function fixtureHtml(mode) {
  const button = mode === 'send' ? 'Send' : 'Calculate';
  const result = mode === 'mismatch' ? 'Unexpected result' : 'Done';
  const overlay = mode === 'overlay'
    ? '<div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.01);z-index:10"></div>'
    : '';
  return `<!doctype html>
    <meta charset="utf-8"><title>Batch fixture</title>
    <style>body{font:16px sans-serif;padding:40px}label{display:block;margin:10px}button{margin:10px}</style>
    <form id="form" onsubmit="return false">
      <label>First name <input id="first" autocomplete="off"></label>
      <label>Last name <input id="last" autocomplete="off"></label>
      <label>Notes <textarea id="notes"></textarea></label>
      <label for="plan">Plan</label>
      <select id="plan"><option value="basic">Basic</option><option value="pro">Professional</option></select>
      <button id="calculate" type="button">${button}</button>
    </form>
    <output id="result"></output>${overlay}
    <script>
      window.clickCount = 0;
      calculate.addEventListener('click', () => {
        window.clickCount += 1;
        setTimeout(() => {
          result.textContent = ${JSON.stringify(result)} + ': ' +
            first.value + ' ' + last.value + ' | ' + plan.value + ' | ' + notes.value;
        }, 40);
      });
    </script>`;
}

async function fixtureServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(fixtureHtml(url.searchParams.get('mode') || 'normal'));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

function refNamed(observation, name) {
  const element = observation.elements.find(item => item.name === name);
  assert.ok(element, `fixture element ${JSON.stringify(name)} was not observed`);
  return element.ref;
}

function plan(observation, after = { textIncludes: 'Done:' }) {
  return [
    { kind: 'fill', ref: refNamed(observation, 'First name'), value: 'Ada' },
    { kind: 'fill', ref: refNamed(observation, 'Last name'), value: 'Lovelace' },
    { kind: 'fill', ref: refNamed(observation, 'Notes'), value: 'Analytical engine' },
    { kind: 'select', ref: refNamed(observation, 'Plan'), label: 'Professional' },
    { kind: 'click', ref: refNamed(observation, 'Calculate'), after },
  ];
}

async function pageState(conn, target) {
  return evaluate(conn, target, `(() => ({
    first: first.value, last: last.value, notes: notes.value, plan: plan.value,
    result: result.textContent, clicks: window.clickCount
  }))()`);
}

async function reset(conn, target, origin, mode, nonce) {
  await navigate(conn, target, `${origin}/?mode=${mode}&iteration=${nonce}`, { waitUntil: 'load' });
}

async function negativeCases(session, conn, target, origin) {
  const results = {};

  await reset(conn, target, origin, 'normal', 'changed');
  let observation = await session.observe();
  await evaluate(conn, target, `first.value = 'external'`);
  let outcome = await session.run({ token: observation.token, steps: plan(observation) });
  let state = await pageState(conn, target);
  assert.equal(outcome.status, 'needs_review');
  assert.deepEqual(state, { first: 'external', last: '', notes: '', plan: 'basic', result: '', clicks: 0 });
  results.changed_field = outcome.status;

  await reset(conn, target, origin, 'normal', 'replaced');
  observation = await session.observe();
  await evaluate(conn, target, `first.replaceWith(first.cloneNode(true))`);
  outcome = await session.run({ token: observation.token, steps: plan(observation) });
  state = await pageState(conn, target);
  assert.equal(outcome.status, 'needs_review');
  assert.deepEqual(state, { first: '', last: '', notes: '', plan: 'basic', result: '', clicks: 0 });
  results.replaced_node = outcome.status;

  await reset(conn, target, origin, 'normal', 'disabled-fieldset');
  observation = await session.observe();
  await evaluate(conn, target, `(() => {
    const label = first.closest('label'), group = document.createElement('fieldset');
    label.before(group); group.append(label); group.disabled = true;
  })()`);
  outcome = await session.run({ token: observation.token, steps: plan(observation) });
  state = await pageState(conn, target);
  assert.equal(outcome.status, 'needs_review');
  assert.deepEqual(state, { first: '', last: '', notes: '', plan: 'basic', result: '', clicks: 0 });
  results.disabled_fieldset = outcome.status;

  await reset(conn, target, origin, 'overlay', 'overlay');
  observation = await session.observe();
  outcome = await session.run({
    token: observation.token,
    steps: [{ kind: 'click', ref: refNamed(observation, 'Calculate'), after: { textIncludes: 'Done:' } }],
  });
  state = await pageState(conn, target);
  assert.equal(outcome.status, 'needs_review');
  assert.deepEqual(state, { first: '', last: '', notes: '', plan: 'basic', result: '', clicks: 0 });
  results.overlay = outcome.status;

  await reset(conn, target, origin, 'send', 'send');
  observation = await session.observe();
  outcome = await session.run({
    token: observation.token,
    steps: [{ kind: 'click', ref: refNamed(observation, 'Send'), after: { textIncludes: 'Done:' } }],
  });
  state = await pageState(conn, target);
  assert.equal(outcome.status, 'needs_review');
  assert.deepEqual(state, { first: '', last: '', notes: '', plan: 'basic', result: '', clicks: 0 });
  results.disallowed_send = outcome.status;

  await reset(conn, target, origin, 'mismatch', 'mismatch');
  observation = await session.observe();
  outcome = await session.run({
    token: observation.token,
    steps: [{ kind: 'click', ref: refNamed(observation, 'Calculate'), after: { textIncludes: 'Never appears' } }],
  });
  state = await pageState(conn, target);
  assert.equal(outcome.status, 'needs_review');
  assert.equal(outcome.uncertain, false);
  assert.equal(state.clicks, 1, 'postcondition failure must not replay the click');
  results.postcondition_mismatch = { status: outcome.status, clicks: state.clicks, uncertain: outcome.uncertain };

  await reset(conn, target, origin, 'normal', 'uncertain');
  const uncertainSession = new BatchSession(conn, target, {
    origin,
    adapter: { ...ops, fill: async () => { throw new Error('synthetic transport ambiguity'); } },
  });
  observation = await uncertainSession.observe();
  outcome = await uncertainSession.run({
    token: observation.token,
    steps: [{ kind: 'fill', ref: refNamed(observation, 'First name'), value: 'Ada' }],
  });
  state = await pageState(conn, target);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.uncertain, true);
  assert.deepEqual(state, { first: '', last: '', notes: '', plan: 'basic', result: '', clicks: 0 });
  results.synthetic_uncertain = { status: outcome.status, uncertain: outcome.uncertain };

  return results;
}

async function main() {
  const browserIndex = process.argv.indexOf('--browser');
  const browser = browserIndex === -1 ? null : process.argv[browserIndex + 1];
  if (browser !== 'dia' || process.argv.length !== 4) {
    throw new Error('usage: node test/batch-live.mjs --browser dia');
  }

  const fixture = await fixtureServer();
  let conn;
  let target;
  try {
    const connectStarted = performance.now();
    const port = await requireBrowser({ browser });
    conn = await connect(port);
    const connectMs = performance.now() - connectStarted;

    const tabStarted = performance.now();
    ({ targetId: target } = await conn.browser('Target.createTarget', {
      url: `${fixture.origin}/?mode=normal&iteration=startup`,
      background: true,
    }));
    claims.claim(port, target, { steal: true });
    await conn.send(target, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitForReady(conn, target, { waitUntil: 'load', timeoutMs: 10000 });
    const tabReadyMs = performance.now() - tabStarted;

    const session = new BatchSession(conn, target, { origin: fixture.origin, maxSteps: 12, maxMs: 15000 });
    const observeStarted = performance.now();
    await session.observe();
    const firstObserveMs = performance.now() - observeStarted;

    const runMs = [];
    const resetObserveMs = [];
    const completed = [];
    const allCasesStarted = performance.now();
    for (let index = 0; index < ITERATIONS; index += 1) {
      const preparationStarted = performance.now();
      await reset(conn, target, fixture.origin, 'normal', index);
      const observation = await session.observe();
      resetObserveMs.push(performance.now() - preparationStarted);
      const started = performance.now();
      const outcome = await session.run({ token: observation.token, steps: plan(observation) });
      runMs.push(performance.now() - started);
      assert.equal(outcome.status, 'completed');
      assert.equal(outcome.uncertain, false);
      const state = await pageState(conn, target);
      assert.deepEqual(state, {
        first: 'Ada', last: 'Lovelace', notes: 'Analytical engine', plan: 'pro',
        result: 'Done: Ada Lovelace | pro | Analytical engine', clicks: 1,
      });
      completed.push(outcome);
    }

    const negative = await negativeCases(session, conn, target, fixture.origin);
    const allCasesMs = performance.now() - allCasesStarted;
    const telemetry = completed.flatMap(result => result.steps);
    const output = {
      browser,
      iterations: ITERATIONS,
      startup_ms: {
        connect: Math.round(connectMs),
        owned_background_tab_ready: Math.round(tabReadyMs),
        first_observe: Math.round(firstObserveMs),
      },
      batch_run_ms: {
        p50: Math.round(percentile(runMs, 0.50)),
        p95: Math.round(percentile(runMs, 0.95)),
        min: Math.round(Math.min(...runMs)),
        max: Math.round(Math.max(...runMs)),
      },
      reset_and_observe_ms: {
        p50: Math.round(percentile(resetObserveMs, 0.50)),
        p95: Math.round(percentile(resetObserveMs, 0.95)),
      },
      all_success_and_negative_cases_ms: Math.round(allCasesMs),
      telemetry: {
        model_calls: completed.reduce((sum, result) => sum + result.metrics.model_calls, 0),
        actions_attempted: completed.reduce((sum, result) => sum + result.metrics.actions_attempted, 0),
        steps_completed: telemetry.filter(step => step.status === 'completed').length,
        step_duration_ms: {
          p50: percentile(telemetry.map(step => step.duration_ms), 0.50),
          p95: percentile(telemetry.map(step => step.duration_ms), 0.95),
        },
      },
      negative,
      verified_dom_iterations: completed.length,
    };
    process.stdout.write(JSON.stringify(output) + '\n');
  } finally {
    if (conn && target) await closeTab(conn, target).catch(() => {});
    conn?.close();
    await fixture.close();
  }
}

main().catch(error => {
  process.stderr.write(`batch live benchmark failed: ${error.message}\n`);
  process.exitCode = 1;
});
