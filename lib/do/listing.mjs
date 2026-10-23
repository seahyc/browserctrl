// Frozen listing evidence shared by item loops and ranked reads. DOM ids never
// become navigation targets: the copied absolute URL identifies a source item.
import { judgment } from './judgments.mjs';
import { rankLines, ranking } from './rank-lines.mjs';
import * as ops from '../ops.mjs';
import { itemsExpression, mainGroup } from '../items.mjs';
import { extractValues, parseExtractEvidence, rankedItemQuestions } from '../judge.mjs';
import { prob, AGAIN } from './context.mjs';
import { askJev } from './perform.mjs';

const MAX_ITEMS = 200;
const AD = /(^|[\s·{,_-])(ad|ads|sponsored|promoted|spotlight|anzeige|werbung|gesponsert|annonce|sponsorisé|anuncio|patrocinado|annuncio|sponsorizzato|advertentie|gesponsord|реклама|iklan|quảng cáo|广告|赞助|広告|スポンサー|광고)([\s·},_-]|$)/iu;
const area = g => (g.box?.w || 0) * (g.box?.h || 0) || g.count || g.items.length;
const PAGE_ORDER_ONLY = /^(?:first|top|last|first\s+\d+|top\s+\d+|last\s+\d+|first\s+in\s+page\s+order|in\s+page\s+order|page\s+order)$/i;

export async function freezeList(ctx) {
  const listing = await ops.evaluate(ctx.conn, ctx.tab, itemsExpression({ maxItems: MAX_ITEMS + 1, maxGroups: 100 }));
  if (!listing || !Array.isArray(listing.groups)) throw new Error('The source list could not be read');
  const groups = listing.groups.filter(g => !g.chrome && g.items?.length);
  const content = groups.filter(g => !/\b(aside|complementary)\b/i.test(g.region || ''));
  const pool = (content.length ? content : groups).sort((a, b) => area(b) - area(a));
  if (pool.length > 1 && area(pool[0]) === area(pool[1])) {
    throw new Error(`Ambiguous main groups: ${pool.filter(g => area(g) === area(pool[0])).map(g => [g.id, g.region, g.heading, g.label].filter(Boolean).join(' ')).join('; ')}`);
  }
  const main = mainGroup(listing);
  const source_url = listing.url || ctx.view?.url;
  const seen = new Set(), organic = [];
  for (const original of main?.items || []) {
    if (AD.test(original.text || '') || (original.hints || []).some(h => AD.test(` ${h} `))) continue;
    let link = null;
    if (original.link) {
      try {
        const parsed = new URL(original.link, source_url);
        if (['http:', 'https:'].includes(parsed.protocol)) link = parsed.href;
      } catch {}
      if (link && seen.has(link)) continue;
      if (link) seen.add(link);
    }
    organic.push({ id: original.id, text: original.text || '', link, source_url, order: organic.length + 1 });
  }
  const truncated = organic.length > MAX_ITEMS || (main?.count || 0) > (main?.items.length || 0);
  const items = organic.slice(0, MAX_ITEMS);
  return { items, source_url, truncated, coverage: { offered: items.length, total: main?.count || 0, truncated } };
}

function candidates(text, schema) {
  let values;
  try { parseExtractEvidence(text, schema); values = [text]; } catch { values = extractValues(text, schema); }
  if (schema.type !== 'number' || values.length < 2 || !/\b(price|cost|rate|cheapest|lowest)\b/i.test(schema.criterion || '')) return values;
  const parsed = values.map(value => ({ value, evidence: parseExtractEvidence(value, schema) }));
  const period = schema.criterion.match(/\bper\s+(person|night|day|week|month|year|stay)\b/i)?.[1]?.toLowerCase();
  const matchingPeriod = period ? parsed.filter(x => x.evidence.unit === period) : [];
  if (matchingPeriod.length) return matchingPeriod.map(x => x.value);
  // Prefer values explicitly marked as current/primary; otherwise the first observed
  // price is primary and later prices are commonly crossed-out historical amounts.
  const labelled = parsed.filter(({ value }) => /\b(?:price|current|now|from)\b/i.test(value));
  return (labelled.length ? labelled : parsed).slice(0, 1).map(x => x.value);
}

