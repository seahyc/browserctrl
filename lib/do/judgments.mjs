// Steps that ask Jev about the page instead of finding a control, so a plan can carry a whole
// task in one call: `extract` copies the line that answers a question into the report, `pick`
// opens the list item that fits best, `if` runs its step only when the page shows something.
// Each question rides in the step's one Jev request (askJev in perform.mjs), next to the
// previous step's expectation; lib/judge.mjs builds the questions and reads the answers.
import * as ops from '../ops.mjs';
import { itemsExpression, mainGroup } from '../items.mjs';
import { spansOf, shortlistSpans, extractQuestion, readExtract, pickQuestion, readPick, conditionQuestion } from '../judge.mjs';
import { clip, prob } from './context.mjs';

const PAGE_TEXT = 100_000;
const MAX_ITEMS = 200;
const SURE = 0.75;
const AD = /(^|[\s·{,_-])(ad|ads|sponsored|promoted)([\s·},_-]|$)/i;

export const JUDGED = new Set(['extract', 'pick', 'if']);

// The question for this step and what is needed to read its answer, or { stop }.
export async function judgment(ctx, step) {
  const { conn, tab } = ctx;
  if (step.action === 'if') return { key: 'cond', question: conditionQuestion(step.target) };
  if (step.action === 'extract') {
    // The whole page, not just the screen: an answer is often below the fold.
    const text = await ops.evaluate(conn, tab, `((document.body && document.body.innerText) || '').slice(0, ${PAGE_TEXT})`).catch(() => '');
    const spans = shortlistSpans(spansOf(`${ctx.view?.overlay || ''}\n${text}`), step.target);
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
  if (step.action === 'if') {
    row.p = prob(answers.cond);
    if (row.p >= 0.5) { row.how = `the page shows it (p=${row.p})`; return { then: step.then }; }
    row.skipped = `the page does not show "${clip(step.target, 60)}" (p=${row.p})`;
    return { result: {} };
  }
  if (step.action === 'extract') {
    let r;
    try { r = readExtract(answers.extract, j.spans); } catch (e) { return { result: { stop: { reason: e.message } } }; }
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
