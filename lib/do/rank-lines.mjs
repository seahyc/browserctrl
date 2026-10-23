import { extractValues, parseExtractEvidence } from '../judge.mjs';

export const SUPERLATIVE = /\b(earliest|latest|first|top|last|cheapest|lowest|highest|most|least|newest|oldest|smallest|largest|fewest)\b/i;
const VALUE_TYPE = /\b(date|price|cost|rate|rating|score|count|stars?|forks?|amount|distance|duration|size|number|reviews?)\b/i;
const FILLER = new Set('the a an of for and or in on at by with to is what which any site item listed'.split(' '));
const words = text => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map(w => w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

export function ranking(criterion) {
  const directionWord = criterion.match(SUPERLATIVE)?.[1].toLowerCase();
  if (!directionWord) throw new Error('Ranked pick requires an explicit observable numeric/date sort key and direction');
  const direction = /^(highest|largest|most|latest|newest|last)$/.test(directionWord) ? -1 : 1;
  const orderOnly = criterion.trim().replace(/\b(?:in\s+)?page\s+order\b/ig, '').replace(/\b(?:first|top|last)(?:\s+\d+)?\b/ig, '').trim();
  if (/^(first|top|last)$/.test(directionWord) && (!VALUE_TYPE.test(criterion) || !orderOnly)) return { type: 'order', direction };
  const date = /\b(date|earliest|oldest|latest|newest)\b/i.test(criterion);
  if (!date && !VALUE_TYPE.test(criterion) && !/cheapest/.test(directionWord)) throw new Error('Ranked pick requires an observable numeric/date key; vague quality rankings are unsupported');
  return { type: date ? 'date' : 'number', direction };
}

export function rankLines(lines, criterion) {
  const sort = ranking(criterion);
  const want = words(criterion.replace(/\b(?:in\s+)?page\s+order\b/gi, '').replace(new RegExp(SUPERLATIVE.source, 'gi'), '')).filter(w => !FILLER.has(w) && !['date', 'price', 'number'].includes(w));
  const seen = new Set(), selected = [];
  for (const [index, entry] of lines.entries()) {
    const line = typeof entry === 'string' ? { text: entry, i: index } : entry;
    if (seen.has(line.text)) continue;
    seen.add(line.text);
    const have = words(line.text);
    if (want.length && !want.every(w => have.includes(w))) continue;
    let evidence;
    if (sort.type === 'order') evidence = { type: 'number', value: line.i ?? index };
    else {
      let values;
      try { parseExtractEvidence(line.text, sort); values = [line.text]; } catch { values = extractValues(line.text, sort); }
      if (values.length !== 1) continue;
      evidence = { ...parseExtractEvidence(values[0], sort), raw: values[0] };
      if (/\b(cheapest|price|cost)\b/i.test(criterion) && !evidence.currency && !/\b(price|cost)\b/i.test(line.text)) continue;
    }
    selected.push({ id: line.id || `line.${line.i ?? index}`, text: line.text, ...(line.link ? { link: line.link } : {}), order: line.i ?? index, key: evidence.value, evidence, eligibility_p: 1, p: 1 });
  }
  const units = new Set(selected.map(item => JSON.stringify([item.evidence.currency, item.evidence.unit])));
  if (units.size > 1) throw new Error('Ranked sort keys have incompatible currencies or units');
  return selected.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) * sort.direction || a.order - b.order);
}
