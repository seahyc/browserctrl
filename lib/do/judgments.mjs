// Steps that ask Jev about the page instead of finding a control, so a plan can carry a whole
// task in one call: `extract` copies the line that answers a question into the report, `pick`
// opens the list item that fits best, `if` runs its step only when the page shows something.
// Each question rides in the step's one Jev request (askJev in perform.mjs), next to the
// previous step's expectation; lib/judge.mjs builds the questions and reads the answers.
import * as ops from '../ops.mjs';
import { itemsExpression, mainGroup } from '../items.mjs';
import { spansOf, shortlistSpans, extractQuestion, readExtract, pickQuestion, readPick, conditionQuestion, parseExtractEvidence } from '../judge.mjs';
import { clip, prob } from './context.mjs';

const PAGE_TEXT = 100_000;
const MAX_ITEMS = 200;
const SURE = 0.75;
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
const AD = /(^|[\s·{,_-])(ad|ads|sponsored|promoted)([\s·},_-]|$)/i;

export const JUDGED = new Set(['extract', 'pick', 'if', 'branch']);

// The question for this step and what is needed to read its answer, or { stop }.
export async function judgment(ctx, step) {
  const { conn, tab } = ctx;
  if (step.action === 'if' || step.action === 'branch') return { key: 'cond', question: conditionQuestion(step.target) };
  if (step.action === 'extract') {
    // The whole page, not just the screen: an answer is often below the fold.
    const text = await ops.evaluate(conn, tab, `((document.body && document.body.innerText) || '').slice(0, ${PAGE_TEXT})`).catch(() => '');
    const all = spansOf(`${ctx.view?.overlay || ''}\n${text}`);
    if (step.fields) {
      const fields = {}, questions = {};
      for (const field of step.fields) {
        const spans = shortlistSpans(all, field.name);
        if (!spans.length) return { stop: { reason: 'The page has no text to extract from' } };
        put(fields, field.name, { spans });
        put(questions, `extract.${field.name}`, extractQuestion(field.name, spans));
      }
      return { fields, questions };
    }
    const spans = shortlistSpans(all, step.target);
    if (!spans.length) return { stop: { reason: 'The page has no text to extract from' } };
    return { key: 'extract', question: extractQuestion(step.target, spans), spans };
  }
  const r = await ops.evaluate(conn, tab, itemsExpression({})).catch(() => null);
  const main = r && mainGroup(r);
  const items = (main?.items || []).filter(it => it.text && !AD.test(it.text)).slice(0, MAX_ITEMS).map(({ id, text, link }) => ({ id, text, link }));
  if (!items.length) return { stop: { reason: `No list on the page to pick "${clip(step.target, 60)}" from` } };
  return { key: 'pick', question: pickQuestion(step.target, items), items };
}

