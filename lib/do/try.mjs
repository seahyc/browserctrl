// Bounded search owns its checks and temporary tabs; ordinary step recovery never
// gets to reinterpret a failed result as permission to repeat an input.
import * as ops from '../ops.mjs';
import * as jev from '../jev.mjs';
import * as cooldown from '../cooldown.mjs';
import { pickQuestion, conditionQuestion, readCandidateDistribution } from '../judge.mjs';
import { askJev } from './perform.mjs';
import { freezeList } from './listing.mjs';
import { saysCommit } from '../commit.mjs';
import { committing } from './commit.mjs';
import { missingFromPick } from './ground.mjs';
import { expectQuestion, noul, AGAIN } from './context.mjs';

const identity = c => JSON.stringify([c.text || c.name, c.link || c.href || '', c.role || 'link']);
const stop = (reason, step) => ({ stop: { reason, step } });
const validP = p => Number.isFinite(p) && p >= 0 && p <= 1;

async function observed(ctx, step) {
  if (step.action === 'pick') {
    const list = await freezeList(ctx);
    return { candidates: list.items, key: 'pick', question: pickQuestion(step.target, list.items) };
  }
  const snap = await ctx.readPage();
  const target = jev.targetQuestion(snap, { intent: step.target, action: 'click' });
  return { candidates: target.cands, snap, key: 'target', question: target.question };
}

// Only ARIA tabs with one explicit selected state have an exact inverse in v1.
async function tabState(ctx, selector) {
  return ops.evaluate(ctx.conn, ctx.tab, `(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    const group = e?.closest('[role="tablist"]');
    if (!e || e.getAttribute('role') !== 'tab' || !group) return null;
    const tabs = [...group.querySelectorAll('[role="tab"]')];
    if (tabs.filter(t => t.getAttribute('aria-selected') === 'true').length !== 1 || tabs.some(t => !['true','false'].includes(t.getAttribute('aria-selected')))) return null;
    if (tabs.some(t => !t.id || !t.getAttribute('aria-controls') || !document.getElementById(t.getAttribute('aria-controls')))) return null;
    return tabs.map(t => ({id:t.id, name:t.textContent.trim(), selected:t.getAttribute('aria-selected'), controls:t.getAttribute('aria-controls'), panel:document.getElementById(t.getAttribute('aria-controls')).textContent, fields:[...document.getElementById(t.getAttribute('aria-controls')).querySelectorAll('input,select,textarea')].map(f=>({name:f.name,value:f.value,checked:f.checked,disabled:f.disabled})), hidden:document.getElementById(t.getAttribute('aria-controls')).hidden}));
  })()`);
}
const selectedSelector = state => `[id=${JSON.stringify(state.find(t => t.selected === 'true').id)}]`;

async function dialogOpen(ctx) {
  return ops.evaluate(ctx.conn, ctx.tab, `Boolean([...document.querySelectorAll('dialog[open], [aria-modal="true"]')].some(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'))`);
}

async function check(ctx, row, expected, key = 'prev_expect') {
  if (await dialogOpen(ctx)) throw new Error('A dialog interrupted candidate search');
  const questions = {
    [key]: expectQuestion(expected),
    ...Object.fromEntries(Object.entries(jev.CHECKS).map(([id,q]) => [id,noul(q)])),
    blocker: conditionQuestion('a dialog or blocking overlay prevents continuing'),
  };
  const response = await ctx.ask({ page: jev.viewState(ctx.view), next_step: row.do }, questions);
  row.jev_ms = (row.jev_ms || 0) + response.ms;
  for (const flag of [...Object.keys(jev.CHECKS), 'blocker']) {
    const p = response.answers[flag]?.noul;
    if (!validP(p) || p >= .5) throw new Error(`Candidate check stopped: ${flag}`);
  }
  const p = response.answers[key]?.noul;
  if (!validP(p)) throw new Error('Candidate result check missing or invalid');
  return p;
}