export async function rankedPick(ctx, step, row) {
  try {
    const sort = ranking(step.target);
    let frozen = await freezeList(ctx);
    let local;
    if (sort.type === 'order' && PAGE_ORDER_ONLY.test(step.target.trim()) && frozen.items.length) {
      local = rankLines(frozen.items, step.target);
    }
    const hasKey = item => {
      const values = candidates(item.text, { ...sort, criterion: step.target });
      if (!values.length) return false;
      if (sort.type === 'number' && /\b(price|cost|rate|cheapest)\b/i.test(step.target)) {
        return /\b(price|cost|rate)\b/i.test(item.text) || values.some(value => parseExtractEvidence(value, sort).currency);
      }
      const key = step.target.match(/\b(rating|score|count|star|fork|amount|distance|duration|size|number|review)s?\b/i)?.[1];
      return !key || new RegExp(`\\b${key}s?\\b`, 'i').test(item.text);
    };
    if (!local?.length && sort.type === 'order' && frozen.items.length) {
      local = rankLines(frozen.items, step.target);
    }
    if (!local?.length && !(sort.type === 'order' && PAGE_ORDER_ONLY.test(step.target.trim())) && (sort.type === 'order' || !frozen.items.some(hasKey))) {
      const evidence = await judgment(ctx, { action: 'extract', target: step.target, localRanking: true });
      local = rankLines(evidence.all, step.target);
      frozen = { ...frozen, truncated: false };
    }
    if (local) {
      if (!local.length) { row.unsure = true; return { stop: { reason: 'no list or lines to rank' } }; }
      local = local.map(item => ({
        ...item, source_url: frozen.source_url,
        evidence: { ...item.evidence, p: 1, source_url: frozen.source_url, source_step: row.step },
      }));
      frozen.coverage = { offered: local.length, total: local.length, truncated: frozen.truncated };
    }
    row.coverage = frozen.coverage;
    row.truncated = frozen.truncated;
    row.source_url = frozen.source_url;
    const extra = {}, keys = new Map();
    for (const item of local ? [] : frozen.items) {
      const prefix = `item.${item.id}`;
      const values = candidates(item.text, { ...sort, criterion: step.target });
      keys.set(item.id, values);
      const questions = rankedItemQuestions(step.target, item, sort.type, values);
      extra[`${prefix}.eligible`] = questions.eligible;
      extra[`${prefix}.key`] = questions.key;
    }
    const asked = await askJev(ctx, step, row, {}, { extra, inNote: true });
    if (asked === AGAIN) return { stop: { reason: 'The source page changed while selecting ranked items; run the ranked read again' } };
    if (asked.result) return asked.result;
    if (asked.watchBlocker && prob(asked.answers.blocker) >= 0.5) return { stop: { reason: 'A blocking overlay obscures the source list' } };
    const selected = local || [], unresolved = [], excluded = [];
    const possibleKeys = new Map();
    for (const item of local ? [] : frozen.items) {
      const prefix = `item.${item.id}`, p = asked.answers[`${prefix}.eligible`]?.noul;
      if (!(p >= 0 && p <= 1) || (p > 0.25 && p < 0.75)) { unresolved.push(item); possibleKeys.set(item.id, keys.get(item.id).map(value => parseExtractEvidence(value, sort).value)); continue; }
      if (p <= 0.25) continue;
      const answer = asked.answers[`${prefix}.key`];
      const values = keys.get(item.id), index = /^v[1-9]\d*$/.test(answer?.choice || '') ? Number(answer.choice.slice(1)) - 1 : -1;
      const probabilities = answer?.probabilities;
      const keyP = probabilities?.[answer?.choice];
      if (answer?.type !== 'choice' || !values[index] || !Number.isFinite(keyP) || keyP < 0.75 || !probabilities || Object.values(probabilities).some(p => !Number.isFinite(p) || p < 0 || p > 1) || Object.values(probabilities).reduce((a, b) => a + b, 0) > 1.001) {
        // An eligible item without a readable key could still be the answer, so it blocks the pick.
        return { stop: { reason: `Missing or uncertain observable sort key for ${item.id}` } };
      }
      const evidence = { ...parseExtractEvidence(values[index], sort), raw: values[index], p: keyP, source_url: frozen.source_url, source_step: row.step };
      selected.push({ ...item, key: evidence.value, eligibility_p: p, evidence, p: Math.min(p, keyP) });
    }
    if (frozen.truncated) return { stop: { reason: 'Ranked selection requires unseen items: source list truncated at 200 items' } };
    if (sort.type === 'number') {
      const groups = new Map();
      for (const item of selected) {
        const key = JSON.stringify([item.evidence.currency || '', item.evidence.unit || '']);
        groups.set(key, [...(groups.get(key) || []), item]);
      }
      if (groups.size > 1) {
        const bySize = [...groups.values()].sort((a, b) => b.length - a.length);
        const requested = step.target.match(/\bper\s+(person|night|day|week|month|year|stay)\b/i)?.[1]?.toLowerCase();
        const preferred = requested && bySize.flat().filter(item => item.evidence.unit === requested);
        const dominant = preferred?.length ? preferred : bySize[0];
        if (!preferred?.length && dominant.length <= selected.length / 2) return { stop: { reason: 'Ranked sort keys have incompatible currencies or units; no single group covers most eligible items' } };
        const keep = new Set(dominant.map(item => item.id));
        for (const item of selected) if (!keep.has(item.id)) {
          const wanted = requested ? `, not per ${requested}` : '';
          const actual = item.evidence.unit ? `per ${item.evidence.unit}` : (item.evidence.currency || 'unspecified currency');
          excluded.push({ item, why: `${actual}${wanted}` });
        }
        selected.splice(0, selected.length, ...dominant);
      }
    }
    selected.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) * sort.direction || a.order - b.order);
    if (!selected.length && unresolved.length) return { stop: { reason: `Ranked eligibility unresolved for ${unresolved.map(item => item.id).join(', ')}` } };
    if (!selected.length) { row.unsure = true; return { stop: { reason: 'no list or lines to rank' } }; }
    const chosen = selected.slice(0, step.limit);
    const boundary = chosen.length >= step.limit ? chosen.at(-1).key : null;
    const couldChange = unresolved.filter(item => {
      const values = possibleKeys.get(item.id) || [];
      if (boundary == null || !values.length) return true;
      return values.some(value => sort.direction > 0 ? value <= boundary : value >= boundary);
    });
    if (couldChange.length) return { stop: { reason: `Ranked eligibility unresolved could change the top ${step.limit}: ${couldChange.map(item => item.id).join(', ')}` } };
    if (unresolved.length) row.excluded = [...(row.excluded || []), ...unresolved.map(item => `${item.id} unresolved, not ranked`)];
    if (excluded.length) row.excluded = [...(row.excluded || []), ...excluded.map(({ item, why }) => `${item.id} excluded: ${why}`)];
    const items = chosen;
    row.items = items;
    row.requested = step.limit;
    row.completed = items.length;
    row.source_exhausted = items.length < step.limit;
    row.tie_order = 'page order';
    if (ctx.bindings.has(step.binding)) return { stop: { reason: `Binding $${step.binding} already exists` } };
    const binding = { type: 'array', value: items, raw: items.map(item => item.text), p: items.length ? Math.min(...items.map(item => item.p)) : 1, source_step: row.step, url: frozen.source_url, coverage: frozen.coverage };
    ctx.bindings.set(step.binding, binding);
    row.binding = { name: step.binding, ...binding };
    (ctx.report.bindings ||= []).push({ name: step.binding, step: row.step, ...binding });
    return {};
  } catch (error) {
    return { stop: { reason: error.message } };
  }
}