// What the answer means for the step: { result } to end it, or { then } to run a step next.
export function settleJudgment(ctx, step, row, j, answers) {
  if (step.action === 'branch') {
    const p = answers.cond?.noul;
    row.p = p;
    if (!Number.isFinite(p) || p < 0 || p > 1 || (p > 0.25 && p < SURE)) return { result: { stop: { reason: 'condition unresolved' } } };
    row.branch = p >= SURE ? 'then' : 'else';
    row.skipped_branch = p >= SURE ? 'else' : 'then';
    return { result: {} };
  }
  if (step.action === 'if') {
    row.p = prob(answers.cond);
    if (row.p >= 0.5) { row.how = `the page shows it (p=${row.p})`; return { then: step.then }; }
    row.skipped = `the page does not show "${clip(step.target, 60)}" (p=${row.p})`;
    return { result: {} };
  }
  if (step.action === 'extract') {
    if (step.binding) {
      let partial;
      try {
        let binding;
        if (step.fields) {
          const fields = {}, value = {}, raw = {};
          partial = { value, raw, fields, type: 'record', url: ctx.view?.url, source_step: row.step, partial: true };
          for (const field of step.fields) {
            const evidence = boundExtract(ctx, answers[`extract.${field.name}`], j.fields[field.name].spans, field);
            evidence.source_step = row.step;
            put(fields, field.name, evidence);
            put(value, field.name, evidence.value);
            put(raw, field.name, evidence.raw);
          }
          binding = { value, raw, type: 'record', normalization: 'Each field parsed independently from its selected observed line', fields, p: Math.min(...Object.values(fields).map(f => f.p)), url: ctx.view?.url };
        } else binding = boundExtract(ctx, answers.extract, j.spans, step.extraction || { type: 'text' });
        binding.source_step = row.step;
        if (binding.fields) for (const evidence of Object.values(binding.fields)) evidence.source_step = row.step;
        if (ctx.bindings.has(step.binding)) throw new Error(`Binding $${step.binding} already exists`);
        ctx.bindings.set(step.binding, binding);
        (ctx.report.bindings ||= []).push({ name: step.binding, step: row.step, ...binding });
        row.binding = { name: step.binding, ...binding };
        row.extracted = binding;
        row.p = binding.p;
        (ctx.report.extracted ||= []).push({ step: row.step, what: step.target || step.binding, ...binding });
        return { result: {} };
      } catch (e) {
        if (partial && Object.keys(partial.fields).length) {
          partial.p = Math.min(...Object.values(partial.fields).map(f => f.p));
          row.extracted = partial;
          (ctx.report.extracted ||= []).push({ step: row.step, what: step.target || step.binding, ...partial });
        }
        return { result: { stop: { reason: e.message, required: true } } };
      }
    }
    let r;
    try { r = readExtract(answers.extract, j.spans); } catch (e) { return { result: { stop: { reason: e.message } } }; }
    const span = j.spans[Number(answers.extract?.choice?.slice(1)) - 1];
    r = { ...r, raw: r.value, url: ctx.view?.url, ...(span ? { span: span.i } : {}), source_step: row.step, normalization: 'Exact observed text' };
    row.extracted = r;
    row.p = r.p;
    (ctx.report.extracted ||= []).push({ step: row.step, what: step.target, ...r });
    if (r.value === null) row.skipped = 'no line on the page answers this';
    else if (r.p < SURE) row.unsure = true;
    return { result: {} };
  }
  let r;
  try { r = readPick(answers.pick, j.items); } catch (e) { return { result: { stop: { reason: e.message } } }; }
  if (!r.item) {
    const close = r.runnersUp.map(c => `${c.id} "${c.text}" (p=${c.p})`).join('; ');
    return { result: { stop: { reason: `No listed item fits "${clip(step.target, 80)}"${close ? `; closest: ${close}` : ''}` } } };
  }
  row.picked = { id: r.item.id, text: clip(r.item.text, 120), p: r.p, ...(r.runnersUp.length ? { runnersUp: r.runnersUp } : {}) };
  row.p = r.p;
  if (r.p < SURE) row.unsure = true;
  // Open it: its link when it has one (a card's own address), else click the item.
  if (r.item.link) {
    let url = r.item.link;
    try { url = new URL(r.item.link, ctx.view?.url).href; } catch {}
    row.how = `picked ${r.item.id}`;
    return { then: { action: 'nav', target: url } };
  }
  return { then: { action: 'click', target: r.item.id, item: r.item.id } };
}

function boundExtract(ctx, answer, spans, schema) {
  if (typeof answer?.choice !== 'string' || !/^l[1-9]\d*$/.test(answer.choice) || !spans[Number(answer.choice.slice(1)) - 1]) throw new Error('Required extraction has no valid offered choice');
  if (!answer?.probabilities || Object.values(answer.probabilities).some(p => !Number.isFinite(p) || p < 0 || p > 1)) throw new Error('Required extraction has malformed probabilities');
  const r = readExtract(answer, spans);
  const p = answer?.probabilities?.[answer.choice];
  if (typeof r.value !== 'string' || !Number.isFinite(p) || p < SURE || p > 1) throw new Error('Required extraction is missing or uncertain');
  const span = spans[Number(answer.choice.slice(1)) - 1];
  return { ...parseExtractEvidence(r.value, schema), raw: r.value, p: r.p, url: ctx.view?.url, span: span.i };
}
