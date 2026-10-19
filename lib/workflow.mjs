// Data-only, bounded stages: host plans; local guards execute; Jev is opt-in.
const targetKeys = new Set(['role', 'name', 'testid', 'href']);
const validTarget = target => target && typeof target === 'object' && !Array.isArray(target) &&
  Object.keys(target).length > 0 && Object.entries(target).every(([k, v]) => targetKeys.has(k) && typeof v === 'string' && v.length > 0);
const specific = target => target.name !== undefined || target.testid !== undefined || target.href !== undefined;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const matching = (snapshot, target) => snapshot.elements.filter(el =>
  Object.entries(target).every(([key, value]) => el[key] === value));

export function validCondition(condition, depth = 0) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition) || depth > 3) return false;
  const keys = Object.keys(condition);
  if (keys.length !== 1) return false;
  if (keys[0] === 'all') return Array.isArray(condition.all) && condition.all.length > 0 && condition.all.length <= 12 && condition.all.every(c => validCondition(c, depth + 1));
  if (keys[0] === 'fieldEquals') return validTarget(condition.fieldEquals?.target) && specific(condition.fieldEquals.target) && typeof condition.fieldEquals.value === 'string';
  return ['textIncludes', 'urlEquals'].includes(keys[0]) && typeof condition[keys[0]] === 'string' && condition[keys[0]].length > 0;
}
export function conditionMet(snapshot, condition) {
  if (condition.all) return condition.all.every(c => conditionMet(snapshot, c));
  if (condition.fieldEquals) {
    const els = matching(snapshot, condition.fieldEquals.target);
    return els.length === 1 && els[0].value === condition.fieldEquals.value;
  }
  if (condition.urlEquals) return snapshot.url === condition.urlEquals;
  return snapshot.text.includes(condition.textIncludes);
}
function safeSnapshot(snapshot) {
  if (!snapshot) return null;
  // No field values in the default recovery/report packet. Page text may still be private.
  return { url: snapshot.url, title: snapshot.title, text: snapshot.text,
    elements: snapshot.elements.map(({ value, ...element }) => element) };
}
function category(reason) {
  if (/budget/i.test(reason)) return 'budget';
  if (/ambiguous|unique/i.test(reason)) return 'ambiguous_target';
  if (/consequential|confirmation/i.test(reason)) return 'authorization_boundary';
  if (/uncertain|transport/i.test(reason)) return 'delivery_uncertain';
  if (/identity|state changed|stale|detached/i.test(reason)) return 'stale_state';
  if (/covered|viewport/i.test(reason)) return 'visibility';
  if (/condition|expected|outcome/i.test(reason)) return 'verification';
  if (/not found|no .*target|no suitable/i.test(reason)) return 'missing_target';
  return 'execution';
}

export class WorkflowSession {
  constructor({ batch, select = null, maxStages = 12, maxActions = 40, maxMs = 30000,
    maxModelRequests = 4, conditionWaitMs = 2000, captureFailure = null } = {}) {
    if (!batch?.observe || !batch?.run) throw new Error('Workflow needs a guarded BatchSession');
    for (const [key, value, max] of [['maxStages', maxStages, 30], ['maxActions', maxActions, 100], ['maxMs', maxMs, 120000], ['maxModelRequests', maxModelRequests, 20]]) {
      if (!Number.isInteger(value) || value < (key === 'maxModelRequests' ? 0 : 1) || value > max) throw new Error(`Invalid ${key}`);
    }
    if (!Number.isInteger(conditionWaitMs) || conditionWaitMs < 0 || conditionWaitMs > 2000) throw new Error('Invalid conditionWaitMs');
    Object.assign(this, { batch, select, maxStages, maxActions, maxMs, maxModelRequests, conditionWaitMs, captureFailure });
    this.busy = false;
  }

