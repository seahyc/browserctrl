import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowSession } from '../lib/workflow.mjs';

function snapshot({ token, text = '', url = 'https://example.test/', elements = [] }) {
  return { token, text, url, title: 'Test page', elements };
}

class FakeBatchSession {
  constructor(snapshots, outcomes = []) {
    this.maxSteps = 10;
    this.maxMs = 10_000;
    this.snapshots = [...snapshots];
    this.outcomes = [...outcomes];
    this.observeCalls = [];
    this.runCalls = [];
  }

  async observe({ reuseVerified }) {
    this.observeCalls.push({ reuseVerified });
    if (!this.snapshots.length) throw new Error('No fake snapshot available');
    return this.snapshots.shift();
  }

  async run(request) {
    this.runCalls.push(request);
    return this.outcomes.shift() ?? {
      status: 'completed', steps: request.steps.map(step => ({ ...step, status: 'completed' })),
      metrics: { actions_attempted: request.steps.length }, actions: request.steps.length,
    };
  }
}

const click = (name, after) => ({ kind: 'click', target: { role: 'button', name }, after });
const plan = (stages, success = { textIncludes: 'Done' }) => ({ goal: 'Complete the flow', stages, success });
const stage = (expect, actions) => ({ expect, actions });

test('resolves every stage from a fresh verified snapshot and reuses verified observations', async () => {
  const batch = new FakeBatchSession([
    snapshot({ token: 't1', text: 'First', elements: [{ ref: 'old-ref', role: 'button', name: 'Next' }] }),
    snapshot({ token: 't2', text: 'Second', elements: [{ ref: 'fresh-ref', role: 'button', name: 'Finish' }] }),
    snapshot({ token: 't3', text: 'Done' }),
  ]);
  const workflow = new WorkflowSession({ batch, conditionWaitMs: 0 });
  const result = await workflow.run(plan([
    stage({ textIncludes: 'First' }, [click('Next', { textIncludes: 'Second' })]),
    stage({ textIncludes: 'Second' }, [click('Finish', { textIncludes: 'Done' })]),
  ]));

  assert.equal(result.status, 'completed');
  assert.deepEqual(batch.observeCalls, [{ reuseVerified: false }, { reuseVerified: true }, { reuseVerified: true }]);
  assert.deepEqual(batch.runCalls.map(call => [call.token, call.steps[0].ref]), [['t1', 'old-ref'], ['t2', 'fresh-ref']]);
  assert.equal(result.metrics.actions_attempted, 2);
});

test('ambiguous exact target dispatches no action and takes no model input', async () => {
  const batch = new FakeBatchSession([
    snapshot({ token: 't1', text: 'Ready', elements: [
      { ref: 'a', role: 'button', name: 'Go' }, { ref: 'b', role: 'button', name: 'Go' },
    ] }),
    snapshot({ token: 'recovery', text: 'Ready' }),
  ]);
  let modelCalls = 0;
  const result = await new WorkflowSession({ batch, select: async () => { modelCalls++; }, conditionWaitMs: 0 }).run(
    plan([stage({ textIncludes: 'Ready' }, [click('Go', { textIncludes: 'Done' })])]),
  );
  assert.equal(result.status, 'needs_review');
  assert.equal(result.recovery.category, 'ambiguous_target');
  assert.equal(modelCalls, 0);
  assert.equal(batch.runCalls.length, 0);
});

test('failed stage precondition stops before model selection', async () => {
  const batch = new FakeBatchSession([
    snapshot({ token: 't1', text: 'Wrong', elements: [{ ref: 'a', role: 'button', name: 'Go' }] }),
    snapshot({ token: 'recovery', text: 'Wrong' }),
  ]);
  let modelCalls = 0;
  const result = await new WorkflowSession({ batch, select: async () => { modelCalls++; }, conditionWaitMs: 0 }).run(
    plan([stage({ textIncludes: 'Ready' }, [{ ...click('Go', { textIncludes: 'Done' }), semantic: 'the primary action' }])]),
  );
  assert.match(result.reason, /precondition/);
  assert.equal(modelCalls, 0);
  assert.equal(batch.runCalls.length, 0);
});

test('missing semantic selector is reviewable and never dispatched', async () => {
  const batch = new FakeBatchSession([
    snapshot({ token: 't1', text: 'Ready', elements: [{ ref: 'a', role: 'button', name: 'Go' }] }),
    snapshot({ token: 'recovery', text: 'Ready' }),
  ]);
  const result = await new WorkflowSession({ batch, conditionWaitMs: 0 }).run(plan([
    stage({ textIncludes: 'Ready' }, [{ ...click('Go', { textIncludes: 'Done' }), semantic: 'best action' }]),
  ]));
  assert.match(result.reason, /explicitly configured selector/);
  assert.equal(batch.runCalls.length, 0);
});

test('model budget is task-wide and a completed mutation is not replayed', async () => {
  const batch = new FakeBatchSession([
    snapshot({ token: 't1', text: 'First', elements: [{ ref: 'a', role: 'button', name: 'Next' }] }),
    snapshot({ token: 't2', text: 'Second', elements: [{ ref: 'b', role: 'button', name: 'Finish' }] }),
    snapshot({ token: 'recovery', text: 'Second' }),
  ]);
  let selections = 0;
  const select = async ({ candidates }) => ({ ref: candidates[0].ref, usage: { requests: 1, input_tokens: 2, output_tokens: 1 } });
  const result = await new WorkflowSession({ batch, select: async args => { selections++; return select(args); }, maxModelRequests: 1, conditionWaitMs: 0 }).run(plan([
    stage({ textIncludes: 'First' }, [{ ...click('Next', { textIncludes: 'Second' }), semantic: 'next' }]),
    stage({ textIncludes: 'Second' }, [{ ...click('Finish', { textIncludes: 'Done' }), semantic: 'finish' }]),
  ]));
  assert.equal(result.recovery.category, 'budget');
  assert.equal(result.recovery.replayed, false);
  assert.equal(selections, 1);
  assert.equal(batch.runCalls.length, 1);
  assert.equal(result.metrics.model_calls, 1);
  assert.equal(result.metrics.selector_attempts, 1);
});

