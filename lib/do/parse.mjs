// A plan's steps, parsed: `click "More filters"`, `fill "the search box" = "aeron"`, and the
// rest (parseStep below lists them all).
import { parseDateText, isoDate } from '../page/shared.mjs';
import { alternatives } from '../judge.mjs';

const ACTIONS = new Set(['click', 'check', 'fill', 'select', 'hover', 'key', 'type', 'scroll', 'nav', 'expect', 'wait', 'date', 'set', 'extract', 'pick', 'if']);
export const TARGETED = new Set(['click', 'fill', 'select', 'hover']);
const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/s, '$2');
// A target can name an element directly instead of describing it: a ref from the last
// read (ref_25), an item id from items (i140, unquoted, since "i5" is also a processor)
// or a CSS selector (#id, .class, [attr=v], tag[attr]). These never go to Jev.
const REF = /^ref_\d+$/;
const ITEM = /^i\d+$/;
// "#id", ".class", "[attr]", "tag[…]", "tag#id", "tag:pseudo", "a > b", and custom elements
// ("p-accordion", "fnssr-p-accordion:nth-of-type(6) h2"). A selector that matches nothing falls
// back to grounding by name, so a hyphenated word ("check-in") costs one failed lookup at most.
export const looksLikeSelector = (s) => {
  const t = String(s).trim();
  return /^([#.][A-Za-z_-]|\[[\w-]+([~|^$*]?=|\])|[a-z][\w-]*(\[|[#.][A-Za-z_-]|:[a-z]))/.test(t) ||
    /^[a-z][a-z0-9]*-[a-z0-9-]*(?=$|[\s>~+#.\[:])/.test(t) || /^[a-z][\w-]*\s*[>~+]\s*[a-z#.\[]/i.test(t);
};

// The last `=>` outside quotes splits off the expected result. A quote opens only after a
// space, `=` or the start, so "Men's shoes" is not a quoted string.
function splitExpect(s) {
  let q = null, at = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if ((c === '"' || c === "'") && (i === 0 || /[\s=]/.test(s[i - 1]))) { q = c; continue; }
    if (c === '=' && s[i + 1] === '>') at = i;
  }
  if (at < 0) return { core: s };
  const expect = unquote(s.slice(at + 2));
  if (!expect) throw new Error(`"${s}": write the expected result after =>`);
  return { core: s.slice(0, at).trim(), expect };
}

// A slider value, or the two ends of a range, written as a person would: "40", "$300-$900",
// "1,200 to 2,500", "18–65". Currency signs and thousands separators are dropped.
export function sliderValues(text) {
  const s = String(text || '').replace(/[$€£¥₹]|\b(usd|eur|gbp|sgd|cad|aud)\b/gi, '').replace(/(\d),(?=\d{3}\b)/g, '$1').trim();
  const n = '(-?\\d+(?:\\.\\d+)?)';
  let m = s.match(new RegExp(`^${n}\\s*(?:-|–|—|to|\\.\\.)\\s*${n}$`, 'i'));
  if (m) { const a = Number(m[1]), b = Number(m[2]); return a <= b ? [a, b] : [b, a]; }
  m = s.match(new RegExp(`^${n}$`));
  return m ? [Number(m[1])] : null;
}

// `click "More filters"`, `fill "the search box" = "aeron"`, `select Sort = Price`,
// `key Enter`, `type "jane"` (into whatever has focus), `scroll down`, `nav https://…`,
// `expect "results are filtered"`, `wait 1500`, `date 2026-10-17` (a calendar day),
// `set "Price" = 300-900` (a slider, or both ends of a range slider),
// `extract "<what>"` (the line of the page that answers it, copied into the report),
// `pick "<criterion>"` (the item of the main list that fits best, opened),
// `if "<page condition>" then <step>`, and `click "Filters" | "All filters"` (the first
// name the page has).
// Any step may start with `optional` and end with `=> "<expected result>"`.
export function parseStep(line) {
  let s = String(line).trim();
  const opt = s.match(/^optional\s+(.*)$/s);
  if (opt) s = opt[1];
  const { core, expect } = splitExpect(s);
  const extra = { ...(opt ? { optional: true } : {}), ...(expect ? { expect } : {}) };
  // `click! "Submit"` marks a step the plan means to commit (see the guard in perform).
  // Only a click or a select can commit; `fill!` and the like simply run without the mark.
  const m = core.match(/^(\w+)(!?)\s*(.*)$/s);
  if (!m || !ACTIONS.has(m[1])) throw new Error(`Unknown step "${line}". Steps: ${[...ACTIONS].join(', ')}`);
  const action = m[1] === 'check' ? 'click' : m[1];
  if (m[1] === 'check') extra.check = true;
  if (m[2] && ['click', 'select'].includes(action)) extra.commit = true;
  const rest = m[3].trim();
  const direct = (raw, target) => (REF.test(target) ? { ref: target } : ITEM.test(raw) ? { item: target } : looksLikeSelector(target) ? { selector: target } : {});
  if (action === 'set') {
    const eq = rest.match(/^(".*?"|'.*?'|(?:[^=\[]|\[[^\]]*\])+?)\s*=\s*(.*)$/s);
    const values = eq ? sliderValues(unquote(eq[2])) : null;
    if (!values) throw new Error(`"${line}": write set <slider> = <value>, or set <slider> = <min>-<max> for a range`);
    const target = unquote(eq[1]);
    return { action, target, value: unquote(eq[2]), values, ...direct(eq[1].trim(), target), ...extra };
  }
  if (action === 'fill' || action === 'select') {
    const eq = rest.match(/^(".*?"|'.*?'|(?:[^=\[]|\[[^\]]*\])+?)\s*=\s*(.*)$/s);
    if (!eq) throw new Error(`"${line}": write ${action} <target> = <value>`);
    const target = unquote(eq[1]);
    return { action, target, value: unquote(eq[2]), ...direct(eq[1].trim(), target), ...extra };
  }
  if (['click', 'hover', 'expect', 'type'].includes(action) && !rest) throw new Error(`"${line}": name the ${action === 'expect' ? 'expected state' : action === 'type' ? 'text to type' : 'element'}`);
  if (action === 'date') {
    const d = parseDateText(unquote(rest));
    if (!d) throw new Error(`"${line}": write date YYYY-MM-DD`);
    return { action, target: isoDate(d), ...extra };
  }
  if (action === 'if') {
    const c = rest.match(/^(".*?"|'.*?')\s+then\s+(.+)$/s);
    if (!c) throw new Error(`"${line}": write if "<what the page shows>" then <step>`);
    const then = parseStep(c[2]);
    if (then.action === 'if') throw new Error(`"${line}": one if per step`);
    return { action, target: unquote(c[1]), then, ...extra };
  }
  if (['extract', 'pick'].includes(action) && !rest) throw new Error(`"${line}": say what to ${action === 'pick' ? 'pick, e.g. pick "the cheapest with free cancellation"' : 'extract, e.g. extract "the total price"'}`);
  const alts = ['click', 'hover'].includes(action) ? alternatives(rest) : null;
  if (alts) return { action, target: alts.map(a => `"${a}"`).join(' or '), alts, ...extra };
  const target = unquote(rest);
  return { action, target, ...(['click', 'hover'].includes(action) ? direct(rest, target) : {}), ...extra };
}