  async run(plan) {
    if (this.busy) throw new Error('Workflow session already in use');
    this.#validate(plan); // Validate the entire data-only plan before dispatching any action.
    this.busy = true;
    const started = performance.now();
    const deadline = started + this.maxMs;
    const report = { status: 'running', stages: [], metrics: { selector_attempts: 0, model_calls: 0, input_tokens: 0, output_tokens: 0,
      token_usage_complete: true, api_cost_usd: 0, observation_ms: 0, selection_ms: 0, execution_ms: 0, actions_attempted: 0 } };
    let snapshot;
    const observe = async reuseVerified => {
      const start = performance.now();
      try { return await this.batch.observe({ reuseVerified }); }
      finally { report.metrics.observation_ms += performance.now() - start; }
    };
    const budget = () => { if (performance.now() >= deadline) throw new Error('Workflow time budget exhausted'); };
    const account = usage => {
      const actualRequests = Number.isInteger(usage?.requests) && usage.requests >= 0 ? usage.requests : null;
      if (actualRequests === null) {
        report.metrics.token_usage_complete = false;
        report.metrics.api_cost_usd = null;
        return;
      }
      report.metrics.model_calls += actualRequests;
      if (actualRequests > 0) report.metrics.api_cost_usd = null; // Provider billing is not inferred.
      if (usage?.input_tokens == null || usage?.output_tokens == null) report.metrics.token_usage_complete = false;
      report.metrics.input_tokens += usage?.input_tokens ?? 0;
      report.metrics.output_tokens += usage?.output_tokens ?? 0;
    };
    const waitForCondition = async condition => {
      if (conditionMet(snapshot, condition)) return true;
      const until = Math.min(deadline, performance.now() + this.conditionWaitMs);
      while (performance.now() < until) {
        await sleep(Math.min(50, Math.max(1, until - performance.now())));
        budget();
        snapshot = await observe(false);
        if (conditionMet(snapshot, condition)) return true;
      }
      return false;
    };
    try {
      snapshot = await observe(false);
      for (let index = 0; index < plan.stages.length; index++) {
        budget();
        const stage = plan.stages[index];
        const row = { index, status: 'resolving', steps: [] };
        report.stages.push(row);
        if (!await waitForCondition(stage.expect)) throw new Error('Expected stage precondition was not observed');
        const steps = [];
        for (const action of stage.actions) {
          let candidates = matching(snapshot, action.target);
          let element;
          if (action.semantic) {
            candidates = candidates.filter(el => !el.disabled);
            if (!candidates.length) throw new Error('No eligible semantic target');
            if (!this.select) throw new Error('Semantic target needs an explicitly configured selector');
            if (report.metrics.selector_attempts >= this.maxModelRequests) throw new Error('Workflow model request budget exhausted');
            budget();
            const start = performance.now();
            report.metrics.selector_attempts++;
            let answer;
            try {
              answer = await this.select({ snapshot, candidates, goal: plan.goal, subgoal: action.semantic });
            } catch (error) {
              if (error.usage) account(error.usage);
              else account(null);
              throw error;
            } finally { report.metrics.selection_ms += performance.now() - start; }
            account(answer.usage);
            element = candidates.find(el => el.ref === answer.ref);
            if (!element) throw new Error('No suitable observed target selected');
          } else {
            if (candidates.length !== 1) throw new Error(candidates.length ? 'Ambiguous target; exact match is not unique' : 'Exact target not found');
            [element] = candidates;
          }
          const { target, semantic, ...step } = action;
          steps.push({ ...step, ref: element.ref });
        }
        budget();
        const priorMax = this.batch.maxMs;
        this.batch.maxMs = Math.max(1, Math.min(priorMax, Math.floor(deadline - performance.now())));
        const start = performance.now();
        let outcome;
        try { outcome = await this.batch.run({ token: snapshot.token, steps }); }
        finally { this.batch.maxMs = priorMax; report.metrics.execution_ms += performance.now() - start; }
        row.steps = outcome.steps;
        row.status = outcome.status;
        report.metrics.actions_attempted += outcome.metrics.actions_attempted;
        report.uncertain = Boolean(outcome.uncertain);
        if (outcome.status !== 'completed') throw new Error(outcome.reason);
        // The final click's successful poll is reused, with current ref identity checks.
        snapshot = await observe(true);
      }
      budget();
      if (!await waitForCondition(plan.success)) throw new Error('Final workflow outcome was not observed');
      report.status = 'completed';
      report.evidence = { url: snapshot.url, title: snapshot.title, condition: plan.success };
    } catch (error) {
      report.status = 'needs_review';
      report.reason = error.message;
      const row = report.stages.at(-1);
      if (row?.status === 'resolving') row.status = 'not_dispatched';
      // One evidence refresh only. Never repeat a mutation while recovering.
      let current = null;
      try { current = await observe(false); } catch { /* Page may be unreachable/outside scope. */ }
      report.recovery = { category: category(report.reason), replayed: false,
        current: safeSnapshot(current), previous_url: snapshot?.url ?? null,
        next_stage: report.stages.at(-1)?.index ?? 0 };
      if (this.captureFailure) {
        try { report.recovery.screenshot = await this.captureFailure(); }
        catch { report.recovery.screenshot_error = 'Screenshot unavailable'; }
      }
    } finally {
      report.metrics.wall_ms = performance.now() - started;
      this.busy = false;
    }
    return report;
  }

  #validate(plan) {
    if (!plan || typeof plan.goal !== 'string' || !plan.goal || !Array.isArray(plan.stages) ||
      !plan.stages.length || plan.stages.length > this.maxStages || !validCondition(plan.success)) throw new Error('Provide goal, bounded stages and explicit success condition');
    let count = 0;
    for (const stage of plan.stages) {
      if (!validCondition(stage.expect) || !Array.isArray(stage.actions) || !stage.actions.length || stage.actions.length > this.batch.maxSteps) throw new Error('Every stage needs an expected state and bounded actions');
      for (const [i, action] of stage.actions.entries()) {
        count++;
        if (!action || !['fill', 'select', 'click'].includes(action.kind) || !validTarget(action.target) ||
          (!action.semantic && !specific(action.target)) ||
          (action.semantic !== undefined && (typeof action.semantic !== 'string' || !action.semantic)) ||
          Object.keys(action).some(k => !['kind', 'target', 'semantic', 'value', 'label', 'after'].includes(k))) throw new Error('Use supported actions and exact targets or explicit semantic selection');
        if (action.kind === 'fill' && typeof action.value !== 'string') throw new Error('Fill needs prepared text');
        if (action.kind === 'select' && ((typeof action.value === 'string') === (typeof action.label === 'string'))) throw new Error('Select needs one value or label');
        if (action.kind === 'click' && (i !== stage.actions.length - 1 || !validCondition(action.after) ||
          (!action.after.textIncludes && !action.after.urlEquals))) throw new Error('Click must end a stage and have a URL/text postcondition');
      }
    }
    if (count > this.maxActions) throw new Error('Workflow action budget exceeded');
  }
}
