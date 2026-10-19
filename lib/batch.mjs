// Guarded, zero-model form batches over the persistent browserctrl connection.
import * as defaultOps from './ops.mjs';
import { saysCommit } from './commit.mjs';

const RISKY = /\b(send|submit|post|publish|pay|purchase|buy|book|reserve|delete|remove|reset|password|transfer|checkout|place order|save|confirm|approve|accept|agree|sign|login|log in|logout|log out|upload|download|unsubscribe)\b/i;
const MAX_CONDITION_MS = 2000;

function identityExpression(token, ref = null) {
  return `(() => {
    const state = window.__cdp;
    if (!state || state.token !== ${JSON.stringify(token)} || state.url !== location.href) return null;
    const ids = window.__cdpBatchIds ||= { next: 1, map: new WeakMap() };
    const roleOf = el => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return 'select';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (['checkbox','radio','file','submit','button'].includes(type)) return type;
        return 'textbox';
      }
      if (el.isContentEditable) return 'textbox';
      return tag;
    };
    const nameOf = el => {
      let text = (el.getAttribute('aria-label') || '').trim();
      if (text) return text;
      const labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) {
        const parts = labelledby.split(/\\s+/).map(id => {
          const node = document.getElementById(id);
          return node ? (node.innerText || node.textContent || '').trim() : '';
        }).filter(Boolean);
        if (parts.length) return parts.join(' ');
      }
      if (el.id) {
        const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (label) {
          text = (label.innerText || label.textContent || '').trim();
          if (text) return text;
        }
      }
      const enclosing = el.closest('label');
      if (enclosing && enclosing !== el) {
        const wrapped = (enclosing.innerText || enclosing.textContent || '').trim().replace(/\\s+/g, ' ');
        if (wrapped) return wrapped;
      }
      const own = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
      if (own) return own.slice(0, 120);
      const type = (el.getAttribute('type') || '').toLowerCase();
      const fallback = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
        el.getAttribute('name') || (['password','file','hidden'].includes(type) ? '' : el.value) || '';
      return String(fallback).trim().slice(0, 120);
    };
    const inspect = el => {
      if (!el || !el.isConnected) return null;
      let id = ids.map.get(el);
      if (!id) { id = ids.next++; ids.map.set(el, id); }
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const hit = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementFromPoint(x, y) : null;
      const inputType = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : null;
      return {
        nodeId: id,
        role: roleOf(el),
        name: nameOf(el),
        tag: el.tagName.toLowerCase(),
        inputType,
        value: ['password','file','hidden'].includes(inputType) ? null : String(el.value ?? ''),
        disabled: el.matches(':disabled') || !!el.closest('[aria-disabled="true"]'),
        readonly: !!el.readOnly || el.getAttribute('aria-readonly') === 'true',
        inert: !!el.closest('[inert]'),
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' &&
          parseFloat(style.opacity || '1') > 0.05 && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
        hittable: !!hit && el.contains(hit),
        options: el.tagName === 'SELECT' ? [...el.options].map(option => ({
          value: option.value,
          label: option.text.trim(),
          disabled: option.disabled || !!option.closest('optgroup[disabled]')
        })) : null,
        href: el.tagName === 'A' ? el.href : null,
        url: location.href
      };
    };
    ${ref === null
      ? 'return state.els.map(inspect);'
      : `const index = Number(${JSON.stringify(ref)}.replace('ref_', '')) - 1; return inspect(state.els[index]);`}
  })()`;
}

