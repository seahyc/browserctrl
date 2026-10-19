#!/usr/bin/env node
// Opt-in live evaluation against a loopback fixture and one owned Dia tab.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { BatchSession } from '../lib/batch.mjs';
import * as claims from '../lib/claims.mjs';
import { connect } from '../lib/daemon.mjs';
import { requireBrowser } from '../lib/discovery.mjs';
import { closeTab, evaluate, navigate, waitForReady } from '../lib/ops.mjs';
import { WorkflowSession, matching } from '../lib/workflow.mjs';
import { createJevSelector } from '../lib/workflow-selector.mjs';
import { plans, startFixture } from './workflow-fixture.mjs';

function argumentsFor(argv) {
  const options = { browser: null, port: null, iterations: 5, output: null, jev: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--jev') options.jev = true;
    else if (item === '--browser') options.browser = argv[++index];
    else if (item === '--port') options.port = Number(argv[++index]);
    else if (item === '--iterations') options.iterations = Number(argv[++index]);
    else if (item === '--output') options.output = argv[++index];
    else throw new Error(`Unknown argument: ${item}`);
  }
  const explicitDia = options.browser === 'dia' && options.port === null;
  const explicitPort = options.browser === null && Number.isInteger(options.port) && options.port > 0;
  if ((!explicitDia && !explicitPort) || !Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error('usage: node test/workflow-live.mjs (--browser dia | --port PORT) [--iterations N] [--output PATH] [--jev]');
  }
  if (options.jev && !process.env.TYPESAFE_API_KEY) throw new Error('--jev requires TYPESAFE_API_KEY');
  return options;
}

const percentile = (values, q) => {
  const measured = values.filter(Number.isFinite);
  if (!measured.length) return null;
  const sorted = [...measured].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)]);
};

function isSubset(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((value, i) => isSubset(actual[i], value));
  if (expected && typeof expected === 'object') {
    return actual && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => isSubset(actual[key], value));
  }
  return Object.is(actual, expected);
}

async function reset(conn, target, origin, path) {
  const started = performance.now();
  await navigate(conn, target, origin + path, { waitUntil: 'load' });
  await evaluate(conn, target, 'sessionStorage.clear()');
  await navigate(conn, target, origin + path, { waitUntil: 'load' });
  await waitForReady(conn, target, { waitUntil: 'load', timeoutMs: 10000 });
  return performance.now() - started;
}

async function state(conn, target) {
  return evaluate(conn, target, 'window.fixtureState()');
}

function exactSteps(snapshot, actions) {
  return actions.map(action => {
    const candidates = matching(snapshot, action.target);
    if (candidates.length !== 1) throw new Error(candidates.length ? 'Ambiguous target; exact match is not unique' : 'Exact target not found');
    const { target, semantic, ...step } = action;
    return { ...step, ref: candidates[0].ref };
  });
}

async function stagedBatch(batch, plan) {
  const started = performance.now();
  const outcomes = [];
  try {
    for (const stage of plan.stages) {
      const snapshot = await batch.observe();
      const outcome = await batch.run({ token: snapshot.token, steps: exactSteps(snapshot, stage.actions) });
      outcomes.push(outcome);
      if (outcome.status !== 'completed') throw new Error(outcome.reason);
    }
    const final = await batch.observe();
    const condition = plan.success.textIncludes
      ? final.text.includes(plan.success.textIncludes)
      : final.url === plan.success.urlEquals;
    if (!condition) throw new Error('Final workflow outcome was not observed');
    return { status: 'completed', outcomes, runner_ms: performance.now() - started };
  } catch (error) {
    return { status: 'needs_review', reason: error.message, outcomes, runner_ms: performance.now() - started };
  }
}

function metricsOf(result) {
  if (result.metrics) return result.metrics;
  return {
    actions_attempted: result.outcomes.reduce((sum, row) => sum + (row.metrics?.actions_attempted || 0), 0),
    model_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    token_usage_complete: true,
  };
}

