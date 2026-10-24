// Independent form inputs share a grounding request, but retain each input's normal
// settle and outcome barriers. Pins belong to one observed DOM, never to its redraw.
import * as ops from '../ops.mjs';
import * as jev from '../jev.mjs';
import { helperSource } from '../page/index.mjs';
import { exactMatch, findDirect, unsupportedName } from './ground.mjs';
import { askJev } from './perform.mjs';
import { blockerQuestion } from './overlays.mjs';
import { AGAIN, prob, pinKey } from './context.mjs';

function guardScript(args) {
  return `(() => { ${helperSource('elementInfo')} return (${formGuard.toString()})(${JSON.stringify(args)}); })()`;
}

// Stored element and form objects detect replacement even when a page copies pin attrs.
function formGuard({ key, selectors, check }) {
  const states = window.__bcSamePage ||= {};
  const validation = form => JSON.stringify([...form.elements].map(el => [el.name, el.willValidate, el.validity?.valid, el.validationMessage]));
  if (check) {
    const s = states[key];
    if (!s || s.url !== location.href) return { changed: true };
    if (s.validation !== validation(s.form)) s.changed = true;
    const e = s.elements[check.index], el = document.querySelector(e.selector);
    const info = el && elementInfo(el);
    const visible = el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const valid = el === e.el && el.form === e.form && info.role === e.role && info.name === e.name && visible && !el.disabled && !el.readOnly && !el.closest('[inert]');
    return { blocked: [...document.querySelectorAll('dialog[open], [aria-modal="true"]')].some(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && (r => r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight)(e.getBoundingClientRect())), changed: s.changed, valid: Boolean(valid), dependent: Boolean(el && el.value !== e.value) };
  }
  for (const [oldKey, s] of Object.entries(states)) { s.observer?.disconnect(); s.form?.removeEventListener('invalid', s.onInvalid, true); delete states[oldKey]; }
  const elements = selectors.map(selector => {
    const el = document.querySelector(selector), info = el && elementInfo(el);
    return { selector, el, form: el?.form, role: info?.role, name: info?.name, value: el?.value };
  });
  if (elements.some(e => !e.el || !e.form || !/^(textbox|searchbox|spinbutton)$/.test(e.role) || !e.el.matches('input,textarea') || e.el.disabled || e.el.readOnly || e.el.getAttribute('aria-controls') || e.el.getAttribute('list') || e.el.closest('[role=combobox]'))) return { error: 'Same page requires independent native fills on a stable form' };
  if (new Set(elements.map(e => e.el)).size !== elements.length || elements.some(e => e.form !== elements[0].form)) return { error: 'Same page fills must name distinct fields in one form' };
  const form = elements[0].form;
  const s = states[key] = { elements, form, validation: validation(form), url: location.href, changed: false };
  s.onInvalid = () => { s.changed = true; };
  form.addEventListener('invalid', s.onInvalid, true);
  s.observer = new MutationObserver(ms => { if (ms.some(m => m.type !== 'attributes' || !['data-bc-pin', 'value'].includes(m.attributeName))) s.changed = true; });
  s.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  return { ok: true };
}