function exactOrigin(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

function validateAfter(after) {
  if (!after || typeof after !== 'object' || Array.isArray(after)) return false;
  const keys = Object.keys(after);
  return keys.length === 1 && (
    (keys[0] === 'textIncludes' && typeof after.textIncludes === 'string' && after.textIncludes.length > 0) ||
    (keys[0] === 'urlEquals' && typeof after.urlEquals === 'string' && exactOrigin(after.urlEquals))
  );
}

function publicElement(element) {
  const out = {};
  for (const key of ['ref', 'role', 'name', 'tag', 'inputType', 'testid', 'disabled', 'checked', 'expanded', 'href']) {
    if (element[key] !== undefined) out[key] = element[key];
  }
  if (element.value !== undefined && !['password', 'file', 'hidden'].includes(element.inputType)) {
    out.value = String(element.value).slice(0, 256);
  }
  return out;
}

function terminal(status, reason, telemetry, uncertain = false, startedAt = Date.now()) {
  return {
    status,
    reason,
    uncertain,
    steps: telemetry,
    metrics: {
      model_calls: 0,
      api_cost_usd: 0,
      actions_attempted: telemetry.filter(row => row.attempted).length,
      wall_ms: Date.now() - startedAt,
    },
  };
}

export class BatchSession {
  constructor(conn, target, { origin, maxSteps = 12, maxMs = 15000, adapter = defaultOps } = {}) {
    if (!conn || !target) throw new Error('BatchSession needs a connection and target');
    if (!exactOrigin(origin)) throw new Error('BatchSession needs an exact HTTP(S) origin');
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 60) throw new Error('maxSteps must be 1..60');
    if (!Number.isInteger(maxMs) || maxMs < 1 || maxMs > 60000) throw new Error('maxMs must be 1..60000');
    this.conn = conn;
    this.target = target;
    this.origin = exactOrigin(origin);
    this.maxSteps = maxSteps;
    this.maxMs = maxMs;
    this.ops = adapter;
    this.observations = new Map();
    this.consumed = new Set();
  }

  async observe({ reuseVerified = false } = {}) {
    const cached = reuseVerified ? this.verifiedPage : null;
    this.verifiedPage = null;
    const page = cached || await this.ops.readPage(this.conn, this.target, { maxText: 12000, max: 400, all: true });
    if (exactOrigin(page.url) !== this.origin) throw new Error('Page left the batch origin');
    const identities = await this.ops.evaluate(this.conn, this.target, identityExpression(page.token));
    if (!Array.isArray(identities) || identities.length !== page.elements.length || identities.some(item => !item)) {
      if (cached) return this.observe(); // Stale cached observation: read again, never replay input.
      throw new Error('Could not establish stable batch element identities');
    }
    const elements = page.elements.map((element, index) => ({
      ...element,
      nodeId: identities[index].nodeId,
      role: identities[index].role,
      name: identities[index].name,
      tag: identities[index].tag,
      inputType: identities[index].inputType,
      href: identities[index].href,
      value: identities[index].value ?? undefined,
    }));
    const baseline = new Map(elements.map((element, index) => [element.ref, {
      ref: element.ref,
      ...identities[index],
    }]));
    this.observations.clear();
    this.observations.set(page.token, { url: page.url, baseline });
    return {
      token: page.token,
      url: page.url,
      title: page.title,
      text: page.text.slice(0, 4000),
      elements: elements.map(publicElement),
    };
  }

  async #live(ref) {
    return this.ops.evaluate(this.conn, this.target, identityExpression(this.activeToken, ref));
  }

  async #poll(after, deadline) {
    const until = Math.min(deadline, Date.now() + MAX_CONDITION_MS);
    while (Date.now() <= until) {
      const page = await this.ops.readPage(this.conn, this.target, { maxText: 12000, max: 400, all: true });
      if (exactOrigin(page.url) !== this.origin) return { ok: false, reason: 'Page left the batch origin' };
      if (after.urlEquals !== undefined && page.url === after.urlEquals) { this.verifiedPage = page; return { ok: true }; }
      if (after.textIncludes !== undefined && page.text.includes(after.textIncludes)) { this.verifiedPage = page; return { ok: true }; }
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, until - Date.now()))));
    }
    return { ok: false, reason: 'Click postcondition was not observed within 2000ms' };
  }

  async #conditionMet(after) {
    return this.ops.evaluate(
      this.conn,
      this.target,
      after.urlEquals !== undefined
        ? `location.href === ${JSON.stringify(after.urlEquals)}`
        : `(document.body?.innerText || '').includes(${JSON.stringify(after.textIncludes)})`,
    );
  }

  async run({ token, steps } = {}) {
    const runStarted = Date.now();
    this.verifiedPage = null;
    const finish = (status, reason, telemetry, uncertain = false) =>
      terminal(status, reason, telemetry, uncertain, runStarted);
    if (this.consumed.has(token)) return finish('needs_review', 'Observation token was already consumed; no replay', []);
    if (typeof token !== 'string' || !this.observations.has(token)) {
      return finish('needs_review', 'Unknown observation token; observe again', []);
    }
    this.consumed.add(token);
    if (this.consumed.size > 256) this.consumed.delete(this.consumed.values().next().value);
    const observation = this.observations.get(token);
    this.observations.delete(token);
    this.activeToken = token;
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > this.maxSteps) {
      return finish('needs_review', `steps must contain 1..${this.maxSteps} actions`, []);
    }
    const telemetry = [];
    const deadline = Date.now() + this.maxMs;

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const started = Date.now();
      const row = { index, kind: step?.kind, ref: step?.ref, status: 'guarding', started_ms: started };
      telemetry.push(row);
      const fail = (status, reason, uncertain = false) => {
        row.status = status;
        row.duration_ms = Date.now() - started;
        row.reason = reason;
        return finish(status === 'uncertain' ? 'failed' : 'needs_review', reason, telemetry, uncertain);
      };
      if (Date.now() >= deadline) return fail('blocked', 'Batch time budget reached before action');
      if (!step || !['fill', 'select', 'click'].includes(step.kind) || typeof step.ref !== 'string') {
        return fail('blocked', 'Each step needs kind fill/select/click and an observed ref');
      }
      if (step.kind === 'click' && index !== steps.length - 1) {
        return fail('blocked', 'A click must be the final batch boundary; observe before planning new controls');
      }
      if (step.kind === 'click' && !validateAfter(step.after)) {
        return fail('blocked', 'Click needs exactly one explicit postcondition: textIncludes or urlEquals');
      }
      if (step.kind === 'click' && step.after.urlEquals && exactOrigin(step.after.urlEquals) !== this.origin) {
        return fail('blocked', 'Click postcondition leaves the batch origin');
      }
      const baseline = observation.baseline.get(step.ref);
      if (!baseline) return fail('blocked', 'Step ref was not in the original observation');
      // Its own stricter English list, plus the commit words in other languages (lib/commit.mjs).
      if (RISKY.test(baseline.name) || saysCommit(baseline.name)) return fail('blocked', 'Potentially consequential control requires review');
      if (['password', 'file', 'hidden'].includes(baseline.inputType)) {
        return fail('blocked', 'Sensitive or file controls are outside guarded batches');
      }
      if (exactOrigin(observation.url) !== this.origin) return fail('blocked', 'Original observation was outside origin');
      const live = await this.#live(step.ref).catch(() => null);
      if (!live || exactOrigin(live.url) !== this.origin) return fail('blocked', 'Target detached or page changed; observe again');
      if (
        live.nodeId !== baseline.nodeId || live.role !== baseline.role || live.name !== baseline.name ||
        live.inputType !== baseline.inputType || live.href !== baseline.href ||
        live.disabled || live.inert || !live.visible
      ) {
        return fail('blocked', 'Target identity or state changed; observe again');
      }
      if (live.value !== null && live.value !== baseline.value) {
        return fail('blocked', 'Target value changed since observation; observe again');
      }
      if (['password', 'file', 'hidden'].includes(live.inputType)) {
        return fail('blocked', 'Sensitive or file controls are outside guarded batches');
      }

      if (step.kind === 'fill' && typeof step.value !== 'string') return fail('blocked', 'Fill value must be a string');
      if (
        step.kind === 'fill' &&
        (live.tag === 'input'
          ? !['text', 'email', 'url', 'tel', 'number', 'search'].includes(live.inputType)
          : live.tag !== 'textarea')
      ) {
        return fail('blocked', 'Fill target is not an editable text control');
      }
      if (step.kind === 'fill' && live.readonly) return fail('blocked', 'Fill target is read-only');
      if (step.kind === 'select' && typeof step.value !== 'string' && typeof step.label !== 'string') {
        return fail('blocked', 'Select needs a string value or label');
      }
      if (step.kind === 'select') {
        if ((step.value !== undefined) === (step.label !== undefined)) {
          return fail('blocked', 'Select needs exactly one value or label');
        }
        if (live.tag !== 'select') return fail('blocked', 'Select target is not a native select');
        const option = live.options?.find(item =>
          (step.value !== undefined && item.value === step.value) || (step.label !== undefined && item.label === step.label));
        if (!option || option.disabled) return fail('blocked', 'Select option is missing or disabled');
      }
      if (step.kind === 'click') {
        if (live.role === 'link' && (!live.href || exactOrigin(live.href) !== this.origin)) {
          return fail('blocked', 'Link leaves the batch origin');
        }
        if (!live.hittable) return fail('blocked', 'Click target is covered or outside the viewport');
        if (await this.#conditionMet(step.after)) {
          return fail('blocked', 'Click postcondition was already true; action was not executed');
        }
      }
      row.status = 'attempted';
      row.attempted = true;
      try {
        if (step.kind === 'fill') {
          await this.ops.fill(this.conn, this.target, { ref: step.ref, value: step.value, token });
          const after = await this.#live(step.ref);
          if (!after || after.value !== step.value) return fail('blocked', 'Filled value was not confirmed');
          baseline.value = step.value;
        } else if (step.kind === 'select') {
          const selected = await this.ops.selectOption(this.conn, this.target, {
            ref: step.ref, value: step.value, label: step.label, token,
          });
          const expected = step.value ?? selected?.value;
          const after = await this.#live(step.ref);
          if (!after || after.value !== expected) return fail('blocked', 'Selected value was not confirmed');
          baseline.value = expected;
        } else {
          await this.ops.click(this.conn, this.target, { ref: step.ref, token });
          const postcondition = await this.#poll(step.after, deadline);
          if (!postcondition.ok) return fail('blocked', postcondition.reason);
        }
      } catch (error) {
        return fail(
          'uncertain',
          'Mutation did not return a confirmed result. Its outcome is uncertain; it was not replayed. Observe before continuing.',
          true,
        );
      }
      row.status = 'completed';
      row.duration_ms = Date.now() - started;
      row.postcondition = step.kind === 'click' ? Object.keys(step.after)[0] : 'value';
    }
    return finish('completed', 'All guarded steps and postconditions passed', telemetry);
  }
}