async function attempt({ conn, target, origin, plan, method, select }) {
  const setupMs = await reset(conn, target, origin, plan.startPath);
  const batch = new BatchSession(conn, target, { origin, maxSteps: 12, maxMs: 15000 });
  const started = performance.now();
  let result;
  if (method === 'staged-batch') result = await stagedBatch(batch, plan);
  else result = await new WorkflowSession({ batch, select, maxMs: 30000, maxModelRequests: select ? 1 : 0 }).run(plan);
  const runnerMs = result.runner_ms ?? performance.now() - started;
  const actual = await state(conn, target).catch(() => null);
  const oracleOk = isSubset(actual, plan.oracle);
  const metrics = metricsOf(result);
  return {
    scenario: plan.id,
    method,
    runner_ms: Math.round(runnerMs),
    setup_ms: Math.round(setupMs),
    oracle_ok: oracleOk,
    status: result.status,
    actions: metrics.actions_attempted || 0,
    model_calls: metrics.model_calls || 0,
    tokens: {
      input: metrics.input_tokens || 0,
      output: metrics.output_tokens || 0,
      complete: metrics.token_usage_complete !== false,
    },
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

async function negativeAttempt({ conn, target, origin, id, path, plan, select = null, expected }) {
  const setupMs = await reset(conn, target, origin, path);
  const batch = new BatchSession(conn, target, { origin, maxSteps: 12, maxMs: 15000 });
  const started = performance.now();
  let result;
  try {
    result = await new WorkflowSession({ batch, select, maxMs: 15000, maxModelRequests: select ? 1 : 0 }).run(plan);
    const actual = await state(conn, target);
    assert.notEqual(result.status, 'completed', `${id} falsely completed`);
    assert.ok(isSubset(actual, expected), `${id} mutated state unexpectedly: ${JSON.stringify(actual)}`);
    return {
      scenario: `negative:${id}`, method: 'continuous', runner_ms: Math.round(performance.now() - started),
      setup_ms: Math.round(setupMs), oracle_ok: true, status: result.status,
      actions: result.metrics.actions_attempted, model_calls: result.metrics.model_calls,
      tokens: { input: result.metrics.input_tokens, output: result.metrics.output_tokens, complete: result.metrics.token_usage_complete },
      reason: result.reason,
    };
  } catch (error) {
    return {
      scenario: `negative:${id}`, method: 'continuous', runner_ms: Math.round(performance.now() - started),
      setup_ms: Math.round(setupMs), oracle_ok: false, status: 'assertion_failed', actions: result?.metrics?.actions_attempted || 0,
      model_calls: result?.metrics?.model_calls || 0, tokens: { input: 0, output: 0, complete: false }, reason: error.message,
    };
  }
}

async function negativeCases(context) {
  const { origin } = context;
  const cases = [
    {
      id: 'ambiguous-target', path: '/ambiguous', expected: { route: '/ambiguous', clickCount: {} },
      plan: { goal: 'Continue', stages: [{ expect: { textIncludes: 'Ambiguous controls' }, actions: [{ kind: 'click', target: { role: 'button', name: 'Next' }, after: { textIncludes: 'Never appears' } }] }], success: { textIncludes: 'Never appears' } },
    },
    {
      id: 'validation-fails', path: '/validation', expected: { route: '/validation', results: [], clickCount: { 'validation-next': 1 } },
      plan: { goal: 'Continue without a title', stages: [{ expect: { textIncludes: 'Validation example' }, actions: [{ kind: 'click', target: { role: 'button', name: 'Next' }, after: { textIncludes: 'Draft ready' } }] }], success: { textIncludes: 'Draft ready' } },
    },
    {
      id: 'forbidden-send', path: '/blocked', expected: { route: '/blocked', forbiddenCount: 0 },
      plan: { goal: 'Send', stages: [{ expect: { textIncludes: 'Blocked action' }, actions: [{ kind: 'click', target: { role: 'button', name: 'Send' }, after: { textIncludes: 'Never appears' } }] }], success: { textIncludes: 'Never appears' } },
    },
    {
      id: 'false-final-success', path: '/admin', expected: { route: '/admin/person/yc' },
      plan: { goal: 'Open details', stages: [{ expect: { textIncludes: 'User directory' }, actions: [{ kind: 'click', target: { role: 'link', name: 'Details', href: `${origin}/admin/person/yc` }, after: { urlEquals: `${origin}/admin/person/yc` } }] }], success: { textIncludes: 'Draft ready' } },
    },
    {
      id: 'unobserved-selector-ref', path: '/research', expected: { route: '/research', clickCount: {} },
      select: async () => ({ ref: 'ref_unobserved', usage: { input_tokens: 1, output_tokens: 1 } }),
      plan: { goal: 'Research CDP automation', stages: [{ expect: { textIncludes: 'Research library' }, actions: [{ kind: 'click', target: { role: 'link' }, semantic: 'Choose the automation category', after: { urlEquals: `${origin}/research/automation` } }] }], success: { textIncludes: 'Automation research' } },
    },
  ];
  const rows = [];
  for (const item of cases) rows.push(await negativeAttempt({ ...context, ...item }));
  return rows;
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const fixture = await startFixture();
  let conn;
  let target;
  let port;
  const rows = [];
  try {
    port = options.port ?? await requireBrowser({ browser: options.browser });
    conn = await connect(port);
    ({ targetId: target } = await conn.browser('Target.createTarget', { url: `${fixture.origin}/job`, background: true }));
    claims.claim(port, target);
    await conn.send(target, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitForReady(conn, target, { waitUntil: 'load', timeoutMs: 10000 });

    const fixturePlans = plans(fixture.origin);
    const jevSelector = options.jev ? createJevSelector({ apiKey: process.env.TYPESAFE_API_KEY, maxRequests: options.iterations }) : null;
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      for (let scenario = 0; scenario < fixturePlans.length; scenario += 1) {
        const plan = fixturePlans[scenario];
        const methods = ['staged-batch', 'continuous'];
        if (options.jev && plan.id === 'research-cdp') methods.push('continuous-jev');
        const offset = (iteration + scenario) % methods.length;
        for (let index = 0; index < methods.length; index += 1) {
          const method = methods[(index + offset) % methods.length];
          const attemptStarted = performance.now();
          const runPlan = method === 'continuous-jev'
            ? structuredClone(plan)
            : plan;
          if (method === 'continuous-jev') {
            runPlan.stages[0].actions[0].target = { role: 'link' };
            runPlan.stages[0].actions[0].semantic = 'Choose the category about automating browsers';
          }
          try {
            rows.push(await attempt({ conn, target, origin: fixture.origin, plan: runPlan, method, select: method === 'continuous-jev' ? jevSelector : null }));
          } catch (error) {
            rows.push({ scenario: plan.id, method, runner_ms: Math.round(performance.now() - attemptStarted), setup_ms: null, oracle_ok: false, status: 'runner_failed', actions: 0, model_calls: 0, tokens: { input: 0, output: 0, complete: false }, reason: error.message });
          }
        }
      }
    }
    rows.push(...await negativeCases({ conn, target, origin: fixture.origin }));
    const durations = rows.map(row => row.runner_ms);
    const output = {
      browser: options.browser ?? `isolated-chrome:${options.port}`,
      iterations: options.iterations,
      jev: options.jev,
      rows,
      summary: {
        p50: percentile(durations, 0.50),
        p95: percentile(durations, 0.95),
        success_count: rows.filter(row => row.status === 'completed' && row.oracle_ok).length,
        total: rows.length,
      },
    };
    const serialized = JSON.stringify(output, null, 2) + '\n';
    if (options.output) await writeFile(options.output, serialized, 'utf8');
    process.stdout.write(serialized);
  } finally {
    if (conn && target) {
      await closeTab(conn, target).catch(() => {});
      if (port) claims.release(port, target);
    }
    conn?.close();
    await fixture.close();
  }
}

main().catch(error => {
  process.stderr.write(`workflow live evaluation failed: ${error.message}\n`);
  process.exitCode = 1;
});