test('uncertain batch outcome refreshes evidence without replaying the mutation', async () => {
  const batch = new FakeBatchSession([
    snapshot({ token: 't1', text: 'Ready', elements: [{ ref: 'a', role: 'button', name: 'Submit' }] }),
    snapshot({ token: 'recovery', text: 'Maybe submitted' }),
  ], [{ status: 'needs_review', reason: 'Delivery uncertain after transport failure', uncertain: true,
    steps: [{ status: 'uncertain' }], metrics: { actions_attempted: 1 }, actions: 1 }]);
  const result = await new WorkflowSession({ batch, conditionWaitMs: 0 }).run(plan([
    stage({ textIncludes: 'Ready' }, [click('Submit', { textIncludes: 'Done' })]),
  ]));
  assert.equal(result.status, 'needs_review');
  assert.equal(result.uncertain, true);
  assert.equal(result.recovery.category, 'delivery_uncertain');
  assert.equal(result.recovery.replayed, false);
  assert.equal(batch.runCalls.length, 1);
  assert.deepEqual(batch.observeCalls, [{ reuseVerified: false }, { reuseVerified: false }]);
});

test('malformed later stage rejects the whole plan before earlier dispatch', async () => {
  const batch = new FakeBatchSession([]);
  const workflow = new WorkflowSession({ batch, conditionWaitMs: 0 });
  await assert.rejects(workflow.run(plan([
    stage({ textIncludes: 'First' }, [click('Next', { textIncludes: 'Second' })]),
    stage({ textIncludes: 'Second' }, [{ kind: 'hover', target: { name: 'Bad' } }]),
  ])), /supported actions/);
  assert.equal(batch.observeCalls.length, 0);
  assert.equal(batch.runCalls.length, 0);
});

test('concurrent run is rejected while the session is busy', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const batch = new FakeBatchSession([]);
  batch.observe = async ({ reuseVerified }) => {
    batch.observeCalls.push({ reuseVerified });
    await held;
    return snapshot({ token: 't1', text: 'Ready', elements: [] });
  };
  const workflow = new WorkflowSession({ batch, conditionWaitMs: 0 });
  const valid = plan([stage({ textIncludes: 'Ready' }, [click('Missing', { textIncludes: 'Done' })])]);
  const first = workflow.run(valid);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(workflow.run(valid), /already in use/);
  release();
  const result = await first;
  assert.equal(result.status, 'needs_review');
});

test('final goal verification can fail even when every stage passes', async () => {
  const batch = new FakeBatchSession([
    snapshot({ token: 't1', text: 'Ready', elements: [{ ref: 'a', role: 'button', name: 'Go' }] }),
    snapshot({ token: 't2', text: 'Intermediate success' }),
    snapshot({ token: 'recovery', text: 'Intermediate success' }),
  ]);
  const result = await new WorkflowSession({ batch, conditionWaitMs: 0 }).run(plan([
    stage({ textIncludes: 'Ready' }, [click('Go', { textIncludes: 'Intermediate success' })]),
  ], { textIncludes: 'Actually done' }));
  assert.equal(result.stages[0].status, 'completed');
  assert.match(result.reason, /Final workflow outcome/);
  assert.equal(result.recovery.category, 'verification');
  assert.equal(batch.runCalls.length, 1);
});

test('waits read-only for an eventual stage precondition before resolving actions', async () => {
  const batch = new FakeBatchSession([
    snapshot({ token: 'loading', text: 'Loading' }),
    snapshot({ token: 'ready', text: 'Ready', elements: [{ ref: 'a', role: 'button', name: 'Go' }] }),
    snapshot({ token: 'done', text: 'Done' }),
  ]);
  const result = await new WorkflowSession({ batch, conditionWaitMs: 100 }).run(plan([
    stage({ textIncludes: 'Ready' }, [click('Go', { textIncludes: 'Done' })]),
  ]));
  assert.equal(result.status, 'completed');
  assert.equal(batch.runCalls[0].token, 'ready');
  assert.deepEqual(batch.observeCalls, [
    { reuseVerified: false }, { reuseVerified: false }, { reuseVerified: true },
  ]);
});

test('waits read-only for eventual final success after a completed stage', async () => {
  const batch = new FakeBatchSession([
    snapshot({ token: 'ready', text: 'Ready', elements: [{ ref: 'a', role: 'button', name: 'Go' }] }),
    snapshot({ token: 'loading', text: 'Loading result' }),
    snapshot({ token: 'done', text: 'Done' }),
  ]);
  const result = await new WorkflowSession({ batch, conditionWaitMs: 100 }).run(plan([
    stage({ textIncludes: 'Ready' }, [click('Go', { textIncludes: 'Loading result' })]),
  ]));
  assert.equal(result.status, 'completed');
  assert.equal(batch.runCalls.length, 1);
  assert.deepEqual(batch.observeCalls, [
    { reuseVerified: false }, { reuseVerified: true }, { reuseVerified: false },
  ]);
});