export async function samePage(ctx, node, row, { runOne, drain }) {
  const stop = (reason, step = node.path) => ({ stop: { step, reason } });
  if (!node.body.length || node.body.some(s => s.action !== 'fill' || s.expect || s.commit || s.optional || s.targetRef)) return stop('Same page allows only independent fills without dependent checks');
  if (ctx.pending && !ctx.hasJevKey()) return stop('Same page requires the pending expectation to be checked before input');
  let next = 0, batch;
  row.same_page = { requested: node.body.length, completed: 0, regrounds: 0 };
  try {
    while (next < node.body.length) {
      if (Date.now() >= ctx.deadline) return stop('Run deadline reached');
      if (!batch) {
        ctx.view = await ctx.look();
        if (ctx.view.overlay?.trim()) return stop('A blocking overlay prevents same-page fills');
        const snap = await ctx.readPage(), parts = [], questions = {};
        for (let i = next; i < node.body.length; i++) {
          const step = node.body[i];
          const direct = await findDirect(ctx, step, snap);
          if (direct?.stop) return direct;
          const el = direct?.el || exactMatch(snap, step);
          const tq = el ? null : jev.targetQuestion(snap, { intent: step.target, action: 'fill' });
          if (!el && !tq?.question) return stop('Same page field unavailable or dependent', step.path);
          if (tq) questions[`target.${i + 1}`] = tq.question;
          parts.push({ step, el, tq, index: i });
        }
        if (Object.keys(questions).length || ctx.pending) questions.blocker = blockerQuestion();
        const asked = await askJev(ctx, node.body[next], row, { snap }, { extra: questions, inNote: true });
        if (asked === AGAIN) return stop('Page changed during same-page grounding');
        if (asked.result) return asked.result;
        if (prob(asked.answers.blocker) >= .5) return stop('A blocking overlay prevents same-page fills');
        for (const part of parts) {
          if (!part.el) {
            const pick = jev.readTarget(asked.answers[`target.${part.index + 1}`], part.tq.cands);
            const why = jev.refusal(pick, ctx.minP, ctx.commitCtx(snap)) || await unsupportedName(ctx, part.step.target, pick);
            if (why) return stop(why, part.step.path);
            part.el = pick.pick;
            part.how = `jev p=${pick.p}`;
            part.unsure = pick.p < .75;
          }
          part.selector = await ctx.pin(part.el);
          if (!part.selector) return stop('Same page field could not be pinned', part.step.path);
        }
        const key = pinKey();
        const pinned = await ops.evaluate(ctx.conn, ctx.tab, guardScript({ key, selectors: parts.map(p => p.selector) }));
        if (pinned.error) return stop(pinned.error);
        batch = { key, parts, offset: next };
      }
      const part = batch.parts[next - batch.offset];
      const check = await ops.evaluate(ctx.conn, ctx.tab, guardScript({ key: batch.key, check: { index: next - batch.offset } }));
      if (check.blocked) return stop('A new dialog or overlay interrupted same-page fills', part.step.path);
      if (check.dependent) return stop('Same page field depends on an earlier input', part.step.path);
      if (check.changed || !check.valid) {
        // No action has been sent for this field. Completed fields never re-enter a batch.
        if (batch.offset === next) return stop('Same page field identity, role, visibility or form changed', part.step.path);
        row.same_page.regrounds++;
        batch = null;
        continue;
      }
      const child = { step: part.step.path, path: part.step.path, do: part.step.source, same_page: node.path };
      const result = await runOne(ctx, { ...part.step, ref: null, pin: null, item: null, selector: part.selector }, child, {
        noInputRecovery: true,
        inNote: true,
        pregrounded: { el: { ...part.el, ref: null, selector: part.selector }, snap: null },
        beforeInput: async () => {
          const fresh = await ops.evaluate(ctx.conn, ctx.tab, guardScript({ key: batch.key, check: { index: next - batch.offset } }));
          if (fresh.blocked) throw new Error('A new dialog or overlay interrupted same-page fills');
          if (fresh.dependent) throw new Error('Same page field depends on an earlier input');
          if (fresh.changed || !fresh.valid) {
            const error = new Error('Same page field changed before input');
            error.code = 'same_page_stale';
            throw error;
          }
        },
      });
      if (result.stop?.code === 'same_page_stale') {
        row.same_page.regrounds++;
        batch = null;
        continue;
      }
      child.how = part.how || 'exact';
      if (part.unsure) child.unsure = true;
      ctx.report.steps.push(child);
      if (result.stop) { child.stopped = true; return result; }
      next++;
      row.same_page.completed++;
      if (ctx.view.overlay?.trim()) return stop('A new dialog or overlay interrupted same-page fills', node.body[next]?.path || part.step.path);
    }
    const stopped = await drain(ctx);
    return stopped ? { stop: stopped } : {};
  } catch (e) { return stop(e.message, node.body[next]?.path); }
  finally {
    await ops.evaluate(ctx.conn, ctx.tab, `(() => { const states = window.__bcSamePage || {}; for (const key of Object.keys(states)) { states[key].observer?.disconnect(); states[key].form?.removeEventListener('invalid', states[key].onInvalid, true); delete states[key]; } })()`).catch(() => {});
  }
}