export async function candidateSearch(ctx, node, row, { runOne }) {
  const step = node.attempt;
  const path = node.path || row.step;
  if (!step || !['pick', 'click'].includes(step.action) || !step.expect || step.commit || step.ref || step.item || step.selector || step.pin || !Number.isInteger(node.limit) || node.limit < 1 || node.limit > 3) return stop('Unsupported or unsafe candidate retry', path);
  const sourceTab = ctx.tab;
  const sourceState = { openedHere: ctx.openedHere, lastFilled: ctx.lastFilled, lastRow: ctx.lastRow, unverifiedSelection: ctx.unverifiedSelection };
  row.attempts = [];
  ctx.report.candidate_attempts ||= 0;
  try {
    if (await dialogOpen(ctx)) return stop('A dialog prevents candidate selection', path);
    const initial = await observed(ctx, step);
    if (!initial.question) return stop('No candidate targets found', path);
    const response = await askJev(ctx, node, row, {}, { extra: { [initial.key]: initial.question, ...Object.fromEntries(Object.entries(jev.CHECKS).map(([id, q]) => [id, noul(q)])), blocker: conditionQuestion('a dialog or blocking overlay prevents continuing') }, inNote: true });
    if (response === AGAIN) return stop('Source changed during candidate selection', path);
    if (response.result) return response.result;
    if (!validP(response.answers.blocker?.noul) || response.answers.blocker.noul >= .5) return stop('A blocking overlay prevents candidate selection', path);
    for (const flag of Object.keys(jev.CHECKS)) {
      const p = response.answers[flag]?.noul;
      if (!validP(p) || p >= .5) return stop(`Candidate selection stopped: ${flag}`, path);
    }
    const answer = response.answers[initial.key];
    const known = new Map(initial.candidates.map(c => [step.action === 'pick' ? c.id : c.ref, c]));
    const { distribution, ranked } = readCandidateDistribution(answer, initial.candidates);
    row.distribution = distribution;
    const seen = new Set();
    for (const [id, p] of ranked) {
      if (row.attempts.length >= node.limit) break;
      const candidate = known.get(id);
      const attemptPath = `${path}.attempt[${row.attempts.length + 1}]`;
      const entry = { step: attemptPath, path: attemptPath, do: row.do, candidate: candidate ? { ...candidate } : { id: 'none' }, p, restoration: null, check_p: null, rejection_reason: null };
      const reject = reason => { entry.rejection_reason = reason; return stop(reason, attemptPath); };
      if (id === 'none') { row.attempts.push(entry); (ctx.report.attempts ||= []).push(entry); return reject('Jev selected none in the frozen candidate distribution'); }
      if (seen.has(identity(candidate))) continue;
      seen.add(identity(candidate));
      row.attempts.push(entry);
      (ctx.report.attempts ||= []).push(entry);
      if (Date.now() >= ctx.deadline) return reject('Run deadline reached');
      if (p < ctx.minP) return reject('Candidate probability below minimum grounding threshold');
      const el = { ...candidate, name: candidate.name || candidate.text, role: candidate.role || 'link', href: candidate.href || candidate.link };
      if (candidate.submit || /\b(add|move|remove|update)\b.*\b(cart|bag|basket)\b/i.test(el.name) || saysCommit(el.name) || await committing(ctx, el, initial.snap, entry)) return reject('Candidate may commit; retries are forbidden');
      if (step.action === 'click' && missingFromPick(step.target, el).length) return reject('Candidate does not satisfy required literal checks');
      const link = candidate.link || candidate.href;
      let owned, selector, before;
      if (link) {
        if (el.role !== 'link') return reject('Only linked navigation and restorable tabs can be retried');
        if (/\b(?:cart|basket|checkout|delete|submit|purchase)\b|add[-_]?to[-_]?cart|send[-_]?message/i.test(link)) return reject('Candidate link may commit or change a cart; retries are forbidden');
        let url;
        try { url = new URL(link, ctx.view.url); } catch { return reject('Candidate has no safe detail link'); }
        if (!['http:', 'https:'].includes(url.protocol)) return reject('Candidate has no safe detail link');
        entry.url = url.href;
      } else {
        if (el.role !== 'tab') return reject('Unknown buttons and non-restorable controls cannot be retried');
        selector = await ctx.pin(el);
        before = selector && await tabState(ctx, selector);
        if (!before) return reject('The exact previous tab state cannot be captured');
      }
      let accepted = false;
      try {
        if (entry.url) {
          cooldown.guard(entry.url, { force: ctx.opts.force, action: 'open' });
          owned = (await ops.newTab(ctx.conn, 'about:blank')).targetId;
          (ctx.report.owned_tabs ||= []).push(owned);
          ctx.tab = owned;
          ctx.openedHere = [];
          ctx.lastFilled = null;
          ctx.view = await ctx.look();
        }
        const action = entry.url ? { action: 'nav', target: entry.url } : { action: 'click', target: step.target, selector };
        ctx.report.steps.push(entry);
        ctx.report.candidate_attempts = (ctx.report.candidate_attempts || 0) + 1;
        const result = await runOne(ctx, action, entry, {
          noInputRecovery: true, inNote: true,
          ...(selector ? { pregrounded: { el: { ...el, ref: null, selector }, snap: null }, beforeInput: async () => {
            if (JSON.stringify(await tabState(ctx, selector)) !== JSON.stringify(before)) throw new Error('Candidate tab state changed before input');
          } } : {}),
        });
        if (result.stop) return reject(result.stop.reason);
        const pCheck = await check(ctx, entry, step.expect);
        entry.check_p = entry.expect_p = pCheck;
        if (pCheck > .25 && pCheck < .75) return reject('Candidate result unresolved');
        accepted = pCheck >= .75;
        // A rejected attempt did not succeed: the report marks it skipped, not done.
        if (!accepted) entry.rejection_reason = entry.skipped = 'Expected result not shown';
        if (!accepted && before) {
          const restoreRow = { step: `${attemptPath}.restore`, do: 'restore previous tab state' };
          ctx.executedRows.add(restoreRow);
          const previous = before.find(t => t.selected === 'true');
          const restoreSelector = selectedSelector(before);
          const result = await runOne(ctx, { action: 'click', target: previous.name, selector: restoreSelector }, restoreRow, {
            noInputRecovery: true, inNote: true,
            pregrounded: { el: { role: 'tab', name: previous.name, selector: restoreSelector }, snap: null },
            beforeInput: async () => { if (!await tabState(ctx, restoreSelector)) throw new Error('Previous tab is no longer restorable'); },
          });
          if (result.stop) return reject(`Restoration failed: ${result.stop.reason}`);
          const restored = await tabState(ctx, selectedSelector(before));
          const restoreP = await check(ctx, entry, `the exact previous tab state is restored: ${JSON.stringify(before)}`, 'restore');
          entry.restoration = { verified: JSON.stringify(before) === JSON.stringify(restored) && restoreP >= .75, p: restoreP };
          if (!entry.restoration.verified) return reject('Restoration failed');
          const current = await observed(ctx, step);
          if (JSON.stringify(current.candidates.map(identity)) !== JSON.stringify(initial.candidates.map(identity))) return reject('Candidate identities changed after restoration');
          // Discard all old refs. Their identities and the frozen probabilities remain.
          for (const [key, value] of known) {
            const fresh = current.candidates.find(c => identity(c) === identity(value));
            if (fresh) known.set(key, fresh);
          }
        }
      } finally {
        if (owned && !accepted) {
          ctx.tab = sourceTab;
          Object.assign(ctx, sourceState);
          try { await ops.closeTab(ctx.conn, owned); ctx.report.owned_tabs = ctx.report.owned_tabs.filter(id => id !== owned); }
          catch (error) { throw new Error(`Could not close owned tab: ${error.message}`); }
          ctx.view = await ctx.look();
          const current = await observed(ctx, step);
          const unchanged = JSON.stringify(current.candidates.map(identity)) === JSON.stringify(initial.candidates.map(identity));
          entry.restoration = { verified: unchanged, method: 'source tab preserved; candidates re-read' };
          if (!unchanged) throw new Error('Candidate identities changed on the source page');
        }
      }
      if (accepted) { if (owned) entry.restoration = { verified: true, method: 'accepted owned detail retained' }; entry.accepted = true; row.accepted = entry.candidate; return {}; }
    }
    return stop('Candidate search exhausted', path);
  } catch (error) {
    const entry = row.attempts.at(-1);
    if (entry) entry.rejection_reason = error.message;
    return stop(error.message, entry?.path || path);
  }
}
