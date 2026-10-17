// Run a short plan of steps in one call: the agent plans, browserctrl finds each target
// (an exact name match first, else one Jev choice) and stops at the first step it cannot
// do with confidence, returning the page so the agent can re-plan.
//
// v2: a step may carry an expected result (`click Apply => "results are filtered"`). It is
// checked in the same Jev request that grounds the next step, together with "is an overlay
// blocking the page?", so expectations cost no extra round trip. Listed overlay kinds are
// dismissed, new notices are recorded, a step can repeat until a page condition holds,
// and every run is traced per tab.
//
// Flow notes take part (lib/notes.mjs): the current page's notes ride along in each Jev
// request as context, a reveal note runs when a step's target cannot be found, an on note
// runs when Jev sees its situation, and a URL note that covers a planned click is suggested.
// Notes that ran are confirmed or contradicted at the end of the run.
import * as ops from './ops.mjs';
import * as jev from './jev.mjs';
import * as show from './show.mjs';
import { itemsExpression, formatItems, mainGroup } from './items.mjs';
import { visit, formatVisits } from './visit.mjs';
import * as prefetch from './prefetch.mjs';
import * as captcha from './captcha.mjs';
import * as cooldown from './cooldown.mjs';
import * as finder from './find.mjs';
import * as trace from './trace.mjs';
import * as notes from './notes.mjs';
import * as site from './site.mjs';
import { deepQuery, REFIND_FN } from './refs.mjs';

const ACTIONS = new Set(['click', 'fill', 'select', 'hover', 'key', 'type', 'scroll', 'nav', 'expect', 'wait', 'date', 'set']);
const TARGETED = new Set(['click', 'fill', 'select', 'hover']);
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
// `set "Price" = 300-900` (a slider, or both ends of a range slider).
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
  const action = m[1];
  if (m[2] && ['click', 'select'].includes(action)) extra.commit = true;
  const rest = m[3].trim();
  const direct = (raw, target) => (REF.test(target) ? { ref: target } : ITEM.test(raw) ? { item: target } : looksLikeSelector(target) ? { selector: target } : {});
  if (action === 'set') {
    const eq = rest.match(/^(".*?"|'.*?'|[^=]+?)\s*=\s*(.*)$/s);
    const values = eq ? sliderValues(unquote(eq[2])) : null;
    if (!values) throw new Error(`"${line}": write set <slider> = <value>, or set <slider> = <min>-<max> for a range`);
    const target = unquote(eq[1]);
    return { action, target, value: unquote(eq[2]), values, ...direct(eq[1].trim(), target), ...extra };
  }
  if (action === 'fill' || action === 'select') {
    const eq = rest.match(/^(".*?"|'.*?'|[^=]+?)\s*=\s*(.*)$/s);
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
  const target = unquote(rest);
  return { action, target, ...(['click', 'hover'].includes(action) ? direct(rest, target) : {}), ...extra };
}

// ---------------------------------------------------------------- dates ----
// Calendars name a day in many ways: "Friday, 16 October 2026", "Oct 16, 2026",
// "16, Friday, October 2026. Available", "2026-10-16", "10/16/2026". One parser serves
// both sides: the step's date and every day cell's label.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export const isoDate = ({ y, m, d }) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export function parseDateText(text) {
  const s = String(text || '').toLowerCase()
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?/g, ' ')
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  const mon = (w) => { const i = MONTHS.indexOf(w.slice(0, 3)); return i < 0 ? null : i + 1; };
  const ok = (y, m, d) => (y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? { y, m, d } : null);
  let r;
  if ((r = s.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/))) return ok(+r[1], +r[2], +r[3]);
  const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
  if ((r = s.match(new RegExp(`\\b${MON} (\\d{1,2}) (\\d{4})\\b`)))) return ok(+r[3], mon(r[1]), +r[2]);
  if ((r = s.match(new RegExp(`\\b(\\d{1,2}) ${MON} (\\d{4})\\b`)))) return ok(+r[3], mon(r[2]), +r[1]);
  // A US month/day/year reading; day/month/year is tried by the caller when it differs.
  if ((r = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/))) return ok(+r[3], +r[1], +r[2]) || ok(+r[3], +r[2], +r[1]);
  return null;
}
const sameDay = (a, b) => a && b && a.y === b.y && a.m === b.m && a.d === b.d;

// In the page: the clickable day cell for the date, the dates shown, and the month arrows.
// Pins the cell and arrows with data-bc-pin so a click can find them by selector.
const DATE_PAGE = (iso, pin) => `(() => {
  const want = ${JSON.stringify(iso)}, pin = ${JSON.stringify(pin)};
  for (const old of document.querySelectorAll('[data-bc-pin^="' + pin + '-"]')) old.removeAttribute('data-bc-pin');
  const parse =${parseDateText.toString().replace(/^function parseDateText/, 'function')};
  const MONTHS = ${JSON.stringify(MONTHS)};
  const shown = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const iso = (d) => d && d.y + '-' + String(d.m).padStart(2, '0') + '-' + String(d.d).padStart(2, '0');
  const labelOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('data-date'), el.getAttribute('data-day'), el.getAttribute('data-testid'), el.getAttribute('datetime'), el.getAttribute('title')].filter(Boolean).join(' | ');
  // Day cells named only by their text ("October 16, 2026 16", a hidden label beside the
  // day number) carry the date in innerText: buttons and grid cells are read that way too.
  // Only inside a calendar-like grid: a dropdown button that shows a date is not a day cell.
  const inGrid = (el) => Boolean(el.closest('table,[role=grid],[role=rowgroup]')) || (el.parentElement && [...el.parentElement.children].filter(c => c.tagName === el.tagName).length >= 7);
  // Calendars drawn from plain elements (a Vue date picker's <span class="cell day">) mark
  // their day cells by class; headers and blanks are not days.
  const dayLike = (el) => { const c = typeof el.className === 'string' ? el.className : ''; return /(^|[\\s_-])(day|date|cell)([\\s_-]|$)/i.test(c) && !/header|name|blank|week|month|year/i.test(c); };
  const textOf = (el) => ((el.matches('button,td,[role=gridcell],[role=button]') || dayLike(el)) && inGrid(el) ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : '');
  const cells = document.querySelectorAll('[aria-label],[data-date],[data-day],[data-testid],time[datetime],[title],button,td,[role=gridcell],[class*=day],[class*=date],[class*=cell]');
  // A grid of bare day numbers takes its month and year from the nearest heading before it
  // ("November 2026"), so calendars that label no day still work, side-by-side months too.
  const MONTH_YEAR = /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\.?\\s+(\\d{4})$/i;
  const monthCache = new Map();
  const monthOf = (el) => {
    const grid = el.closest('table,[role=grid]') || (dayLike(el) && inGrid(el) ? el.parentElement : null);
    if (!grid) return null;
    if (monthCache.has(grid)) return monthCache.get(grid);
    let found = null;
    for (let n = grid.parentElement, i = 0; n && n !== document.body && i < 4 && !found; n = n.parentElement, i++) {
      for (const h of n.querySelectorAll('h1,h2,h3,h4,h5,h6,caption,[role=heading],strong,span,div')) {
        if (grid.contains(h) || h.children.length > 2) continue;
        if (!(h.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        const t = (h.innerText || '').replace(/\\s+/g, ' ').trim();
        const m = t.match(MONTH_YEAR);
        if (m) found = { m: MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, y: +m[2] }; // the last heading before the grid wins
      }
    }
    monthCache.set(grid, found);
    return found;
  };
  let hit = null; const dates = [];
  for (let i = 0; i < cells.length && i < 5000; i++) {
    let el = cells[i];
    if (el.closest('[data-cdp]')) continue;
    const attrs = labelOf(el), own = textOf(el);
    const label = /\\d/.test(attrs) || own.length > 60 ? attrs : own;
    if (!/\\d/.test(label)) continue;
    let d = null;
    for (const part of label.split(' | ')) { d = parse(part); if (d) break; }
    if (!d && /^\\d{1,2}$/.test(label.trim())) { const mo = monthOf(el); if (mo) d = { y: mo.y, m: mo.m, d: +label.trim() }; }
    if (!d) continue;
    // A screen-reader label on a zero-size node inside the day: the day is its visible
    // clickable ancestor.
    if (!shown(el)) {
      const up = el.closest('button,a,[role=button],[role=gridcell],td,[tabindex]');
      if (!up || !shown(up)) continue;
      el = up;
    }
    dates.push(iso(d));
    if (!hit && iso(d) === want) {
      // Click the control itself: the cell, or the button inside it.
      const ctl = el.matches('button,a,[role=button],[role=gridcell],td,[tabindex]') ? el : (el.querySelector('button,a,[role=button]') || el);
      const off = ctl.disabled || ctl.getAttribute('aria-disabled') === 'true' || /\\bdisabled\\b|unavailable|blocked/i.test((ctl.className && ctl.className.baseVal !== undefined ? ctl.className.baseVal : ctl.className) || '');
      ctl.setAttribute('data-bc-pin', pin + '-day');
      hit = { label: label.slice(0, 80), disabled: !!off };
    }
  }
  // Month arrows: ones that say "month" first, then any next/previous arrow.
  const arrows = {}, found = { next: [], prev: [] };
  for (const el of document.querySelectorAll('button,a,[role=button],[class*=prev],[class*=next]')) {
    if (!shown(el) || el.closest('[data-cdp]') || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    // A bare element counts as an arrow only by its class, and only with no controls inside.
    if (!el.matches('button,a,[role=button]') && (el.querySelector('button,a,input') || (el.innerText || '').trim().length > 3)) continue;
    const n = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.innerText || '') + ' ' + (el.getAttribute('data-testid') || '') + ' ' + (typeof el.className === 'string' ? el.className : '')).toLowerCase().replace(/\\s+/g, ' ').trim();
    if (/\\bnext\\b|forward|›|»|→|chevron.?right|arrow.?right/.test(n)) found.next.push([el, n]);
    if (/\\bprev(ious)?\\b|\\bback\\b|‹|«|←|chevron.?left|arrow.?left/.test(n)) found.prev.push([el, n]);
  }
  for (const k of ['next', 'prev']) {
    const pick = found[k].find(([, n]) => /month/.test(n)) || found[k][0];
    if (pick) { pick[0].setAttribute('data-bc-pin', pin + '-' + k); arrows[k] = pick[1].slice(0, 40); }
  }
  dates.sort();
  return { hit, first: dates[0] || null, last: dates[dates.length - 1] || null, count: dates.length, arrows };
})()`;

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const prob = (a) => (a && typeof a.noul === 'number' ? Math.round(a.noul * 100) / 100 : NaN);
const noul = (instructions) => ({ type: 'noul', instructions });
const describeEl = (e) => `${e.role} "${clip(e.name, 60)}"`;

// An element whose name is exactly the target needs no model: "Apply", "More filters".
export function exactMatch(snap, step) {
  const want = norm(step.target);
  // A field's placeholder is the name a person sees ("Search or filter results…").
  const bare = (s) => norm(s).replace(/[.…]+$/, '');
  let hits = jev.candidatesFor(snap.elements, step.action).filter(e => norm(e.name) === want || (e.placeholder && bare(e.placeholder) === bare(want)));
  // A filter written with the result count the page shows beside it ("Middle Income Jobs
  // ($30K-$49K) (924)"), or a control named with its count when the plan left it out: the
  // count is not part of the name.
  if (!hits.length && ['click', 'hover'].includes(step.action)) {
    const uncounted = (s) => norm(s).replace(/\s*\(\s*\d[\d,.]*\s*\)$/, '');
    if (uncounted(want)) hits = jev.candidatesFor(snap.elements, step.action).filter(e => e.name && uncounted(e.name) === uncounted(want));
  }
  // A click wants the control that acts on a click: "click Search" after filling the search
  // box is its button, not the box whose placeholder also says "Search" (Ohio Means Jobs).
  // A name beats a placeholder, and a button, link or option beats a text field.
  if (step.action === 'click' && hits.length > 1) {
    const prefer = (keep) => { const k = hits.filter(keep); if (k.length) hits = k; };
    prefer(e => norm(e.name) === want);
    prefer(e => !/^(textbox|searchbox|combobox)$/.test(e.role));
  }
  if (hits.length <= 1) return hits[0] || null;
  // Several controls carry the exact name (a header link and a hero button both saying
  // "Order Now"): the plan named it exactly, so take the first one on screen, in page order.
  const pick = hits.find(e => !e.offscreen) || hits[0];
  return { ...pick, duplicates: hits.length };
}

// Every word of a step's target in a control's name, with max/maximum and min/minimum alike
// and symbols ignored: "Max Price $" carries "Maximum Price".
const WORD_FORMS = { maximum: 'max', minimum: 'min', from: 'min', to: 'max' };
const wordsOf = (s) => new Set((String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map(w => WORD_FORMS[w] || w));
export function sameWords(name, target) {
  const want = [...wordsOf(target)].filter(w => w.length > 1);
  if (!want.length) return false;
  const have = wordsOf(name);
  return want.every(w => have.has(w));
}

// Numbers and dates the intent names must show up in what Jev picked: "October 17, 2026"
// is not "When Add dates", and "Under $25,000" is not "Payment & Price". Ordinals ("2nd
// result") describe position, not text. Returns the missing pieces, or [].
export function missingFromPick(intent, el) {
  // A result count the page prints beside a filter, "(924)", is not part of its name.
  const said = String(intent || '').toLowerCase().replace(/\s*\(\s*\d[\d,.]*\s*\)\s*$/, '');
  const seen = [el?.name, el?.value, el?.placeholder, el?.within, el?.testid, el?.href].filter(Boolean).join(' ').toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
  const nums = [...said.replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?!\d|st\b|nd\b|rd\b|th\b)/g)].map(m => m[1]);
  const missing = nums.filter(n => !new RegExp(`(?<!\\d)${n.replace('.', '\\.')}(?!\\d)`).test(seen));
  for (const m of said.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g)) {
    if (m[0] === 'may' && !/\d/.test(said)) continue; // "may" the verb
    if (!seen.includes(m[1])) missing.push(m[0]);
  }
  return [...new Set(missing)];
}

// ------------------------------------------------------- direct targets ----
// A pinned element carries data-bc-pin="<key>", so a click or fill can find it by selector
// even after another snapshot replaced the refs. Each describes itself the way a snapshot
// row would, and says where it sits in the current snapshot (0 when it is not in it).
const ELEMENT_INFO = `function info(el) {
    const tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' && el.hasAttribute('href') ? 'link' : tag === 'button' ? 'button' : tag === 'select' ? 'select' : tag === 'textarea' ? 'textbox'
      : tag === 'input' ? (['checkbox', 'radio'].includes(type) ? type : ['button', 'submit', 'reset'].includes(type) ? 'button' : type === 'search' ? 'searchbox' : 'textbox') : tag === 'option' ? 'option' : 'generic');
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const els = (window.__cdp && window.__cdp.els) || [];
    const at = els.indexOf(el);
    const input = el.matches('input[type=checkbox],input[type=radio]') ? el : (el.control || el.querySelector && el.querySelector('input[type=checkbox],input[type=radio]'));
    return { ref: at >= 0 ? 'ref_' + (at + 1) : null, role, name, href: el.getAttribute('href') || undefined, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      checked: input ? input.checked : el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true'
        : el.hasAttribute('aria-pressed') ? el.getAttribute('aria-pressed') === 'true' : undefined,
      pressed: !input && !el.hasAttribute('aria-checked') && el.hasAttribute('aria-pressed') ? el.getAttribute('aria-pressed') === 'true' : undefined };
  }`;
const shownJs = `function shown(el) { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; }`;

// The centre of an element that is wholly in view, or null. A click by selector scrolls the
// element to the middle of the screen first, and some pages close an open panel on any
// scroll (Airbnb's date picker shut, unchanged, when a day cell was clicked that way).
const IN_VIEW_POINT = (selector) => `(() => {
  const el = ${deepQuery(selector)};
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1 || r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) return null;
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  // In view but under a pinned bar (a dialog's sticky footer): not a point to click.
  const root = el.getRootNode && el.getRootNode().elementFromPoint ? el.getRootNode() : document;
  const hit = root.elementFromPoint(x, y);
  if (!hit || !(el.contains(hit) || hit.contains(el))) return null;
  return { x, y };
})()`;

// Controls that may open a date picker, for a date step that finds no calendar: the plan's
// previous click may have closed a picker the page had opened by itself. Ranked by structure
// first: a date input, a field whose placeholder is a date format, a collapsed control that
// pops up a grid or dialog, a control whose name holds a date; date words only add weight.
// Pins them <pin>-open-<i>, best first, at most 3.
const DATE_OPENER = (pin) => `(() => {
  ${shownJs}
  const WORDS = /\\b(when|dates?|check[ -]?in|check[ -]?out|calendar|depart(ure|ing)?|arriv(e|al|ing)|return|pick[ -]?up|drop[ -]?off)\\b/i;
  const FORMAT = /\\b(mm|dd)\\s*[\\/.-]\\s*(dd|mm)\\b|\\byyyy\\b|\\bjj\\/mm\\b|\\btt\\.mm\\b/i;
  const DATEISH = /\\b\\d{1,2}[\\/.-]\\d{1,2}([\\/.-]\\d{2,4})?\\b|\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}\\b|\\badd dates?\\b/i;
  const nameOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.value || '').replace(/\\s+/g, ' ').trim();
  const scored = [];
  for (const el of document.querySelectorAll('[aria-expanded="false"],[role=tab][aria-selected="false"],input[type=date],input[placeholder],[aria-haspopup]')) {
    if (!shown(el) || el.closest('[data-cdp]') || el.disabled) continue;
    const name = nameOf(el), pop = (el.getAttribute('aria-haspopup') || '').toLowerCase();
    let sc = 0;
    if (el.matches('input[type=date]')) sc += 3;
    if (el.matches('input') && FORMAT.test(el.getAttribute('placeholder') || '')) sc += 3;
    if (pop === 'grid') sc += 2; else if (pop === 'dialog' || pop === 'true') sc += 1;
    if (DATEISH.test(name)) sc += 3;
    if (WORDS.test(name)) sc += 1;
    if (el.getAttribute('aria-expanded') !== 'false' && !el.matches('input')) sc -= 1; // already open, or no state to show
    if (sc >= 1) scored.push([sc, el, name]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, 3).map(([sc, el, name], i) => { el.setAttribute('data-bc-pin', ${JSON.stringify(pin)} + '-open-' + i); return { name: name.slice(0, 60), score: sc }; });
})()`;

// After a day is clicked: does the page show it chosen? The cell (or its cell or button)
// carries a selected state or a selected-like class, the same day redrawn does, its look
// changed, a date field or button now shows the date, or a new line of text outside the
// calendar does ("Check-in: Thu, Oct 17"), in any format, with or without the year. A
// calendar that ignored the click shows none of these. DATE_LOOK records the before.
const DATE_COMMON = (selector, iso) => `
  const want = ${JSON.stringify(iso)};
  const parse =${parseDateText.toString().replace(/^function parseDateText/, 'function')};
  const MONTHS = ${JSON.stringify(MONTHS)};
  const [y, m, d] = want.split('-').map(Number);
  const isoOf = (x) => x && x.y + '-' + String(x.m).padStart(2, '0') + '-' + String(x.d).padStart(2, '0');
  const shows = (t) => {
    t = String(t || '');
    if (!/\\d/.test(t)) return false;
    for (const part of t.split(/\\s[-–—]\\s|\\s+to\\s+|\\|/)) if (isoOf(parse(part)) === want) return true;
    const low = t.toLowerCase();
    if (new RegExp('\\\\b' + MONTHS[m - 1] + '[a-z]*\\\\.?\\\\s+0?' + d + '(?!\\\\d)|(?<!\\\\d)0?' + d + '\\\\s+' + MONTHS[m - 1]).test(low)) return true;
    return new RegExp('(?<![\\\\d/])0?' + m + '/0?' + d + '(?![\\\\d])').test(low);
  };
  const cell = ${deepQuery(selector)};
  const dated = (n) => /\\d/.test((n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('data-date') || '')) || '');
  let cal = null;
  for (let n = cell && cell.isConnected ? cell.parentElement : null; n && n !== document.body; n = n.parentElement) {
    const k = [...n.querySelectorAll('[aria-label],[data-date],button,td')].filter(dated).length;
    if (k >= 7 || n.matches('table,[role=grid]')) { cal = n; if (k >= 20) break; }
  }
  const outside = (el) => !(cal && cal.contains(el)) && !el.closest('table,[role=grid],[data-cdp]');
  const seen = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden'; };
  // Short lines of text outside the calendar that show the date: leaf-ish blocks only.
  const lines = () => [...document.querySelectorAll('p,span,div,li,dd,dt,label,strong,b,h1,h2,h3,h4,h5,h6,small')]
    .filter(el => outside(el) && el.children.length <= 3 && seen(el)).map(el => (el.innerText || '').replace(/\\s+/g, ' ').trim())
    .filter(t => t && t.length <= 120 && shows(t)).length;
  const lookOf = (el) => { const s = getComputedStyle(el), c = el.closest('td,[role=gridcell]'), cs = c ? getComputedStyle(c) : null; return [s.backgroundColor, s.color, s.fontWeight, cs && cs.backgroundColor, cs && cs.color].join('|'); };
`;
const DATE_LOOK = (selector, iso) => `(() => {
  ${DATE_COMMON(selector, iso)}
  if (!cell) return null;
  return { look: lookOf(cell), lines: lines() };
})()`;
const DATE_SHOWN = (selector, iso, before) => `(() => {
  ${DATE_COMMON(selector, iso)}
  const before = ${JSON.stringify(before || null)};
  const ON = /(^|[-_\\s])(is-)?(selected|active|chosen|picked|checked|current|start|end|range-(start|end)|in-range|highlighted)([-_\\s]|$)/i;
  const chosen = (el) => {
    if (!el) return false;
    for (const a of ['aria-selected', 'aria-pressed', 'aria-checked']) if (el.getAttribute(a) === 'true') return true;
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') return true;
    const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    if (ON.test(cls)) return true;
    return /\\bselected\\b/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || ''));
  };
  const around = (el) => [el, el && el.parentElement, el && el.closest('td,[role=gridcell],[role=option]'), el && el.querySelector('button,[role=button],[aria-selected],[aria-pressed]')];
  if (cell && cell.isConnected) {
    if (around(cell).some(chosen)) return { shown: 'cell' };
    if (before && before.look && lookOf(cell) !== before.look) return { shown: 'look' };
  }
  // The calendar redrew: the same day, found again.
  for (const el of document.querySelectorAll('[aria-label],[data-date],[datetime],[title]')) {
    if (el === cell) continue;
    const label = [el.getAttribute('aria-label'), el.getAttribute('data-date'), el.getAttribute('datetime'), el.getAttribute('title')].filter(Boolean).join(' | ');
    if (!/\\d/.test(label)) continue;
    let hit = false;
    for (const part of label.split(' | ')) if (isoOf(parse(part)) === want) { hit = true; break; }
    if (hit && around(el).some(chosen)) return { shown: 'cell' };
  }
  // A field or the control that opened the picker shows the date.
  for (const el of document.querySelectorAll('input,textarea,[role=combobox],[role=textbox],button,[aria-haspopup],[aria-expanded],output,time')) {
    if (!outside(el)) continue;
    const t = el.matches('input,textarea') ? el.value : (el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '');
    if (shows(t)) return { shown: 'field' };
  }
  // A new line of text that shows it.
  if (before && lines() > before.lines) return { shown: 'text' };
  return { shown: null, cell: !!(cell && cell.isConnected) };
})()`;

// ------------------------------------------------------------ sliders ----
// Every slider on the page, grouped: a thumb is a native range input or a role=slider; two
// or more thumbs under one close ancestor form a range ("Price" with Minimum and Maximum).
// Names come from aria-label, aria-labelledby, a <label>, a fieldset legend or group label,
// or the nearest line of text before the control. Thumbs are pinned <pin>-g<i>-t<j>.
// With `only` (a pinned selector), just the group that holds that element.
const SLIDER_FIND = (pin, only) => `(() => {
  ${shownJs}
  const pin = ${JSON.stringify(pin)}, only = ${JSON.stringify(only || null)};
  for (const old of document.querySelectorAll('[data-bc-pin^="' + pin + '-g"]')) old.removeAttribute('data-bc-pin');
  const txt = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\\s+/g, ' ').trim();
  const byIds = (ids) => (ids || '').split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean).map(txt).join(' ').trim();
  const thumbs = [...document.querySelectorAll('input[type=range],[role=slider]')].filter(el => !el.closest('[data-cdp]') && (shown(el) || (el.matches('input') && el.parentElement && shown(el.parentElement))));
  const own = (el) => el.getAttribute('aria-label') || byIds(el.getAttribute('aria-labelledby')) || (el.labels && el.labels[0] && txt(el.labels[0])) || el.getAttribute('title') || '';
  // The text a person reads next to a control: the closest preceding line that is not a number.
  const before = (el) => {
    for (let n = el, i = 0; n && n !== document.body && i < 4; n = n.parentElement, i++) {
      for (let p = n.previousElementSibling; p; p = p.previousElementSibling) {
        const t = txt(p).split(/\\n/)[0];
        if (t && /[A-Za-z\\u00C0-\\uFFFF]{2}/.test(t) && t.length <= 60) return t;
      }
    }
    return '';
  };
  const groupOf = (el) => {
    for (let n = el.parentElement, i = 0; n && n !== document.body && i < 4; n = n.parentElement, i++) {
      const inside = thumbs.filter(t => n.contains(t));
      if (inside.length > 1) return n;
    }
    return null;
  };
  const labelOfGroup = (g, first) => {
    if (!g) return '';
    const legend = g.matches('fieldset') ? g.querySelector(':scope > legend') : null;
    return g.getAttribute('aria-label') || byIds(g.getAttribute('aria-labelledby')) || (legend && txt(legend)) || before(g) || before(first);
  };
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const stateOf = (el) => {
    const native = el.matches('input[type=range]');
    const min = native ? num(el.min || 0) : num(el.getAttribute('aria-valuemin'));
    const max = native ? num(el.max || 100) : num(el.getAttribute('aria-valuemax'));
    let now = native ? num(el.value) : num(el.getAttribute('aria-valuenow'));
    const text = el.getAttribute('aria-valuetext') || '';
    if (Number.isNaN(now) && text) { const m = text.replace(/(\\d),(?=\\d{3}\\b)/g, '$1').match(/-?\\d+(\\.\\d+)?/); if (m) now = Number(m[0]); }
    const step = native ? (el.step === 'any' ? 0 : num(el.step || 1)) : NaN;
    return { native, min, max, now, step, text, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' };
  };
  const groups = [], seen = new Set();
  for (const t of thumbs) {
    if (seen.has(t)) continue;
    const g = groupOf(t);
    const members = g ? thumbs.filter(x => g.contains(x)) : [t];
    members.forEach(x => seen.add(x));
    groups.push({ g, members });
  }
  const out = [];
  groups.forEach(({ g, members }, i) => {
    if (only && !members.some(m => m.matches(only))) return;
    out.push({
      label: (members.length > 1 ? labelOfGroup(g, members[0]) : (own(members[0]) || before(members[0]))).slice(0, 80),
      thumbs: members.map((m, j) => { const key = pin + '-g' + i + '-t' + j; m.setAttribute('data-bc-pin', key); return { selector: '[data-bc-pin="' + key + '"]', name: own(m).slice(0, 60), only: !!(only && m.matches(only)), ...stateOf(m) }; }),
    });
  });
  return out;
})()`;
const SLIDER_STATE = (selector) => `(() => {
  const el = ${deepQuery(selector)};
  if (!el || !el.isConnected) return null;
  const native = el.matches('input[type=range]');
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  let now = native ? num(el.value) : num(el.getAttribute('aria-valuenow'));
  const text = el.getAttribute('aria-valuetext') || '';
  if (Number.isNaN(now) && text) { const m = text.replace(/(\\d),(?=\\d{3}\\b)/g, '$1').match(/-?\\d+(\\.\\d+)?/); if (m) now = Number(m[0]); }
  const r = el.getBoundingClientRect();
  // The track: the nearest ancestor clearly wider than the thumb.
  let track = el.parentElement;
  while (track && track !== document.body && track.getBoundingClientRect().width < Math.max(r.width * 3, 40)) track = track.parentElement;
  const tr = track ? track.getBoundingClientRect() : r;
  const min = native ? num(el.min || 0) : num(el.getAttribute('aria-valuemin'));
  const max = native ? num(el.max || 100) : num(el.getAttribute('aria-valuemax'));
  return { now, min, max, native, x: r.left + r.width / 2, y: r.top + r.height / 2, track: { left: tr.left, width: tr.width }, focused: document.activeElement === el };
})()`;
// A native range input takes a value the way a person's drag would leave it: through the
// value setter React and other frameworks watch, then input and change events.
const SLIDER_SET_NATIVE = (selector, value) => `(() => {
  const el = ${deepQuery(selector)};
  if (!el) return null;
  el.focus();
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, String(${JSON.stringify(value)}));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return Number(el.value);
})()`;
const FOCUS = (selector) => `(() => { const el = ${deepQuery(selector)}; if (!el) return false; el.focus(); return document.activeElement === el; })()`;

// Refs come from the caller's last read; the plan's own reads replace them, so they are
// pinned before the first one.
const PIN_REFS = (pins) => `(() => {
  ${REFIND_FN}
  const els = (window.__cdp && window.__cdp.els) || [];
  const sigs = window.__bcPinSig || (window.__bcPinSig = {});
  return ${JSON.stringify(pins)}.map(([ref, key]) => {
    let el = els[parseInt(ref.replace('ref_', ''), 10) - 1];
    if (!el) return window.__cdp ? 'unknown' : 'no_snapshot';
    // Redrawn since the read: the one copy on screen that matches it (see REFIND_FN).
    if (!el.isConnected) { el = bcRefind(bcSig(el)); if (!el) return 'detached'; }
    el.setAttribute('data-bc-pin', key);
    sigs[key] = bcSig(el); // to find it again if the page redraws it during the plan
    return 'ok';
  });
})()`;

// Scroll an items id's element to near the top of the screen (under any sticky header).
const SCROLL_TO_ITEM = (id) => `(() => {
  const ids = window.__bcItems && window.__bcItems.ids;
  if (!ids) return false;
  let el = null;
  for (const n of document.querySelectorAll('body *')) if (ids.get(n) === ${JSON.stringify(id)}) { el = n; break; }
  if (!el) return false;
  el.scrollIntoView({ block: 'start', behavior: 'instant' });
  scrollBy(0, -Math.min(160, innerHeight * 0.2));
  return true;
})()`;

// Find a direct target now: a pinned ref, an item id from items, a CSS selector, or an
// option of an open listbox whose text is the target. A list item is clicked through its
// first link or button. Returns info() plus the selector, or { error }.
const FIND_DIRECT = (kind, value, key, action) => `(() => {
  ${ELEMENT_INFO}
  ${shownJs}
  const kind = ${JSON.stringify(kind)}, value = ${JSON.stringify(value)}, key = ${JSON.stringify(key)}, action = ${JSON.stringify(action)};
  let el = null;
  if (kind === 'pin') {
    el = document.querySelector('[data-bc-pin="' + value + '"]');
    // The page redrew the pinned control during the plan: the one matching copy on screen.
    if (!el) { ${REFIND_FN}; el = bcRefind((window.__bcPinSig || {})[value]); }
  }
  else if (kind === 'item') {
    const ids = window.__bcItems && window.__bcItems.ids;
    if (!ids) return { error: 'no_items' };
    for (const n of document.querySelectorAll('body *')) if (ids.get(n) === value) { el = n; break; }
    if (el && action === 'click' && !el.matches('a[href],button,[role=button],[role=link]')) el = [...el.querySelectorAll('a[href],button,[role=button],[role=link]')].find(shown) || el;
  } else if (kind === 'selector') {
    let all;
    try { all = [...document.querySelectorAll(value)]; } catch (e) { return { error: 'invalid' }; }
    el = all.find(shown) || all[0] || null;
  } else if (kind === 'option') {
    const want = value.toLowerCase().replace(/\\s+/g, ' ').trim();
    for (const o of document.querySelectorAll('[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],li[data-value],[data-value][tabindex]')) {
      if (!shown(o) || o.closest('[data-cdp]')) continue;
      const t = (o.getAttribute('aria-label') || o.innerText || o.getAttribute('data-value') || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      if (t === want) { el = o; break; }
    }
  }
  if (!el) return { error: 'none' };
  if (!el.isConnected) return { error: 'detached' };
  el.setAttribute('data-bc-pin', key);
  return { ...info(el), selector: '[data-bc-pin="' + key + '"]', shown: shown(el) };
})()`;

// Icon buttons with no name ("+", "−" next to "Children") get one from their row, so a plan
// can say "Increase Children" and an exact match or Jev can find it.
const NAME_UNNAMED = (refs) => `(() => {
  const els = (window.__cdp && window.__cdp.els) || [];
  const out = {};
  for (const ref of ${JSON.stringify(refs)}) {
    const el = els[parseInt(ref.replace('ref_', ''), 10) - 1];
    if (!el || !el.isConnected) continue;
    const hint = ((el.innerText || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('data-testid') || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' + [...el.querySelectorAll('svg title, svg use, [class], [data-icon]')].slice(0, 4).map(n => (n.textContent || '') + ' ' + (n.getAttribute('href') || n.getAttribute('xlink:href') || '') + ' ' + (n.getAttribute('class') || '') + ' ' + (n.getAttribute('data-icon') || '')).join(' ')).toLowerCase();
    const own = (el.innerText || '').trim();
    if (!own && /(^|[\\s_-])(close|closer|dismiss|cancel)([\\s_-]|btn|button|icon|$)|(^|[\\s_-])x-?mark|modal-x|icon-x([\\s_-]|$)/i.test(hint)) { out[ref] = 'Close'; continue; }
    const verb = own === '+' ? 'Increase' : /^[-−–]$/.test(own) ? 'Decrease'
      : /\\+|plus|increase|increment|\\badd\\b/.test(hint) ? 'Increase' : /−|–|minus|decrease|decrement|subtract/.test(hint) ? 'Decrease' : null;
    // The nearest ancestor with words of its own names the row: "Children Ages 0-17".
    let label = '';
    for (let n = el.parentElement, i = 0; n && i < 4 && !label; n = n.parentElement, i++) {
      const t = (n.innerText || '').split('\\n').map(s => s.replace(/[+−–\\-\\d]/g, '').trim()).find(s => /[A-Za-z]{3,}/.test(s));
      if (t) label = t.slice(0, 40);
    }
    if (label || verb) out[ref] = verb ? verb + ' ' + (label || 'value') : label;
  }
  return out;
})()`;

// A button that only opens an ordering or booking flow ("Order now", "Book now", "Reserve a
// table", "Start an order"): it commits nothing until the page is a checkout. The checkout is
// read from structure first (card fields, a payment provider's frame, an amount to pay), and
// from words only as a fallback.
const ORDER_ENTRY = /^\s*((order|book|reserve|rent|hire)\s+(now|online|here|ahead|today|instantly|a table|a ride|a room|tickets?)|(start|begin|create|new)\s+(an?\s+|your\s+|a\s+new\s+|new\s+)*(order|booking|reservation|cart|basket))(\s+(at|from|for|with|in)\s.*)?\s*$/i;
const CHECKOUT_STATE = `(() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden'; };
  const fields = 'input[autocomplete^="cc-"],input[autocomplete="transaction-amount"],input[name*="card" i],input[id*="card" i],input[name*="cvc" i],input[name*="cvv" i],input[name*="iban" i],input[name*="expir" i]';
  if ([...document.querySelectorAll(fields)].some(shown)) return true;
  if ([...document.querySelectorAll('iframe[src]')].some(f => shown(f) && /pay|checkout|stripe|braintree|adyen|klarna|afterpay|square|recurly|chargebee|worldpay|cybersource|authorize\\.net/i.test(f.src))) return true;
  // The page's own text, not the labels of its buttons and links: a "Complete purchase"
  // button on a product page is not a checkout.
  let text = document.body.innerText || '';
  for (const b of document.querySelectorAll('button,a,[role=button],[role=link],input[type=submit]')) { const t = (b.innerText || b.value || '').trim(); if (t) text = text.split(t).join(' '); }
  return /\\b(order total|subtotal|amount due|total due|total to pay|card number|payment method|billing address|place (your )?order|pay now|complete (your )?(purchase|order|booking))\\b/i.test(text);
})()`;

// The heading or label of the row each element sits in: two "Edit" buttons differ by
// whether they sit under "Start time" or "End time".
const NEAR_CONTEXT = (refs) => `(() => {
  const els = (window.__cdp && window.__cdp.els) || [];
  const out = {};
  for (const ref of ${JSON.stringify(refs)}) {
    const el = els[parseInt(ref.replace('ref_', ''), 10) - 1];
    if (!el || !el.isConnected) continue;
    const own = (el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    for (let n = el.parentElement, i = 0; n && n !== document.body && i < 5; n = n.parentElement, i++) {
      const line = (n.innerText || '').split(/\\n+/).map(t => t.replace(/\\s+/g, ' ').trim()).find(t => t && t !== own && /[A-Za-z]{2}/.test(t) && t.length <= 60);
      if (line) { out[ref] = line; break; }
    }
  }
  return out;
})()`;

// Whether what a click should open or close is open: a <summary>'s <details>, or a control's
// aria-expanded. A web component's own control in its shadow root counts for its host and for
// content slotted into it (an accordion's heading). activate: click that control directly.
const DISCLOSURE_STATE = (selector, activate = false) => `(() => {
  const el = ${deepQuery(selector)};
  if (!el || !el.isConnected) return null;
  const CTL = 'summary,[aria-expanded]';
  let ctl = el.matches(CTL) ? el : el.closest(CTL);
  if (!ctl && el.shadowRoot) ctl = el.shadowRoot.querySelector(CTL);
  if (!ctl && el.assignedSlot) {
    const slot = el.assignedSlot, host = (slot.getRootNode() || {}).host;
    ctl = slot.closest(CTL) || (host && host.shadowRoot && host.shadowRoot.querySelector(CTL));
  }
  if (!ctl) return null;
  const read = () => ctl.tagName === 'SUMMARY' ? !!(ctl.parentElement && ctl.parentElement.open) : ctl.getAttribute('aria-expanded') === 'true';
  if (${activate}) ctl.click();
  return read();
})()`;

const CHECKED_STATE = (selector) => `(() => {
  ${ELEMENT_INFO}
  const el = ${deepQuery(selector)};
  return el && el.isConnected ? info(el).checked : null;
})()`;

// Signs that the page refused what the step sent: an "Error" title, an alert with error
// words, or a field marked invalid.
const ERROR_STATE = `(() => {
  ${shownJs}
  // A message a field points to (aria-errormessage, aria-describedby) is that field's error in
  // any language; other alerts count when they read as one.
  const pointed = new Set();
  for (const f of document.querySelectorAll('input,select,textarea,[role=textbox],[role=combobox],[role=spinbutton]')) for (const a of ['aria-errormessage', 'aria-describedby']) for (const id of (f.getAttribute(a) || '').split(/\\s+/)) if (id) pointed.add(id);
  const alerts = [...document.querySelectorAll('[role=alert],.error-summary,[class*=error-summary i],[aria-live=assertive]')]
    .filter(el => shown(el) && !el.closest('[data-cdp]')).map(el => [el, (el.innerText || '').replace(/\\s+/g, ' ').trim()])
    .filter(([el, t]) => t && t.length < 400 && ((el.id && pointed.has(el.id)) || /error|invalid|required|must|problem|please (enter|select|choose|provide)|try again|went wrong|cannot|can't be/i.test(t))).map(([, t]) => t);
  const invalid = [...document.querySelectorAll('[aria-invalid=true]')].filter(shown).map(el => (el.getAttribute('aria-label') || el.name || el.id || el.tagName).toString().slice(0, 40));
  return { title: document.title, alerts: alerts.slice(0, 3), invalid: invalid.slice(0, 5) };
})()`;
export function newError(before, after) {
  if (!after) return null;
  const was = before || { title: '', alerts: [], invalid: [] };
  const titled = /\berror\b/i.test(after.title) && !/\berror\b/i.test(was.title);
  const alerts = after.alerts.filter(a => !was.alerts.includes(a));
  const invalid = after.invalid.filter(f => !was.invalid.includes(f));
  if (!titled && !alerts.length && !invalid.length) return null;
  return [titled ? `title "${clip(after.title, 80)}"` : null, alerts.length ? `"${clip(alerts[0], 160)}"` : null, invalid.length ? `invalid field${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}` : null].filter(Boolean).join('; ');
}

let pinSeq = 0;
const pinKey = () => `bc${Date.now().toString(36)}${(++pinSeq).toString(36)}`;

// Wait until the DOM has been quiet for a moment, so the next step sees the result.
// Counts fetch and XHR requests in flight, once per document. Requests a step starts are
// seen because the previous settle installed it. (Resource timing entries only appear when
// a request ends, and stop at a full buffer on long-lived apps such as dashboards.)
const NET_WATCH = `(() => {
  if (window.__bcNet) return;
  // Requests open longer than 3 s are long polls or streams, not a pending render.
  const open = new Map(); let n = 0;
  const net = window.__bcNet = { last: Date.now(), busy: (since) => { const t = Date.now(); for (const s of open.values()) if (s >= since && t - s < 3000) return true; return false; } };
  const start = () => { const id = ++n; open.set(id, Date.now()); net.last = Date.now(); return id; };
  const end = (id) => { open.delete(id); net.last = Date.now(); };
  const f = window.fetch;
  // keepalive and no-cors fetches are fire-and-forget (analytics, pixels): nothing renders from them.
  const detached = (init) => !!(init && (init.keepalive || init.mode === 'no-cors'));
  if (f) window.fetch = function (input, init) {
    if (detached(init) || (input && typeof input === 'object' && detached(input))) return f.apply(this, arguments);
    const id = start(); return f.apply(this, arguments).finally(() => end(id));
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () { const id = start(); this.addEventListener('loadend', () => end(id), { once: true }); return send.apply(this, arguments); };
})()`;

// The page records when it last changed; the polling happens from here, because timers
// inside a background tab are throttled (to once a second or once a minute).
const SETTLE_WATCH = `(() => {
  ${NET_WATCH};
  const old = window.__bcSettle; if (old && old.mo) old.mo.disconnect();
  const st = window.__bcSettle = { last: Date.now(), start: Date.now() };
  // Changes to browserctrl's own overlay (--show cursor, labels, ticking panel) are not the page.
  const ours = (n) => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return !!(e && e.closest && e.closest('[data-cdp]')); };
  // A style-only change is an animation or a transition (carousels, tickers rewrite it many times a
  // second); results arriving add or remove nodes, change text, or change classes.
  // A node that keeps changing (a carousel's slides trading an "active" class, a countdown, a
  // ticker) is animating, not loading: after its third change it no longer holds the wait.
  const seen = new WeakMap();
  const repeating = (n) => { const c = (seen.get(n) || 0) + 1; seen.set(n, c); return c > 3; };
  st.mo = new MutationObserver((recs) => {
    if (recs.some(r => !(r.type === 'attributes' && r.attributeName === 'style') && !ours(r.target) && !(r.addedNodes.length && [...r.addedNodes].every(ours)) && !(r.removedNodes.length && [...r.removedNodes].every(x => x.nodeType === 1 && x.hasAttribute && x.hasAttribute('data-cdp'))) && !repeating(r.target))) st.last = Date.now();
  });
  st.mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  return true;
})()`;
// Requests started since the step hold the wait for at most 2.5 s (apps poll in the background).
const SETTLE_STATE = `(() => {
  const st = window.__bcSettle; if (!st) return null;
  const now = Date.now();
  return { quiet: now - st.last, age: now - st.start, ready: document.readyState, busy: !!(window.__bcNet && window.__bcNet.busy(st.start - 300)) };
})()`;
const SETTLE_END = `(() => { const st = window.__bcSettle; if (st && st.mo) st.mo.disconnect(); window.__bcSettle = null; })()`;

// How a step changed the address: "+state=closed -page". Path changes show the new path.
export function urlChange(before, after) {
  let a, b;
  try { a = new URL(before); b = new URL(after); } catch { return null; }
  if (a.href === b.href) return null;
  const out = [];
  const path = (u) => u.origin + u.pathname.replace(/\/+$/, '');
  if (path(a) !== path(b)) out.push(`→ ${b.origin === a.origin ? b.pathname : b.origin + b.pathname}`);
  for (const [k, v] of b.searchParams) if (a.searchParams.get(k) !== v) out.push(`+${k}=${v}`);
  for (const k of new Set(a.searchParams.keys())) if (!b.searchParams.has(k)) out.push(`-${k}`);
  return out.length ? out.join(' ').slice(0, 200) : null;
}

// The address parameters this page uses, read from the page itself: its own query, forms
// that submit by GET, and links to the same path with a query (sort, filter, page links).
// A filter the page keeps in its address can then be set with one nav step.
export const PAGE_PARAMS = `(() => {
  const here = new URL(location.href), seen = new Map();
  const add = (k, v, src) => {
    if (!k || k.length > 40 || /^(utm_|fbclid|gclid|_)/i.test(k)) return;
    const e = seen.get(k) || { values: new Set(), src: new Set() };
    if (v != null && v !== '' && String(v).length < 40) e.values.add(String(v));
    e.src.add(src); seen.set(k, e);
  };
  for (const [k, v] of here.searchParams) add(k, v, 'url');
  for (const f of document.querySelectorAll('form')) {
    if ((f.getAttribute('method') || 'get').toLowerCase() !== 'get') continue;
    for (const el of f.querySelectorAll('input[name],select[name]')) if (!/^(hidden|submit|button|password)$/i.test(el.type)) add(el.name, el.value, 'form');
  }
  let links = 0;
  for (const a of document.querySelectorAll('a[href*="?"]')) {
    if (links > 400) break;
    let u; try { u = new URL(a.href); } catch { continue; }
    const trim = (p) => p.replace(/\\/+$/, '');
    if (u.origin !== here.origin || trim(u.pathname) !== trim(here.pathname)) continue;
    links++;
    for (const [k, v] of u.searchParams) add(k, v, 'link');
  }
  return [...seen].map(([k, e]) => ({ name: k, values: [...e.values].slice(0, 4), from: [...e.src] }))
    .sort((x, y) => y.from.length - x.from.length || y.values.length - x.values.length).slice(0, 10);
})()`;

// What is on screen (jev.VIEW_TEXT) plus short notices outside overlays: alerts, status and
// live regions, toasts and banners. Bounded: at most 20 notices of 200 characters.
const PAGE_STATE = `(() => {
  const v = ${jev.VIEW_TEXT};
  ${jev.IN_OVERLAY}
  const sel = '[role=alert],[role=status],[aria-live]:not([aria-live=off]),[class*=toast i],[class*=snackbar i],[class*=notice i],[class*=notification i],[class*=alert i],[class*=banner i],[class*=flash i]';
  const taken = [], notices = [];
  const nodes = document.querySelectorAll(sel);
  for (let i = 0; i < nodes.length && i < 300 && notices.length < 20; i++) {
    const el = nodes[i];
    if (taken.some(t => t.contains(el)) || el.closest('[data-cdp]')) continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') < 0.05) continue;
    if (inOverlay(el)) continue;
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!t || t.length > 300) continue;
    taken.push(el);
    if (!notices.includes(t.slice(0, 200))) notices.push(t.slice(0, 200));
  }
  v.notices = notices;
  return v;
})()`;

// Inline messages a step can cause without any notice container.
const NOTICE_WORDS = /\b(out of stock|sold out|unavailable|no longer available|price (has )?changed|did you mean|showing results for|voucher|coupon|added to (cart|bag|basket)|only \d+ left|limited stock|something went wrong|try again|failed)\b/i;

function newNotices(before, after) {
  const had = new Set([...(before.notices || []), ...lines(before)]);
  const out = [];
  for (const t of after.notices || []) if (!had.has(t)) out.push(t);
  for (const l of lines(after)) if (!had.has(l) && l.length <= 200 && NOTICE_WORDS.test(l) && !out.some(o => o.includes(l) || l.includes(o))) out.push(l);
  return out.slice(0, 5);
}
const lines = (v) => `${v.overlay || ''}\n${v.view || ''}`.split('\n').map(s => s.trim()).filter(Boolean);

// Controls that are fine for closing an overlay. Anything that commits, signs up, installs
// or buys is never offered; links only when they read as "close" or "not now".
const DISMISS_UNSAFE = /\b(subscribe|sign ?up|register|join|upgrade|start (a |your )?(free )?trial|get (the )?app|open (in )?(the )?app|install|download|allow|enable|continue|buy|pay|order|add to (cart|bag|basket)|claim|redeem|shop now|learn more|settings|preferences|customi[sz]e|manage)\b/i;
const CLOSE_WORDS = /^(close|dismiss|no,? thanks|not now|maybe later|later|skip|×|✕|x)$/i;
// What closes a notice or coachmark without choosing anything.
const DISMISS_WORDS = /^(got it|ok|okay|close|dismiss|done|no,? thanks|not now|maybe later|later|skip|understood|×|✕|x)$/i;
const NOT_CLICKY = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'select', 'listbox', 'checkbox', 'radio', 'file', 'switch', 'option']);
const safeToDismiss = (e) => !e.disabled && !e.hidden && !NOT_CLICKY.has(e.role) && (e.name || '').trim() &&
  !jev.commits(e.name, e) && !DISMISS_UNSAFE.test(e.name) && (e.role !== 'link' || CLOSE_WORDS.test(e.name.trim()));

const blockerQuestion = (next) => noul(
  `Is a dialog, overlay or popup (for example a cookie banner, sign-up or newsletter prompt, app-install prompt) covering the page and blocking it? ` +
  `Answer no when the dialog or panel is what the next step${next ? ` ("${next}")` : ''} works in, and no for small toasts or banners that leave the page usable.`);
const expectQuestion = (what) => noul(`Does the page show this: ${what}?`);

// When a step finds nothing, say what is there instead: a hidden element with that name
// (often opened by another control) and the controls on screen, so the caller can
// re-plan from this report rather than probing the page.
async function whatIsThere(conn, tab, step) {
  const out = {};
  try {
    const all = await ops.readPage(conn, tab, { maxText: 0, max: 600, includeHidden: true, all: true });
    const want = norm(step.target).split(' ').filter(w => w.length > 2);
    const hidden = all.elements.filter(e => e.hidden && want.some(w => norm(e.name).includes(w))).slice(0, 5);
    if (hidden.length) out.hidden = hidden.map(e => `${e.role} "${(e.name || '').slice(0, 50)}" (hidden or zero-size)`);
    const shown = await ops.readPage(conn, tab, { maxText: 0, max: 1500, all: true });
    // A cross-origin popup (marketing sign-up, chat) is an iframe whose text the overlay check
    // cannot see: many controls covered by an iframe is the sign.
    const underFrame = shown.elements.filter(e => !e.hidden && /^iframe\b/.test(String(e.covered || ''))).length;
    if (underFrame >= 5) out.covered = `${underFrame} controls are covered by an iframe, likely a sign-up or chat popup; close it (its close button, or key Escape), then re-plan`;
    // The target is there but something sits on it (a tooltip, a popover): say what.
    const under = shown.elements.filter(e => !e.hidden && e.covered && !e.coverPinned && want.some(w => norm(e.name).includes(w))).slice(0, 3);
    if (under.length && !out.covered) out.covered = under.map(e => `${describeEl(e)} is under ${e.covered}`).join('; ');
    // A dialog, popover or coachmark on top ("Now you'll see one price…", "Got it") makes
    // the rest of the page unreachable: name it and the harmless control that closes it.
    const top = shown.elements.filter(e => !e.hidden && e.modal);
    // Not when the target itself is in the dialog (Gym in Airbnb's Filters): closing it would
    // be the wrong advice.
    const targetInside = top.some(e => want.length && want.every(w => norm(e.name).includes(w)));
    if ((shown.modal || top.length) && !targetInside) {
      const closers = top.filter(e => safeToDismiss(e) && DISMISS_WORDS.test((e.name || '').trim()));
      const what = shown.modal ? `a ${shown.modal.role} "${clip(shown.modal.name, 60)}"` : 'a popup';
      out.onTop = `${what} is on top and the rest of the page waits behind it; ${closers.length ? `close it with click "${clip(closers[0].name, 30)}"${closers[1] ? ` (or click "${clip(closers[1].name, 30)}")` : ''}` : 'close it (its close control, or key Escape)'}, then run the step again (or start the plan with optional ${closers.length ? `click "${clip(closers[0].name, 30)}"` : 'key Escape'})`;
    }
    const roles = jev.candidatesFor(shown.elements, step.action === 'fill' ? 'fill' : 'click');
    const seen = new Set();
    out.controls = roles
      .map(e => `${e.role} "${(e.name || '').replace(/\s+/g, ' ').slice(0, 40)}"`)
      .filter(x => !x.endsWith('""') && !seen.has(x) && seen.add(x))
      .slice(0, 40);
  } catch {}
  return out;
}

// A click or Enter often starts a navigation a moment later; waiting on the old page's
// quiet DOM would hand the next step a page in transition. Give the navigation time to
// start, then wait for the current document to load and go quiet.
export async function settle(conn, tab, { quietMs = 300, maxMs = 4000 } = {}) {
  const t0 = Date.now();
  await new Promise(r => setTimeout(r, 150));
  const light = { timeoutMs: 3000 };
  let installed = await ops.evaluate(conn, tab, SETTLE_WATCH, light).catch(() => false);
  let deadline = maxMs;
  settle.why = 'changing';
  while (Date.now() - t0 < deadline) {
    const s = await ops.evaluate(conn, tab, SETTLE_STATE, light).catch(() => null);
    if (!s) { // a new document (navigation): give it time to load, then watch it
      deadline = Math.max(deadline, 12000);
      await ops.waitForReady(conn, tab, { timeoutMs: Math.max(1000, deadline - (Date.now() - t0)) }).catch(() => {});
      installed = await ops.evaluate(conn, tab, SETTLE_WATCH, light).catch(() => false);
      continue;
    }
    if (s.ready === 'complete' && s.quiet >= quietMs && !(s.busy && s.age < 2500)) { settle.why = 'quiet'; break; }
    // A page that never reports complete (endless trackers) is settled once it is quiet.
    if (s.ready === 'interactive' && s.quiet >= Math.max(quietMs, 600) && !s.busy && s.age > 800) { settle.why = 'quiet, never complete'; break; }
    settle.why = s.ready !== 'complete' ? 'loading' : s.busy ? 'request' : 'changing';
    await new Promise(r => setTimeout(r, 80));
  }
  if (settle.why !== 'quiet' && settle.why !== 'quiet, never complete') settle.why = `cap: ${settle.why}`;
  if (installed) await ops.evaluate(conn, tab, SETTLE_END, light).catch(() => {});
  return Date.now() - t0;
}

// A single-page app can sit quiet on its empty shell, then fill in section by section:
// wait until the page has text and its length holds for two reads (bounded).
// stable: false accepts the first read with enough text (a page that is already open).
export async function waitForContent(conn, tab, { timeoutMs = 15000, minChars = 200, stable = true } = {}) {
  let prev = -1;
  for (const t1 = Date.now(); Date.now() - t1 < timeoutMs;) {
    const s = await ops.evaluate(conn, tab, '({ n: (document.body && document.body.innerText || "").replace(/\\s+/g, " ").length, done: document.readyState === "complete" })').catch(() => ({ n: 0, done: false }));
    const n = s?.n ?? 0;
    if (n >= minChars && (n === prev || !stable)) return n;
    // A page that is short by design (a small form, a sign-in step) and has finished loading:
    // the same short text twice is the page, not a loading shell.
    if (s?.done && n > 0 && n === prev) return n;
    prev = n;
    await new Promise(r => setTimeout(r, 500));
    await settle(conn, tab, { maxMs: 1500 });
  }
  return prev;
}

// A challenge that appears mid-plan goes to the human (bounded wait) instead of
// failing the plan; with handoff: false the plan stops there. Returns null to
// carry on, or the reason to stop.
async function meetChallenge(conn, tab, row, { handoff, handoffMs }) {
  const found = await captcha.detect(conn, tab).catch(() => null);
  if (!found) return null;
  const href = await ops.evaluate(conn, tab, 'location.href', { timeoutMs: 3000 }).catch(() => null);
  if (href) ops.noteSiteTrouble(href, 'challenge');
  try {
    row.challenge = await captcha.solve(conn, tab, { timeoutMs: handoffMs, handoff });
    return null;
  } catch (e) {
    row.challenge = { captcha: found.kind, cleared: false };
    const trouble = href ? ops.siteTrouble(href) : null;
    return trouble ? `${e.message}. ${trouble}` : e.message;
  }
}

export function parseCategories(dismiss) {
  if (!dismiss || dismiss === true) return [];
  return (Array.isArray(dismiss) ? dismiss : String(dismiss).split(',')).map(s => String(s).trim()).filter(Boolean);
}

// Merge `items` reads across pages: ids reset on navigation and a re-rendered list can
// reuse nodes, so an item is the same when its link and text are.
// --show: the step list so far in the corner panel (lib/show.mjs).
async function hud(conn, tab, report, started, stopped) {
  const lines = report.steps.map(r => `${r.stopped ? '✗' : r.skipped ? '–' : r.unsure ? '⚠' : '✓'} ${r.step}. ${clip(r.do, 60)}${r.how ? `  (${r.how})` : ''}  ${r.ms != null ? `${(r.ms / 1000).toFixed(1)}s` : ''}`);
  await show.panel(conn, tab, { title: `browserctrl do  ${((Date.now() - started) / 1000).toFixed(1)}s${stopped ? '  — stopped' : ''}`, lines });
}

// Pagination collects the list being paged: on each page, the largest content group.
function mergeItems(acc, r, page) {
  const g = mainGroup(r);
  if (!g) return;
  let into = acc.groups[0];
  if (!into) acc.groups.push(into = { id: 'g1', region: g.region, heading: g.heading, label: g.label, items: [] });
  for (const it of g.items) {
    const k = `${(it.link || '').split('?')[0]}|${it.text}`;
    if (acc.seen.has(k)) { acc.duplicates++; continue; }
    acc.seen.add(k);
    into.items.push({ ...it, page });
  }
}

export async function runSteps(conn, tab, lines, opts = {}) {
  const {
    then, minP = 0.6, key: cfgIn, handoff = true, handoffMs = 300000, force = false,
    dismiss, repeat, until, max = 10, collect, jev: jevOpts = {}, traceRun = true, show: showOn = false,
    open: openN = 0, grep, context = 1, onStep,
  } = opts;
  const steps = lines.map(parseStep);
  const repeatStep = repeat ? parseStep(repeat) : null;
  if (repeatStep && !until) throw new Error('--repeat needs --until "<page condition>"');
  const categories = parseCategories(dismiss);
  // A plan that would navigate to a site that is cooling down is refused whole.
  for (const s of [...steps, repeatStep].filter(Boolean)) if (s.action === 'nav') cooldown.guard(s.target, { force, action: 'navigate to' });
  let cfg = cfgIn || jevOpts.cfg;
  const getCfg = () => (cfg ||= jev.jevKey());
  const fetchOpts = jevOpts.fetchImpl ? { fetchImpl: jevOpts.fetchImpl } : undefined;
  const report = { steps: [], events: [], ms: 0, jev_calls: 0 };
  // Recipes and flow notes for each kind of page a step lands on, once per run; the start
  // page was already hinted by the open, nav or read that came before.
  const hinted = new Set();
  const pageKind = (url) => { const t = notes.pathTemplate(url); return t ? `${notes.siteOfUrl(url)} ${t}` : null; };
  // The page's notes, read again only when the run reaches another kind of page.
  const useNotes = !opts.noNotes && notes.hinting();
  const noteCache = { kind: null, context: [], runnable: [] };
  const pageNotes = (url) => {
    if (!useNotes) return noteCache;
    const k = pageKind(url);
    if (k !== noteCache.kind) {
      noteCache.kind = k;
      try {
        noteCache.context = notes.forUrl(url, { max: 5 }).map(f => clip(f.text, 200));
        noteCache.runnable = notes.runnable(url);
      } catch { noteCache.context = []; noteCache.runnable = []; }
    }
    return noteCache;
  };
  const applied = new Map(); // note id -> ok, for confirm/contradict at the end
  const fired = new Map(); // on note id -> times run, so a situation that stays cannot loop
  // A note's steps, run as sub-steps of a row. An on note stops at the first step it cannot
  // do. A reveal note goes on past one: the page may already be part way there (Airbnb's
  // filters dialog was open, so "click Filters" had nothing to do but the next step did).
  // Returns { ok: every step acted, acted: how many did }.
  async function runNote(f, row, which) {
    const lines = (f.reveal || f.on).steps;
    let acted = 0;
    for (const [k, line] of lines.entries()) {
      const sub = { step: `${row.step}.${which}${k + 1}`, do: line };
      let r;
      try { r = await perform(parseStep(line), sub, { canSkip: false, inNote: true }); } catch (e) { r = { stop: { reason: e.message } }; }
      if (r.stop) {
        (row.note_steps ||= []).push({ do: line, stopped: r.stop.reason });
        if (f.on) return { ok: false, acted };
        continue;
      }
      if (r.acted) { acted++; await timed('settle', settle(conn, tab)); }
      (row.note_steps ||= []).push({ do: line, target: sub.target });
    }
    if (acted) view = await look();
    return { ok: acted === lines.length, acted };
  }
  const ask = async (state, questions) => {
    if (showOn) await show.busy(conn, tab, true, 'Jev is choosing');
    const r = await timed('jev', jev.systemOne(getCfg(), state, questions, fetchOpts));
    report.jev_calls++;
    return r;
  };
  const started = Date.now();
  // Where a run's time goes, by phase, for the trace (setup, reads, Jev, input, stop report, then).
  const phases = report.phases = {};
  // Sections this plan opened (accordions, expanders): a page that shows one at a time hides
  // the others, so a later step's target may be behind one we opened ourselves.
  const openedHere = [];
  const timed = async (name, p) => { const t = Date.now(); try { return await p; } finally { phases[name] = (phases[name] || 0) + Date.now() - t; } };
  const look = () => timed('read', ops.evaluate(conn, tab, PAGE_STATE));
  // Click by selector without scrolling when the element is already wholly in view.
  const clickSel = async (t) => {
    const at = t.selector ? await ops.evaluate(conn, tab, IN_VIEW_POINT(t.selector)).catch(() => null) : null;
    return ops.click(conn, tab, at || t);
  };
  // A background tab that does not render routes input by its last painted frame, so a
  // click can land on what used to be there. Keep it rendering without focusing it.
  await timed('setup', (async () => {
    await ops.wake(conn, tab).catch(() => {});
    await ops.evaluate(conn, tab, NET_WATCH).catch(() => {}); // so the first step's requests count
    await waitForContent(conn, tab, { timeoutMs: 10000, stable: false }); // a page still on its loading shell
  })());
  // Refs name elements of the caller's last read; pin them before this plan reads the page.
  const refSteps = steps.filter(s => s.ref);
  if (refSteps.length) {
    for (const s of refSteps) s.pin = pinKey();
    const st = await ops.evaluate(conn, tab, PIN_REFS(refSteps.map(s => [s.ref, s.pin]))).catch(() => []);
    refSteps.forEach((s, i) => { if (st?.[i] !== 'ok') s.pinError = st?.[i] || 'unknown'; });
  }
  let lastFilled = null; // the field the last fill typed into: "Submit" right after a search runs it
  const commitCtx = (snap) => ({ afterSearchFill: jev.searchField(lastFilled) || Boolean(snap?.elements?.some(e => e.role === 'searchbox' && e.value)) });

  // A target named directly: a pinned ref, an item id, a CSS selector. null when the step
  // has none (or a selector-like target matches nothing: then it is described to Jev).
  async function findDirect(step, snap) {
    const kind = step.pin ? 'pin' : step.item ? 'item' : step.selector ? 'selector' : null;
    if (!kind && !step.ref) return null;
    if (step.ref && (step.pinError || !step.pin)) return { stop: { reason: `${step.ref} is not on the page any more (${step.pinError || 'no snapshot'}); read the page again and use the new ref` } };
    const key = step.pin || pinKey();
    const r = await ops.evaluate(conn, tab, FIND_DIRECT(kind, step.pin || step.item || step.selector, key, step.action)).catch(e => ({ error: e.message }));
    if (r?.error) {
      if (kind === 'selector') return null;
      if (kind === 'item') return { stop: { reason: r.error === 'no_items' ? `${step.item} is an items id, but items has not run on this page; run items, then use its ids` : `${step.item} is not on the page any more; run items again` } };
      return { stop: { reason: `${step.ref} is not on the page any more (${r.error}); read the page again and use the new ref` } };
    }
    const fromSnap = r.ref && snap?.elements.find(e => e.ref === r.ref);
    const how = kind === 'pin' ? step.ref : kind === 'item' ? `item ${step.item}` : 'selector';
    return { el: { ...(fromSnap || { ...r, ref: null }), selector: r.selector }, how };
  }

  // A calendar day: find the cell for the date, paging months (up to 12) toward it.
  async function findDate(iso) {
    const pin = pinKey();
    let r, pages = 0, dir = null, waited = 0, opened = null;
    const tried = [];
    for (;;) {
      r = await timed('read', ops.evaluate(conn, tab, DATE_PAGE(iso, pin))).catch(() => null);
      if (!r) return { reason: 'Could not read the calendar' };
      if (r.hit) break;
      if (!r.count && !pages && waited < 2500) {
        // The picker the previous step opened may still be rendering: wait before giving up.
        await new Promise(res => setTimeout(res, 250));
        waited += 250;
        continue;
      }
      if (!r.count && tried.length < 3) {
        // Still no calendar: open the likeliest date control (the previous click may have
        // closed a picker the page had already opened), then look again. The candidates are
        // ranked afresh on the current page each time (a click can redraw it), one that
        // showed no calendar is closed with Escape, and the next untried one is opened.
        if (tried.length) await ops.key(conn, tab, 'Escape').catch(() => {});
        const list = (await ops.evaluate(conn, tab, DATE_OPENER(pin)).catch(() => null)) || [];
        const i = list.findIndex(o => !tried.includes(o.name));
        if (i >= 0) {
          tried.push(list[i].name);
          const ok = await timed('input', clickSel({ selector: `[data-bc-pin="${pin}-open-${i}"]` })).then(() => true, () => false);
          if (ok) await timed('settle', settle(conn, tab, { quietMs: 250, maxMs: 2000 }));
          opened = list[i].name;
          waited = 2500 - 750; // a short wait for the picker to draw
          continue;
        }
      }
      if (!r.count && tried.length && opened !== true) { await ops.key(conn, tab, 'Escape').catch(() => {}); opened = true; }
      if (!r.count) return { reason: `No calendar dates are on screen${tried.length ? ` (opening ${tried.map(n => `"${clip(n, 30)}"`).join(', ')} showed none)` : ''}; open the date picker first, then date ${iso}`, noCalendar: true };
      if (r.first && r.last && iso >= r.first && iso <= r.last) return { reason: `${iso} is between the dates shown (${r.first} to ${r.last}) but has no day cell of its own` };
      dir ||= r.first && iso < r.first ? 'prev' : 'next';
      if (pages >= 12 || !r.arrows[dir]) return { reason: `${iso} is not in the calendar (it shows ${r.first} to ${r.last}) and ${pages >= 12 ? '12 months were paged' : `there is no ${dir === 'next' ? 'next' : 'previous'}-month control`}` };
      await timed('input', clickSel({ selector: `[data-bc-pin="${pin}-${dir}"]` }));
      pages++;
      await timed('settle', settle(conn, tab, { quietMs: 250, maxMs: 2000 }));
    }
    if (r.hit.disabled) return { reason: `${iso} is in the calendar but not available ("${clip(r.hit.label, 60)}")` };
    return { el: { ref: null, role: 'button', name: r.hit.label, selector: `[data-bc-pin="${pin}-day"]` }, how: `date${typeof opened === 'string' ? `, opened "${clip(opened, 40)}" first` : ''}${pages ? `, paged ${pages} month${pages > 1 ? 's' : ''}` : ''}` };
  }

  // ---------------------------------------------------------- sliders ----
  // The slider (or range) a step names: by its own or its group's words, or directly by ref
  // or selector. score is the share of the step's words found (1 = all of them).
  async function matchSlider(step) {
    const pin = pinKey();
    let only = null;
    if (step.ref || step.item || step.selector) {
      const d = await findDirect(step, null);
      if (d?.stop) return d;
      only = d?.el?.selector || null;
      if (!only) return null;
    }
    const groups = await ops.evaluate(conn, tab, SLIDER_FIND(pin, only)).catch(() => []);
    if (!groups?.length) return null;
    if (only) return { group: groups[0], score: 1, direct: true };
    const want = norm(step.target).split(' ').filter(w => w.length > 1);
    const share = (text) => { const have = norm(text); return want.length ? want.filter(w => have.includes(w)).length / want.length : 0; };
    let best = null;
    for (const g of groups) {
      const sc = share(`${g.label} ${g.thumbs.map(t => t.name).join(' ')}`);
      // One end of a range named on its own ("Maximum price"): the step's words fit exactly one
      // end. When every end carries them ("$50, Minimum, Nightly price" and "$400, Maximum,
      // Nightly price"), the step names the whole range.
      const fits = g.thumbs.filter(t => share(t.name) === 1);
      const thumb = g.thumbs.length > 1 && fits.length === 1 && share(g.label) < 1 ? fits[0] : null;
      const exact = norm(g.label) === norm(step.target) || g.thumbs.some(t => norm(t.name) === norm(step.target));
      if (!best || sc > best.score) best = { group: g, score: sc, thumb, exact };
    }
    if (best.score === 0) return groups.length === 1 ? { group: groups[0], score: 0, unsure: true, all: groups } : { none: true, all: groups };
    return { ...best, all: groups };
  }

  // Move one thumb to v: its value (native), then keys, then a drag along its track. Returns
  // where it ended and how, or { stuck }.
  async function moveThumb(th, v) {
    const read = () => ops.evaluate(conn, tab, SLIDER_STATE(th.selector)).catch(() => null);
    let st = await read();
    if (!st) return { stuck: NaN, why: 'the slider left the page' };
    // Limits now, not when the slider was found: the ends of a range often bound each other
    // (the minimum's max is the maximum's value), so moving one end changes the other's.
    if (Number.isFinite(st.min)) th.min = st.min;
    if (Number.isFinite(st.max)) th.max = st.max;
    const lim = (x) => Math.min(Number.isFinite(th.max) ? th.max : x, Math.max(Number.isFinite(th.min) ? th.min : x, x));
    const goal = lim(v);
    let unit = th.step > 0 ? th.step : 0;
    const close = (now) => Math.abs(now - goal) <= (unit ? unit / 2 : 1e-9) + 1e-9;
    if (close(st.now)) return { now: st.now, how: 'already there', goal };
    if (th.native) {
      await ops.evaluate(conn, tab, SLIDER_SET_NATIVE(th.selector, goal)).catch(() => null);
      st = await read();
      if (st && close(st.now)) return { now: st.now, how: 'value', goal };
    }
    // Keys, as a person using the keyboard would: Home and End for the limits, arrows (and
    // Page keys for long ways) toward the value, watching the value after each press.
    await ops.evaluate(conn, tab, FOCUS(th.selector)).catch(() => false);
    const press = async (k) => { await ops.key(conn, tab, k); return (await read())?.now; };
    let now = st.now, moved = false;
    if (goal === th.min || goal === th.max) {
      const n = await press(goal === th.min ? 'Home' : 'End');
      if (Number.isFinite(n) && n !== now) { moved = true; now = n; if (close(now)) return { now, how: 'keys', goal }; }
    }
    const t0 = Date.now();
    let axis = 0, stalls = 0, presses = 0, big = null;
    const KEYS = [['ArrowRight', 'ArrowLeft'], ['ArrowUp', 'ArrowDown']];
    while (presses < 400 && Date.now() - t0 < 12000 && !close(now)) {
      const up = goal > now;
      // A long way to go with a known unit: try a Page key, and keep using it while it does
      // not pass the value.
      if (unit && big !== false && Math.abs(goal - now) / unit > 15) {
        const before = now;
        const n = await press(up ? 'PageUp' : 'PageDown'); presses++;
        if (Number.isFinite(n) && n !== before) { moved = true; now = n; big = (up ? n <= goal : n >= goal) ? true : false; continue; }
        big = false;
      }
      const before = now;
      const n = await press(KEYS[axis][up ? 0 : 1]); presses++;
      if (!Number.isFinite(n) || n === before) {
        if (++stalls >= 2 && axis === 0) { axis = 1; stalls = 0; continue; }
        if (stalls >= 2) break;
        continue;
      }
      stalls = 0; moved = true;
      unit = unit || Math.abs(n - before);
      now = n;
      // Passed the value (the slider's steps skip it): keep the nearer of the two.
      if ((up && now > goal) || (!up && now < goal)) {
        if (Math.abs(before - goal) < Math.abs(now - goal)) now = await press(KEYS[axis][up ? 1 : 0]);
        break;
      }
    }
    if (moved && (close(now) || Math.abs(now - goal) <= unit)) return { now, how: 'keys', goal };
    if (!moved) {
      // No keyboard support: drag the thumb to the value's place on its track.
      st = await read();
      if (st && st.track.width > 0 && Number.isFinite(th.min) && Number.isFinite(th.max) && th.max > th.min) {
        const x = st.track.left + (goal - th.min) / (th.max - th.min) * st.track.width;
        await ops.drag(conn, tab, { from: { x: Math.round(st.x), y: Math.round(st.y) }, to: { x: Math.round(x), y: Math.round(st.y) } }).catch(() => {});
        const after = await read();
        if (after && after.now !== st.now) return { now: after.now, how: 'drag', goal, approx: !close(after.now) };
      }
    }
    return { stuck: now, why: moved ? `it moved but stopped at ${now}` : 'it did not move with its value, keys or a drag' };
  }

  // A set step (or a fill on a slider): every end it names, in an order the thumbs allow.
  async function setSlider(step, row, found) {
    const m = found || await matchSlider(step);
    if (m?.stop) return m;
    if (!m || m.none) return { stop: { reason: `No slider named "${step.target}" on the page${m?.all?.length ? `; sliders here: ${m.all.map(g => `"${clip(g.label || g.thumbs.map(t => t.name).join('/'), 40)}"`).join(', ')}` : ''}` } };
    const g = m.group;
    // A range's ends often share their label ("…, Minimum, Nightly price"): that is its name.
    const common = g.thumbs.length > 1 ? (() => {
      const words = (t) => String(t.name || '').split(/[\s,]+/).filter(w => w && !/^(\$?[\d.,]+\+?|min(imum)?|max(imum)?|from|to|and|above|below|low|high|lowest|highest|start|end)$/i.test(w));
      const rest = g.thumbs.slice(1).map(t => new Set(words(t).map(w => w.toLowerCase())));
      return words(g.thumbs[0]).filter(w => rest.every(r => r.has(w.toLowerCase()))).join(' ');
    })() : '';
    const label = common || g.label || g.thumbs.map(t => t.name).join(' / ') || 'slider';
    const values = step.values || sliderValues(step.value);
    const thumbs = m.thumb ? [m.thumb] : m.direct && values.length === 1 && g.thumbs.some(t => t.only) ? g.thumbs.filter(t => t.only) : g.thumbs;
    if (thumbs.some(t => t.disabled)) return { stop: { reason: `The slider "${clip(label, 50)}" is disabled` } };
    if (values.length === 2 && thumbs.length === 1) return { stop: { reason: `"${clip(label, 50)}" is a single slider; give it one value (set "${clip(step.target, 40)}" = <value>)` } };
    if (values.length === 1 && thumbs.length > 1) return { stop: { reason: `"${clip(label, 50)}" has ${thumbs.length} ends (${thumbs.map(t => `"${t.name || 'unnamed'}"`).join(', ')}); give both: set "${clip(step.target, 40)}" = <min>-<max>, or name one end` } };
    row.target = `slider "${clip(label, 60)}"`;
    const jobs = values.length === 1 ? [[thumbs[0], values[0]]] : (() => {
      const [lo, hi] = [...thumbs].sort((a, b) => a.now - b.now);
      // Thumbs that may not cross: raise the top end first when the new bottom is above it.
      return values[0] > hi.now ? [[hi, values[1]], [lo, values[0]]] : [[lo, values[0]], [hi, values[1]]];
    })();
    const ends = new Map(), hows = new Set();
    for (const [th, v] of jobs) {
      const r = await timed('input', moveThumb(th, v));
      if (r.stuck !== undefined) return { stop: { reason: `The slider "${clip(label, 50)}"${thumbs.length > 1 ? ` (${th.name || 'one end'})` : ''} stayed at ${r.stuck} when set to ${v}: ${r.why}` } };
      ends.set(th, r.now);
      hows.add(r.how);
      if (r.goal !== v || r.approx) row.unsure = true; // past its limit, or a drag that landed near
      // Its steps rounded the value ("under $40" asked as 39.99 lands on 40): say so, since
      // the filter now differs from what was asked.
      if (r.goal === v && Math.abs(r.now - v) > 1e-9) { row.unsure = true; (row.rounded ||= []).push(`set ${r.now}, asked ${v}`); }
    }
    const order = values.length === 1 ? [jobs[0][0]] : [...thumbs].sort((a, b) => ends.get(a) - ends.get(b));
    row.slider = order.map(t => ends.get(t)).join('–');
    row.how = [...hows].join(', ') + (m.unsure ? ', the only slider on the page' : '') + (row.rounded ? `, ${row.rounded.join(', ')}` : '');
    if (m.unsure) row.unsure = true;
    return { acted: true };
  }

  // Unnamed icon buttons take their row's name ("Increase Children").
  async function nameUnnamed(snap) {
    const refs = snap.elements.filter(e => !e.hidden && ['button', 'link', 'generic'].includes(e.role) && !(e.name || '').trim()).map(e => e.ref).slice(0, 80);
    if (!refs.length) return;
    const names = await ops.evaluate(conn, tab, NAME_UNNAMED(refs)).catch(() => ({}));
    for (const e of snap.elements) if (names?.[e.ref]) { e.name = names[e.ref]; e.derived = true; if (!/^(Increase|Decrease|Close)\b/.test(e.name)) e.borrowed = true; }
  }

  // Candidates that share a name get their row's heading or label, for Jev and for a stop.
  async function nameDuplicates(snap, action) {
    const groups = new Map();
    for (const e of jev.candidatesFor(snap.elements, action)) { const k = norm(e.name); if (k) (groups.get(k) || groups.set(k, []).get(k)).push(e); }
    const refs = [...groups.values()].filter(g => g.length > 1).flat().map(e => e.ref).slice(0, 40);
    if (!refs.length) return;
    const near = await ops.evaluate(conn, tab, NEAR_CONTEXT(refs)).catch(() => ({}));
    for (const e of snap.elements) if (near?.[e.ref]) e.near = clip(near[e.ref], 60);
  }

  // Is the element inside the open dialog or overlay (so acting on it is not blocked by it)?
  async function inOverlay(el, snap) {
    if (snap?.modal && el.ref && !el.inert) return true;
    if (el.ref) return (await ops.evaluate(conn, tab, jev.OVERLAY_REFS).catch(() => [])).includes(el.ref);
    if (!el.selector) return false;
    return ops.evaluate(conn, tab, `(() => { ${jev.IN_OVERLAY}; const el = document.querySelector(${JSON.stringify(el.selector)}); return !!(el && inOverlay(el)); })()`).catch(() => false);
  }

  if (showOn) await show.bringToFront(conn, tab); // --show: let the user watch
  let stopped = null;
  const opening = await meetChallenge(conn, tab, report, { handoff, handoffMs });
  if (opening) stopped = { step: 0, reason: opening };
  let view = await look();
  // A URL note on this page that covers a planned click: say so, but leave the plan alone.
  if (useNotes) {
    try {
      const tpl = notes.pathTemplate(view.url);
      const urlNotes = notes.forUrl(view.url, { max: Infinity }).filter(f => f.kind === 'url' && f.path === tpl);
      for (const s of steps) {
        if (!['click', 'select'].includes(s.action)) continue;
        const ctl = (s.action === 'select' ? `${s.target} = ${s.value}` : s.target).toLowerCase().replace(/\s+/g, ' ').trim();
        const f = urlNotes.find(n => n.key.split(' ').slice(2).join(' ') === ctl);
        if (f && !(report.suggestions ||= []).some(x => x.id === f.id)) report.suggestions.push({ id: f.id, text: f.text });
      }
    } catch {}
  }
  let pending = null; // the previous step's expected result, checked with the next request
  let lastRow = null; // the row that ran before the current one, for event attribution

  // A blocking overlay: dismiss it when its kind is listed, else stop with its text and
  // controls. One Jev request picks the kind and the closing control together.
  async function dismissOverlay(row) {
    const snap = await timed('read', ops.readPage(conn, tab, { maxText: 0, max: 1500, all: true }));
    const inside = new Set(await ops.evaluate(conn, tab, jev.OVERLAY_REFS).catch(() => []));
    const controls = snap.elements.filter(e => inside.has(e.ref) && !e.hidden);
    const safe = controls.filter(safeToDismiss);
    const text = clip(view.overlay, 400);
    const blocked = (reason, extra = {}) => ({
      reason, overlay: text, controls: controls.map(describeEl).slice(0, 15), ...extra,
    });
    if (!categories.length) return { stop: blocked('A dialog or popup is blocking the page; dismiss it (or pass --dismiss "<kinds>") and re-plan') };
    const criteria = Object.fromEntries(categories.map((c, i) => [`c${i + 1}`, c]));
    criteria.other = 'Something else: none of the listed kinds';
    const questions = { category: { type: 'choice', instructions: 'Which kind of overlay is covering the page?', criteria } };
    const cq = safe.length ? jev.targetQuestion({ elements: safe }, { intent: 'close or dismiss this overlay without agreeing to buy, subscribe, sign up or install anything', action: 'click' }) : null;
    if (cq?.question) questions.control = cq.question;
    let r;
    try { r = await ask({ page: jev.viewState(view), task: 'close a popup that blocks the page' }, questions); }
    catch (e) { return { stop: blocked(e.message) }; }
    const cat = r.answers.category;
    const kind = cat?.choice && cat.choice !== 'other' && cat.choice in criteria ? criteria[cat.choice] : null;
    const kindP = cat?.probabilities?.[cat?.choice];
    if (!kind || (kindP ?? 0) < 0.5) return { stop: blocked(`An overlay that is not one of the listed kinds (${categories.join(', ')}) is blocking the page`) };
    const pick = cq?.question ? jev.readTarget(r.answers.control, cq.cands) : { pick: null };
    if (!pick.pick || (pick.p ?? 0) < minP) return { stop: blocked(`A ${kind} is blocking the page and no safe control closes it`, { category: kind }) };
    await ops.click(conn, tab, { ref: pick.pick.ref, token: snap.token });
    await settle(conn, tab, { maxMs: 2500 });
    const ev = { type: 'dismissed', after_step: lastRow?.step ?? 0, category: kind, text: clip(text, 200), control: describeEl(pick.pick), p: pick.p };
    (row.dismissed ||= []).push(ev);
    report.events.push(ev);
    const before = view;
    view = await look();
    if (clip(view.overlay, 400) && clip(view.overlay, 400) === text) return { stop: blocked(`The ${kind} stayed after clicking ${describeEl(pick.pick)}`) };
    for (const t of newNotices(before, view)) { const n = { type: 'notice', after_step: row.step, text: t }; (row.events ||= []).push(n); report.events.push(n); }
    return {};
  }

  // Ground and do one step. `extra` questions ride along in the same request; `stopIf`
  // ends the step before acting (the loop's until condition).
  async function perform(step, row, { extra = {}, stopIf, retryMs = 2500, canSkip = step.optional, inNote = false } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let snap = null, el = null, tq = null;
      // A date step, or a click that names a whole date: the day cell, paging months to it.
      const dateWanted = step.action === 'date' ? step.target
        : step.action === 'click' && !step.ref && !step.item && !step.selector ? ((d) => (d ? isoDate(d) : null))(parseDateText(step.target)) : null;
      if (dateWanted) {
        const d = await findDate(dateWanted);
        if (d.el) { el = d.el; row.how = d.how; }
        else if (step.action === 'date') { if (canSkip) { row.skipped = d.reason; return {}; } return { stop: { reason: d.reason } }; }
      }
      // A fill whose value is a number, on a slider of exactly that name, sets the slider.
      let sliderPlan = null;
      if (step.action === 'fill' && sliderValues(step.value)) {
        const m = await matchSlider(step).catch(() => null);
        if (m?.group && (m.exact || m.direct)) sliderPlan = m;
        // A text box for the same value ("Max Price $" beside the price slider) takes the
        // number exactly; a slider rounds it to its steps. Prefer the box, unless the step
        // named the slider directly.
        if (sliderPlan && !m.direct) {
          const boxes = await timed('read', ops.readPage(conn, tab, { maxText: 0, max: 1500, all: true })).catch(() => null);
          if (boxes && jev.candidatesFor(boxes.elements, 'fill').some(e => e.role !== 'slider' && sameWords(e.name || e.placeholder, step.target))) sliderPlan = null;
        }
      }
      if (!el && TARGETED.has(step.action) && !sliderPlan) {
        snap = await timed('read', ops.readPage(conn, tab, { maxText: 0, max: 1500, all: true }));
        await nameUnnamed(snap);
        const direct = await findDirect(step, snap);
        if (direct?.stop) { if (canSkip) { row.skipped = direct.stop.reason; return {}; } return direct; }
        if (direct?.el) { el = direct.el; row.how = direct.how; }
        else {
          el = exactMatch(snap, step);
          if (el) row.how = el.duplicates ? `exact, first of ${el.duplicates}` : 'exact';
          else if (step.action === 'click') {
            // An option of an open custom listbox is often missing from the snapshot.
            const key = pinKey();
            const o = await ops.evaluate(conn, tab, FIND_DIRECT('option', step.target, key, 'click')).catch(() => null);
            if (o && !o.error && o.shown) { el = { ...(o.ref && snap.elements.find(e => e.ref === o.ref) || { ...o, ref: null }), selector: o.selector }; row.how = 'option'; }
          }
        }
        if (!el) { await nameDuplicates(snap, step.action); tq = jev.targetQuestion(snap, { intent: step.target, action: step.action }); }
        if (showOn) {
          // What Jev is shown: every candidate it will choose among (or the exact match).
          await show.annotate(conn, tab, { cands: el ? [el] : tq?.cands || [], pick: el?.ref });
          await show.panel(conn, tab, { title: 'browserctrl do', append: el ? `${row.do}\n   exact name match, no model call` : `${row.do}\n   Jev sees ${tq?.cands?.length || 0} ${step.action}able controls + on-screen text` });
          await new Promise(r => setTimeout(r, 500));
        }
      }
      const questions = { ...extra };
      if (tq?.question) questions.target = tq.question;
      if (pending) questions.prev_expect = expectQuestion(pending.expect);
      if (step.action === 'expect') questions.expect = expectQuestion(step.target);
      const watchBlocker = view.overlay?.trim() && !['nav', 'wait', 'expect'].includes(step.action);
      if (watchBlocker) questions.blocker = blockerQuestion(row.do);
      const known = pageNotes(view.url);
      // On notes ride along only when a request is made anyway, at most 3 per run each.
      const onNotes = !inNote && Object.keys(questions).length ? known.runnable.filter(f => f.on && (fired.get(f.id) || 0) < 3).slice(0, 3) : [];
      for (const f of onNotes) questions[`on_${f.id}`] = { type: 'noul', instructions: `Is this situation showing on the page right now: ${f.on.situation}?` };
      let answers = {};
      if (Object.keys(questions).length) {
        const essential = Object.keys(questions).some(k => k !== 'blocker');
        try {
          // On-screen text misses controls below the fold (a Next link at the page bottom),
          // so questions about what exists also see every control on the page.
          const controls = snap ? [...new Set(snap.elements.filter(e => e.name).map(e => `${e.role} "${e.name.slice(0, 40)}"`))].slice(0, 120) : undefined;
          const r = await ask({ page: jev.viewState(view), ...(controls ? { controls_on_page: controls } : {}), next_step: row.do, ...(TARGETED.has(step.action) ? { action: step.action, intent: step.target } : {}),
            ...(known.context.length ? { site_notes: known.context } : {}) }, questions);
          answers = r.answers;
          row.jev_ms = (row.jev_ms || 0) + r.ms;
        } catch (e) {
          if (essential) return { stop: { reason: e.message } };
        }
      }
      if (pending) {
        const p = prob(answers.prev_expect);
        pending.row.expect_p = p;
        if (!(p >= 0.5)) return { expectFailed: true, stop: { step: pending.row.step, reason: `Step ${pending.row.step} expected "${pending.expect}", but the page does not show it (p=${p})` } };
        pending = null;
      }
      if (stopIf?.(answers)) return { met: true };
      // A situation an on note handles: run its steps, then ground this step again.
      const onHit = onNotes.find(f => prob(answers[`on_${f.id}`]) >= 0.5);
      if (onHit) {
        fired.set(onHit.id, (fired.get(onHit.id) || 0) + 1);
        const { ok } = await runNote(onHit, row, 'on');
        applied.set(onHit.id, ok && applied.get(onHit.id) !== false);
        (row.via_notes ||= []).push({ id: onHit.id, kind: 'on', ok });
        report.events.push({ type: 'note', after_step: lastRow?.step ?? 0, id: onHit.id, kind: 'on', text: onHit.on.situation, ok });
        if (ok) continue;
      }
      if (step.action === 'expect') {
        row.p = prob(answers.expect);
        return row.p >= 0.5 ? {} : { stop: { reason: `The page does not show: ${step.target} (p=${row.p})` } };
      }
      let pick = null;
      if (tq?.question && answers.target) {
        try { pick = jev.readTarget(answers.target, tq.cands); } catch (e) { return { stop: { reason: e.message } }; }
        if (showOn) {
          // What Jev answered: candidates tinted by probability, the pick in red.
          const probs = Object.fromEntries((pick.ranked || []).map(c => [c.ref, c.p]));
          await show.annotate(conn, tab, { cands: tq.cands, probs, pick: pick.pick?.ref });
          await show.panel(conn, tab, { title: 'browserctrl do', append: `   Jev: ${(pick.ranked || []).slice(0, 3).map(c => `${Math.round(c.p * 100)}% ${c.ref === 'none' ? 'none' : `${c.role} "${clip(c.name, 30)}"`}`).join(', ')}` });
          await new Promise(r => setTimeout(r, 700));
        }
      }
      if (watchBlocker && prob(answers.blocker) >= 0.5) {
        const chosen = el || (pick?.p >= minP ? pick.pick : null);
        // The step works in the dialog itself (its OK, its stepper): nothing to dismiss.
        const inside = chosen ? await inOverlay(chosen, snap) : false;
        if (!inside) {
          const d = await dismissOverlay(row);
          if (d.stop) return d;
          continue; // re-ground on the cleared page
        }
      }
      if (showOn && ['key', 'type', 'scroll', 'nav'].includes(step.action)) {
        await show.act(conn, tab, { kind: step.action, label: step.action === 'key' ? `⌨ ${step.target === 'Enter' ? '⏎ Enter' : step.target}` : step.action === 'type' ? `type "${clip(step.target, 40)}"` : step.action === 'scroll' ? `scroll ${step.target}` : `go to ${clip(step.target, 60)}` });
      }
      if (step.action === 'key') {
        const errBefore = await ops.evaluate(conn, tab, ERROR_STATE).catch(() => null);
        await ops.key(conn, tab, step.target);
        return { acted: true, outcome: { errBefore } };
      }
      if (step.action === 'type') { await ops.type(conn, tab, step.target); return { acted: true }; }
      if (step.action === 'scroll') { await ops.scroll(conn, tab, { deltaY: /up/i.test(step.target) ? -700 : 700 }); return { acted: true }; }
      if (step.action === 'wait') { await new Promise(r => setTimeout(r, Math.min(Number(step.target) || 1000, 10000))); return { acted: true }; }
      if (step.action === 'nav') { await ops.navigate(conn, tab, step.target, { timeoutMs: 30000 }); return { acted: true }; }
      if (step.action === 'set' || sliderPlan) return setSlider(step, row, sliderPlan);
      if (!el) {
        if (!tq?.question) pick = { pick: null, ranked: [], reason: `No ${step.action}able elements on the page` };
        if (!pick.pick || (pick.p ?? 0) < minP) {
          // Often the page is still rendering what the step needs (a suggestion list that
          // loads after typing): settle once more and ask again before giving up.
          row.retried = true;
          await timed('retry', settle(conn, tab, { maxMs: retryMs }));
          snap = await timed('read', ops.readPage(conn, tab, { maxText: 0, max: 1500, all: true }));
          await nameUnnamed(snap);
          el = exactMatch(snap, step);
          if (el) { row.how = 'exact'; pick = null; }
          else {
            await nameDuplicates(snap, step.action);
            view = await look();
            const first = pick;
            try { pick = await jev.pickTarget(getCfg(), snap, { intent: step.target, action: step.action, view }, fetchOpts); report.jev_calls++; }
            catch (e) { return { stop: { reason: e.message } }; }
            // A second look that lands on a different element without real confidence is a
            // coin flip, not new information: stop with both rather than act.
            if (first?.pick && pick.pick && first.pick.ref !== pick.pick.ref && (pick.p ?? 0) < 0.8) {
              pick = { ...pick, pick: null, reason: `Jev was unsure between ${describeEl(first.pick)} (p=${first.p}) and ${describeEl(pick.pick)} (p=${pick.p}); name the element exactly` };
            }
          }
        }
        if (!el) {
          const ctx = commitCtx(snap);
          let why = jev.refusal(pick, minP, ctx);
          // A pick that lacks a number or date the step names is a different element.
          const missing = !why && ['click', 'hover'].includes(step.action) ? missingFromPick(step.target, pick.pick) : [];
          if (missing.length) why = `Jev picked ${describeEl(pick.pick)} (p=${pick.p}), which does not show ${missing.map(m => `"${m}"`).join(', ')} from the step; name the element exactly${parseDateText(step.target) ? ', or use a date step (date YYYY-MM-DD)' : ''}`;
          // The target is not on the page: a reveal note may say how to bring it out.
          const reveal = why && !row.revealed && !inNote ? notes.revealFor(pageNotes(view.url).runnable, step.target) : null;
          if (reveal) {
            row.revealed = reveal.id;
            const { ok, acted } = await runNote(reveal, row, 'r');
            (row.via_notes ||= []).push({ id: reveal.id, kind: 'reveal', ok });
            // Only a note that ran in full and still left the target out is wrong; one whose
            // steps could not run did not apply here and is neither confirmed nor contradicted.
            row.reveal_full = ok;
            if (acted) { attempt = -1; continue; } // ground the step again from the start
          }
          // Not found, and this plan opened a section earlier: pages that show one section at a
          // time (filter drawers) hide the rest while it is open. Close it, which only undoes
          // our own step, and look again once.
          if (why && !row.closedOpen && openedHere.length && step.action === 'click') {
            const last = openedHere.pop();
            row.closedOpen = last.target;
            await timed('input', clickSel({ selector: last.selector })).catch(() => {});
            await timed('settle', settle(conn, tab, { quietMs: 250, maxMs: 1500 }));
            attempt = -1; continue;
          }
          // Not on screen, but a control of exactly that name sits in a collapsed section (a
          // filter group the last plan left shut, a closed <details>): open that section, once,
          // and look again. Only when every hidden match has the same opener.
          if (why && !row.autoRevealed && !inNote && ['click', 'hover', 'fill', 'select'].includes(step.action) && !step.ref && !step.item && !step.selector) {
            const exact = `^\\s*${String(step.target).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`;
            const found = await ops.evaluate(conn, tab, finder.FIND(exact, { limit: 6, pin: true })).catch(() => null);
            const hidden = (found?.rows || []).filter(x => x.hidden);
            const openers = [...new Set(hidden.map(x => x.opens_with?.handle))];
            if (hidden.length && openers.length === 1 && openers[0] && hidden.length === (found.rows || []).length) {
              row.autoRevealed = hidden[0].opens_with.name;
              await timed('input', clickSel({ selector: openers[0] })).catch(() => {});
              await timed('settle', settle(conn, tab, { quietMs: 250, maxMs: 1500 }));
              attempt = -1; continue;
            }
          }
          // Several candidates with the same name: Jev cannot tell them apart by name, but
          // the caller can by ref.
          const top = (pick.ranked || []).find(c => c.ref !== 'none');
          const lead = pick.pick || (top && top.p >= 0.3 ? top : null); // not when Jev found nothing like it
          const twins = why && lead && snap ? jev.candidatesFor(snap.elements, step.action).filter(c => norm(c.name) === norm(lead.name)) : [];
          if (twins.length > 1) why = `${why}; ${twins.length} controls share the same name "${clip(lead.name, 40)}": click ${twins.slice(0, 4).map(c => `${c.ref}${c.near ? ` (near "${clip(c.near, 40)}")` : ''}`).join(' or click ')}`;
          if (why) {
            const committing = pick.pick && jev.commits(pick.pick.name, pick.pick, ctx);
            if (committing && step.commit) return { stop: { reason: `A committing step needs the control's exact name; Jev guessed "${clip(pick.pick.name, 60)}". Re-plan with ${step.action}! "<its exact name>"`, candidates: (pick.ranked || []).filter(c => c.ref !== 'none') } };
            if (canSkip && !committing) { row.skipped = why; return {}; }
            return { stop: { reason: why, candidates: (pick.ranked || []).filter(c => c.ref !== 'none'), ...(await timed('stop_report', whatIsThere(conn, tab, step))) } };
          }
          el = pick.pick;
          row.how = `jev p=${pick.p}`;
          // Acted on, but not sure: the report marks it ⚠ so the caller looks before trusting it.
          if ((pick.p ?? 0) < 0.75) row.unsure = true;
        }
      }
      // A control that can commit (Buy, Send, Place order…) is clicked only when the plan
      // marks the step with ! and names it exactly; a Jev pick never commits. Typing, ticking
      // a box and following a link commit nothing (jev.commits).
      // A ref or items id from the caller's own read is a deliberate choice, as the stop
      // message below suggests; so is an entry button that only starts an order while the
      // page holds no bag total or payment step.
      const deliberate = Boolean(step.ref || step.item);
      if (['click', 'select', 'date'].includes(step.action) && !deliberate && !/^jev/.test(row.how || '') && jev.commits(el.name, el, commitCtx(snap))) {
        const entry = ORDER_ENTRY.test(el.name || '') && !(await ops.evaluate(conn, tab, CHECKOUT_STATE).catch(() => true));
        if (entry) row.how = `${row.how}, starts an order`;
        else {
          if (!step.commit) return { stop: { reason: `"${clip(el.name, 60)}" can commit something; to click it, mark the step: ${step.action}! "${clip(el.name, 60)}" (only after the user authorized it), or click it by ref` } };
          row.committed = true;
        }
      }
      const t = el.ref && snap ? { ref: el.ref, token: snap.token } : { selector: el.selector };
      row.target = describeEl(el);
      row.el = { role: el.role, name: clip(el.name, 80), ref: el.ref };
      if (showOn) await show.act(conn, tab, { ref: el.ref, kind: step.action, label: step.action === 'fill' ? `type "${clip(step.value, 40)}" into ${clip(el.name, 30) || el.role}` : step.action === 'select' ? `choose "${clip(step.value, 40)}"` : `${step.action} ${clip(el.name, 50) || el.role}` });
      // What to check once the page settles: a box that should have toggled, and errors.
      const toggles = ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(el.role) || (el.checked !== undefined && el.role !== 'option') || el.pressed !== undefined;
      let toggle = null;
      if (toggles && step.action === 'click') {
        const sel = el.selector || await ops.evaluate(conn, tab, `(() => { const els = (window.__cdp && window.__cdp.els) || []; const el = els[${JSON.stringify(el.ref)}.replace('ref_', '') - 1]; if (!el) return null; const k = ${JSON.stringify(pinKey())}; el.setAttribute('data-bc-pin', k); return '[data-bc-pin="' + k + '"]'; })()`).catch(() => null);
        if (sel) toggle = { selector: sel, role: el.role, name: el.name, pressed: el.pressed !== undefined, before: await ops.evaluate(conn, tab, CHECKED_STATE(sel)).catch(() => null) };
        // A step that names a toggle wants it on. One that is already on would be switched off
        // by the click (Airbnb's "Gym", clicked again to make sure, came off), so leave it; a
        // click by ref or items id is deliberate and still toggles. A radio is clicked anyway:
        // clicking a chosen radio cannot unchoose it, and its checked state can be misread (a
        // "10mi" radio read as chosen while the search still used 25 miles).
        if (toggle?.before === true && !deliberate && !/radio/.test(el.role)) {
          Object.assign(row, { target: describeEl(el), el: { role: el.role, name: clip(el.name, 80), ref: el.ref }, checked: true, already: true, ...(toggle.pressed ? { pressed_kind: true } : {}) });
          row.how = `${row.how}, already on: not clicked (click it by ref to turn it off)`;
          return {};
        }
      }
      // A disclosure (accordion, expander) should change state; read it before the click.
      let disclosure = null;
      if (step.action === 'click' && !toggles) {
        const sel = el.selector || await ops.evaluate(conn, tab, `(() => { const els = (window.__cdp && window.__cdp.els) || []; const el = els[${JSON.stringify(el.ref)}.replace('ref_', '') - 1]; if (!el) return null; const k = ${JSON.stringify(pinKey())}; el.setAttribute('data-bc-pin', k); return '[data-bc-pin="' + k + '"]'; })()`).catch(() => null);
        const before = sel ? await ops.evaluate(conn, tab, DISCLOSURE_STATE(sel)).catch(() => null) : null;
        if (before !== null) disclosure = { selector: sel, before };
        // A plan that clicks a section's heading and then something in it wants it open; one
        // already open would be shut by the click (a filter group left open by the last plan,
        // so its option vanished). Leave it, unless clicked by ref or it is the plan's last step.
        if (before === true && !deliberate && typeof row.step === 'number' && row.step < steps.length) {
          Object.assign(row, { target: describeEl(el), el: { role: el.role, name: clip(el.name, 80), ref: el.ref }, expanded: true, already: true });
          row.how = `${row.how}, not clicked: click it by ref to close it`;
          return {};
        }
      }
      const errBefore = ['click', 'date', 'select'].includes(step.action) ? await ops.evaluate(conn, tab, ERROR_STATE).catch(() => null) : null;
      const dateCheck = dateWanted && el.selector ? { selector: el.selector, iso: dateWanted, label: el.name, before: await ops.evaluate(conn, tab, DATE_LOOK(el.selector, dateWanted)).catch(() => null) } : null;
      try {
        if (step.action === 'click' || step.action === 'date') await timed('input', clickSel(t));
        else if (step.action === 'hover') await timed('input', ops.hover(conn, tab, t));
        else if (step.action === 'fill') { await timed('input', ops.fill(conn, tab, { ...t, value: step.value })); lastFilled = el; }
        else if (step.action === 'select') {
          try { await ops.selectOption(conn, tab, { ...t, label: step.value }); }
          catch (e) {
            if (e.code !== 'not_select') throw e;
            // A custom combobox or listbox with no native select: do what a person does, open
            // it and click the option with that name (the list may render anywhere: a portal,
            // a shadow root).
            // Pin the control first: reading the open list renumbers the page's refs.
            const ctlSel = el.selector || await ops.evaluate(conn, tab, `(() => { const els = (window.__cdp && window.__cdp.els) || []; const el = els[${JSON.stringify(el.ref)}.replace('ref_', '') - 1]; if (!el) return null; const k = ${JSON.stringify(pinKey())}; el.setAttribute('data-bc-pin', k); return '[data-bc-pin="' + k + '"]'; })()`).catch(() => null);
            await timed('input', clickSel(t));
            await timed('settle', settle(conn, tab, { quietMs: 250, maxMs: 1500 }));
            const opts = await timed('read', ops.readPage(conn, tab, { maxText: 0, max: 1500, all: true }));
            const want = norm(step.value);
            const roles = /^(option|menuitem|menuitemradio|treeitem|listitem|radio|checkbox|button|link|clickable)$/;
            // Visible options only, and those that appeared when the control opened first: a page
            // can keep other lists' options in the DOM (a "Max" list beside the "Min" one).
            const shown = opts.elements.filter(x => roles.test(x.role) && x.ref !== el.ref && !x.hidden && !x.inert);
            const cands = shown.filter(x => x.new).concat(shown.filter(x => !x.new));
            const opt = cands.find(x => /^(option|menuitem|menuitemradio|treeitem)$/.test(x.role) && norm(x.name) === want)
              || cands.find(x => norm(x.name) === want)
              || cands.find(x => /^(option|menuitem|menuitemradio|treeitem)$/.test(x.role) && norm(x.name).startsWith(want));
            if (!opt) {
              const seen = cands.filter(x => /^(option|menuitem|menuitemradio|treeitem)$/.test(x.role)).map(x => x.name).slice(0, 15);
              throw new Error(`Opened ${describeEl(el)}, but it lists no option "${step.value}"${seen.length ? `; options: ${seen.join(' | ')}` : ''}`);
            }
            await timed('input', ops.click(conn, tab, { ref: opt.ref, token: opts.token }));
            row.how = `${row.how}, opened it and picked ${describeEl(opt)}`;
            // The control should now show the choice (its text, value or a shadow-root display).
            await timed('settle', settle(conn, tab, { quietMs: 250, maxMs: 1500 }));
            const shows = !ctlSel ? null : await ops.evaluate(conn, tab, `(() => {
              const el = ${deepQuery(ctlSel)};
              if (!el || !el.isConnected) return null;
              // Its own text and value only: a component's shadow root also holds every option.
              // A component host shows its value through its combobox inside.
              const own = (el.shadowRoot && el.shadowRoot.querySelector('[role=combobox],select,input')) || el;
              const texts = [own.value, own.innerText, own.getAttribute('aria-valuetext'), own.getAttribute('value')];
              return texts.filter(Boolean).join(' ').replace(/\\s+/g, ' ').slice(0, 300);
            })()`).catch(() => null);
            // A click on an option can miss when the list moves as it opens; the keyboard is
            // the combobox pattern's own way in: open it, type to jump, or walk with ArrowDown,
            // then Enter. Checked the same way.
            const showsNow = async () => (!ctlSel ? null : ops.evaluate(conn, tab, `(() => {
              const el = ${deepQuery(ctlSel)};
              if (!el || !el.isConnected) return null;
              const own = (el.shadowRoot && el.shadowRoot.querySelector('[role=combobox],select,input')) || el;
              return [own.value, own.innerText, own.getAttribute('aria-valuetext'), own.getAttribute('value')].filter(Boolean).join(' ').replace(/\\s+/g, ' ').slice(0, 300);
            })()`).catch(() => null));
            let seen = shows;
            if (seen !== null && !norm(seen).includes(want) && ctlSel) {
              const active = `(() => { const el = ${deepQuery(ctlSel)}; const own = el && ((el.shadowRoot && el.shadowRoot.querySelector('[role=combobox]')) || el); const id = own && own.getAttribute('aria-activedescendant'); const r = own && own.getRootNode(); const a = id && r && (r.getElementById ? r.getElementById(id) : null); return a ? (a.innerText || a.textContent || '').trim() : null; })()`;
              const open = async () => { await clickSel({ selector: ctlSel }).catch(() => {}); await new Promise(res => setTimeout(res, 300)); };
              await open();
              await ops.type(conn, tab, String(step.value)).catch(() => {});
              // Enter only if typing highlighted the option; otherwise close the list unchanged.
              const typed = await ops.evaluate(conn, tab, active).catch(() => null);
              await ops.key(conn, tab, typed !== null && norm(typed) === want ? 'Enter' : 'Escape').catch(() => {});
              await timed('settle', settle(conn, tab, { quietMs: 250, maxMs: 1200 }));
              seen = await showsNow();
              if (seen !== null && !norm(seen).includes(want)) {
                await open();
                // Walk only a list whose highlight can be read: blind ArrowDowns change the value
                // without knowing to what (a Min. Year list walked to its last year, 1950).
                let found = false;
                for (let k = 0; k < 80; k++) {
                  await ops.key(conn, tab, 'ArrowDown').catch(() => {});
                  const a = await ops.evaluate(conn, tab, active).catch(() => null);
                  if (a === null) break;
                  if (norm(a) === want) { found = true; break; }
                }
                await ops.key(conn, tab, found ? 'Enter' : 'Escape').catch(() => {});
                await timed('settle', settle(conn, tab, { quietMs: 250, maxMs: 1200 }));
                seen = await showsNow();
              }
              if (seen !== null && norm(seen).includes(want)) row.how = `${row.how}; the click missed, picked with the keyboard`;
            }
            if (seen !== null && !norm(seen).includes(want)) throw new Error(`Picked ${describeEl(opt)} in ${describeEl(el)}, but the control does not show it (it shows "${clip(seen, 60)}"); re-plan`);
          }
        }
      } catch (e) {
        // The page redrew the control between the read and the input (Airbnb rebuilds its
        // guest panel after each stepper click), or the last step's navigation landed after
        // the read (a results page, a cookie choice that reloads): nothing was sent, so find
        // it again once on the page as it is now.
        if (['detached', 'no_snapshot', 'navigated', 'stale', 'unknown_ref', 'frame_replaced'].includes(e.code) && !step.ref && !row.regrounded) {
          row.regrounded = true;
          await settle(conn, tab, { quietMs: 300, maxMs: 1500 });
          continue;
        }
        throw e;
      }
      if (row.revealed) { row.how = `${row.how}, via note ${row.revealed}`; applied.set(row.revealed, applied.get(row.revealed) !== false); }
      if (row.closedOpen) row.how = `${row.how}, closed ${row.closedOpen} first`;
      if (row.autoRevealed) row.how = `${row.how}, opened "${clip(row.autoRevealed, 40)}" first: it was in that collapsed section`;
      return { acted: true, outcome: { toggle, disclosure, errBefore, dateCheck } };
    }
    return { stop: { reason: 'Overlays kept appearing after dismissing them' } };
  }

  // Did the step do what it was for? A box that should have toggled and did not, or a page
  // that now shows an error, stops the plan here instead of three steps later.
  async function outcome(o, row) {
    if (!o) return null;
    if (o.toggle && o.toggle.before !== null) {
      // A filter's label carries a result count that changes when it applies ("Free
      // Breakfast (42)" redraws as "(38)"): match the control by its name without counts.
      const bare = (s) => norm(String(s || '').replace(/\(\s*[\d,.]+\s*\)|\b\d[\d,.]*\b/g, ' '));
      const state = async () => {
        let a = await ops.evaluate(conn, tab, CHECKED_STATE(o.toggle.selector)).catch(() => null);
        if (a === null) { // re-rendered: the same control by role and name
          const snap = await timed('read', ops.readPage(conn, tab, { maxText: 0, max: 1500, all: true })).catch(() => null);
          const same = (e) => e.role === o.toggle.role;
          // A page can draw the control twice (a desktop form and a drawer's copy, one hidden
          // or behind the drawer): judge by the copies a person can use, and any of those that
          // shows the choice.
          const usable = (e) => !e.hidden && !e.inert;
          const named = (snap?.elements || []).filter(e => same(e) && norm(e.name) === norm(o.toggle.name));
          const loose = named.length ? named : (snap?.elements || []).filter(e => same(e) && bare(e.name) && bare(e.name) === bare(o.toggle.name));
          const copies = loose.filter(usable).length ? loose.filter(usable) : loose;
          if (copies.length) a = copies.some(e => e.checked);
        }
        return a;
      };
      const radio = /radio/.test(o.toggle.role);
      // Failed: a radio that is not chosen, or a box that was and stays unticked. A box that
      // was already ticked and stays ticked is the state the step asked for (a single-choice
      // group drawn as checkboxes keeps its choice when clicked again).
      const failed = (a) => a !== null && !a && (radio || !o.toggle.before);
      let after = await state();
      // Not yet: web components (ion-radio) set aria-checked a moment later, and a filter
      // list is often redrawn unticked until its results arrive (Booking). Let the page
      // settle, then read again for up to 2 s before calling the click a failure.
      for (const t0 = Date.now(); failed(after) && Date.now() - t0 < 2000;) {
        await timed('settle', settle(conn, tab, { quietMs: 300, maxMs: 1500 }));
        await new Promise(res => setTimeout(res, 250));
        after = await state();
      }
      // The page took the choice into its address (a sort or filter that reloads its results
      // from the server and redraws the form unticked until they arrive): the click did
      // something, so it is not "did not take", only not readable yet.
      const moved = failed(after) && (await ops.evaluate(conn, tab, 'location.href').catch(() => null)) !== row.url_before && urlChange(row.url_before, await ops.evaluate(conn, tab, 'location.href').catch(() => row.url_before));
      if (moved) { row.checked = undefined; row.how = `${row.how}, the page put the choice in its address (not shown ticked yet)`; return null; }
      if (after !== null) {
        row.checked = after;
        if (o.toggle.pressed) row.pressed_kind = true;
        if (!radio && o.toggle.before && after) row.already = true;
        if (failed(after)) return `Clicked ${row.target}, but it is still ${o.toggle.pressed ? 'not pressed' : 'unchecked'}; the click did not take. Try its label or a nearby control, then re-plan`;
      }
    }
    if (o.disclosure) {
      const d = o.disclosure;
      const now = () => ops.evaluate(conn, tab, DISCLOSURE_STATE(d.selector)).catch(() => null);
      let after = await now();
      if (after === d.before) { await new Promise(res => setTimeout(res, 400)); after = await now(); }
      // Some components ignore a pointer click on their control (a design-system accordion
      // whose heading is drawn over it); activating the control itself does what a person's
      // click does. Done once, and reported.
      if (after === d.before) {
        await ops.evaluate(conn, tab, DISCLOSURE_STATE(d.selector, true)).catch(() => null);
        await timed('settle', settle(conn, tab, { quietMs: 250, maxMs: 1500 }));
        after = await now();
        if (after !== null && after !== d.before) row.how = `${row.how}, activated directly: the page ignored the pointer click`;
      }
      if (after !== null) {
        row.expanded = after;
        if (after === d.before) return `Clicked ${row.target}, but it did not ${d.before ? 'close' : 'open'}; re-plan (its heading, a nearby control, or a nav step)`;
        if (after) openedHere.push({ selector: d.selector, target: row.target });
        else for (let i = openedHere.length - 1; i >= 0; i--) if (openedHere[i].selector === d.selector) openedHere.splice(i, 1);
      }
    }
    if (o.dateCheck) {
      const c = o.dateCheck;
      let r = await ops.evaluate(conn, tab, DATE_SHOWN(c.selector, c.iso, c.before)).catch(() => null);
      // A picker that animates or fills its field a moment later: look once more.
      if (r && !r.shown) { await new Promise(res => setTimeout(res, 500)); r = await ops.evaluate(conn, tab, DATE_SHOWN(c.selector, c.iso, c.before)).catch(() => null); }
      if (r && !r.shown) return `Picked "${clip(c.label, 60)}" but the calendar doesn't show it selected and no date field shows ${c.iso}; the click did not take. Check the picker (it may need another control first), then re-plan`;
      if (r?.shown) row.date_shown = r.shown;
    }
    if (o.errBefore) {
      const err = newError(o.errBefore, await ops.evaluate(conn, tab, ERROR_STATE).catch(() => null));
      if (err) { row.error = err; return `The page shows an error after this step: ${err}`; }
    }
    return null;
  }

  // Run one step with its bookkeeping: settle, challenge, notices, expectation hand-off.
  async function runOne(step, row, performOpts) {
    const t0 = Date.now();
    row.url_before = view.url;
    let res;
    try {
      res = await perform(step, row, performOpts);
      if (res.acted) {
        if (showOn) await show.busy(conn, tab, true, 'waiting for the page to settle');
        // Search-as-you-type waits 250-500 ms after the last key before it fetches.
        row.settle_ms = await timed('settle', settle(conn, tab, ['type', 'fill'].includes(step.action) ? { quietMs: 700 } : {}));
        row.settle_why = settle.why;
        const why = await meetChallenge(conn, tab, row, { handoff, handoffMs });
        if (why) res = { stop: { reason: why } };
        const before = view;
        view = await look();
        for (const t of newNotices(before, view)) { const n = { type: 'notice', after_step: row.step, text: t }; (row.events ||= []).push(n); report.events.push(n); }
        if (!res.stop) { const bad = await outcome(res.outcome, row); if (bad) res = { stop: { reason: bad } }; }
      }
    } catch (e) {
      res = { stop: { reason: e.message } };
    }
    // A reveal note that ran in full and still left the target out is wrong, even when the
    // step then found it another way (opening the section that held it).
    if (row.revealed && row.reveal_full && (res?.stop || row.autoRevealed)) applied.set(row.revealed, false);
    row.url_after = view.url;
    const change = urlChange(row.url_before, row.url_after);
    if (change) row.url_change = change;
    if (!opts.noNotes) {
      const before = pageKind(row.url_before), after = pageKind(row.url_after);
      if (before) hinted.add(before);
      if (after && !hinted.has(after)) {
        hinted.add(after);
        const h = site.hintBlock(row.url_after);
        if (h.length) row.hints = h;
      }
    }
    row.ms = Date.now() - t0;
    if (!res.stop && !res.met && !row.skipped && step.expect) pending = { expect: step.expect, row };
    if (!row.skipped && !res.met) lastRow = row;
    return res;
  }

  for (const [i, step] of (stopped ? [] : steps.entries())) {
    const row = { step: i + 1, do: lines[i] };
    const res = await runOne(step, row);
    if (res.expectFailed) { stopped = res.stop; pending = null; break; } // the step itself never ran
    report.steps.push(row);
    if (res.stop) { stopped = { step: i + 1, ...res.stop }; row.stopped = true; }
    if (onStep) await onStep(row).catch(() => {});
    if (showOn) await hud(conn, tab, report, started, stopped);
    if (stopped) break;
  }

  // Repeat a step (usually "click Next") until the page condition holds, the step cannot
  // be done, or max is reached, collecting each page on the way.
  if (repeatStep && !stopped) {
    const loop = { pages: 0, ended: null };
    const acc = { groups: [], seen: new Set(), duplicates: 0 };
    const texts = [];
    const untilQ = expectQuestion(until);
    for (let k = 0; ; k++) {
      loop.pages++;
      if (collect === 'items') mergeItems(acc, await ops.evaluate(conn, tab, itemsExpression({ all: true, maxItems: 200, maxGroups: 12 })), loop.pages);
      else if (collect === 'text') texts.push(`--- page ${loop.pages}: ${view.url}\n${(view.view || '').slice(0, 6000)}`);
      if (k >= max) { loop.ended = `max ${max} repeats`; break; }
      const row = { step: `r${k + 1}`, do: repeat, repeat: k + 1 };
      const res = await runOne(repeatStep, row, { extra: { until: untilQ }, stopIf: a => prob(a.until) >= 0.5, retryMs: 1200, canSkip: true });
      if (res.expectFailed) { stopped = res.stop; break; }
      if (res.met) { loop.ended = `until: ${until}`; loop.pages_checked = k + 1; break; }
      report.steps.push(row);
      if (onStep) await onStep(row).catch(() => {});
      if (showOn) await hud(conn, tab, report, started, null);
      if (row.skipped) { loop.ended = `the step could not be done: ${row.skipped}`; break; }
      if (res.stop) {
        // Overlays, challenges and errors stop the plan; a missing Next button ends the loop.
        if (res.stop.overlay || row.challenge || !res.stop.candidates) { stopped = { step: row.step, ...res.stop }; row.stopped = true; }
        else loop.ended = `the step could not be done: ${res.stop.reason}`;
        break;
      }
    }
    report.loop = loop;
    if (collect === 'items') {
      report.collected = { pages: loop.pages, duplicates: acc.duplicates, groups: acc.groups.map(({ key, ...g }) => ({ ...g, count: g.items.length })) };
      loop.items = report.collected.groups.reduce((n, g) => n + g.count, 0);
    } else if (collect === 'text') report.collected = { pages: loop.pages, text: texts.join('\n\n').slice(0, 20000) };
  }

  // One last request: the last step's expected result, a blocking overlay, and the page
  // flags (a challenge or login wall after the plan is the most common reason a run
  // "worked" but shows nothing useful).
  if (!stopped) {
    const questions = {};
    for (const [id, q] of Object.entries(jev.CHECKS)) questions[id] = noul(q);
    if (pending) questions.prev_expect = expectQuestion(pending.expect);
    if (view.overlay?.trim()) questions.blocker = blockerQuestion();
    try {
      const r = await ask({ page: jev.viewState(view) }, questions);
      const checks = Object.fromEntries(Object.keys(jev.CHECKS).map(id => [id, prob(r.answers[id])]));
      const flags = Object.keys(jev.CHECKS).filter(id => checks[id] >= 0.5);
      if (flags.length) report.flags = flags;
      if (flags.includes('challenge')) report.cooldown = cooldown.record(view.url, { kind: 'challenge (Jev)' });
      if (pending) {
        const p = prob(r.answers.prev_expect);
        pending.row.expect_p = p;
        if (!(p >= 0.5)) stopped = { step: pending.row.step, reason: `Step ${pending.row.step} expected "${pending.expect}", but the page does not show it (p=${p})` };
        pending = null;
      }
      if (prob(r.answers.blocker) >= 0.5 && !stopped) {
        const row = { step: 'end', do: '(after the plan)' };
        const d = categories.length ? await dismissOverlay(row) : { stop: { overlay: clip(view.overlay, 400) } };
        if (row.dismissed) report.steps.push(row);
        if (d.stop) report.overlay = d.stop.overlay; // the plan is done; say what still covers the page
      }
    } catch (e) {
      if (pending) stopped = { step: pending.row.step, reason: e.message };
    }
  }

  // Notes that ran: confirmed when they worked, contradicted when they did not.
  if (applied.size) {
    report.notes_applied = [...applied].map(([id, ok]) => ({ id, ok }));
    for (const { id, ok } of report.notes_applied) { try { ok ? notes.confirm(id) : notes.contradict(id); } catch {} }
  }
  report.ms = Date.now() - started;
  if (stopped) {
    report.stopped = stopped;
    const row = report.steps.find(s => s.step === stopped.step);
    if (row) row.stopped = true;
  }
  report.done = !stopped;
  view = await look().catch(() => view);
  report.page = { url: view.url, title: view.title };
  report.params = await timed('read', ops.evaluate(conn, tab, PAGE_PARAMS)).catch(() => []);
  if (then === 'items' || openN) report.items = await timed('then', ops.evaluate(conn, tab, itemsExpression({})));
  // A plan that ends with its results out of view (scrolled to the foot of a filter sidebar,
  // or back to the top above a tall header): bring the main list's first item into view, so
  // the page shows the results the report lists, as a person checking them would.
  if (report.items && !stopped) {
    const main = mainGroup(report.items);
    if (main?.items?.length && main.items.every(it => it.below || it.above)) {
      const moved = await ops.evaluate(conn, tab, SCROLL_TO_ITEM(main.items[0].id)).catch(() => false);
      if (moved) {
        report.scrolled = main.heading ? `"${clip(main.heading, 50)}"` : 'the results';
        report.items = await timed('then', ops.evaluate(conn, tab, itemsExpression({}))).catch(() => report.items);
      }
    }
  }
  // --open N: open the first N items of the main list (not ads) and return what --grep finds
  // on each, so a list and its drill-down take one call.
  if (openN && report.items) {
    const links = mainLinks(report.items, Number(openN), view.url);
    if (links.length) report.opened = await timed('open', visit(conn, links, { grep, context, show: showOn }));
  } else if (report.items && opts.prefetch !== false) {
    // The agent often opens the first items next: start loading them while it decides.
    report.prefetched = await timed('prefetch', prefetch.start(conn, mainLinks(report.items, 3, view.url))).catch(() => []);
  }
  else if (then === 'text') report.text = `${view.overlay ? `${view.overlay}\n` : ''}${view.view}`.slice(0, 6000);
  if (showOn) await show.busy(conn, tab, false);
  if (traceRun) report.trace = writeTrace(tab, lines, steps, report, { repeat, until });
  return report;
}

function writeTrace(tab, lines, steps, report, { repeat, until }) {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const at = new Date().toISOString();
  const parsed = (row) => (typeof row.step === 'number' ? steps[row.step - 1] : row.repeat ? parseStep(repeat) : null);
  const records = report.steps.map(row => {
    const s = parsed(row);
    return {
      run, at, tab, step: row.step, do: row.do, action: s?.action,
      ...(row.el ? { target: row.el } : {}), ...(row.how ? { how: row.how } : {}),
      url_before: row.url_before, url_after: row.url_after,
      ...(s?.expect ? { expect: s.expect, expect_p: row.expect_p ?? null } : {}),
      ...(row.p !== undefined ? { expect: s?.target, expect_p: row.p } : {}),
      ...(row.dismissed ? { dismissed: row.dismissed.map(({ category, text, control }) => ({ category, text, control })) } : {}),
      ...(row.events ? { events: row.events.map(({ text }) => ({ text })) } : {}),
      ...(row.settle_ms != null ? { settle_ms: row.settle_ms, settle_why: row.settle_why } : {}),
      ...(row.skipped ? { skipped: row.skipped } : {}),
      ...(row.unsure ? { unsure: true } : {}), ...(row.checked !== undefined ? { checked: row.checked } : {}), ...(row.expanded !== undefined ? { expanded: row.expanded } : {}), ...(row.error ? { error: row.error } : {}),
      ...(row.via_notes ? { via_notes: row.via_notes } : {}),
      ...(report.stopped && report.stopped.step === row.step ? { stop: report.stopped.reason } : {}),
      ms: row.ms,
    };
  });
  records.push({
    run, at, tab, kind: 'run', plan: lines, ...(repeat ? { repeat, until } : {}), phases: report.phases,
    done: report.done, ...(report.stopped ? { stopped: report.stopped.reason, stopped_step: report.stopped.step } : {}),
    ms: report.ms, jev_calls: report.jev_calls, events: report.events.length,
    ...(report.loop ? { loop: report.loop } : {}), url: report.page.url, ...(report.flags ? { flags: report.flags } : {}),
  });
  notes.learn(records);
  return trace.append(tab, records);
}

const met = c => c ? (c.solvedBy ? `  [${c.captcha} cleared by ${c.solvedBy}${c.waitedMs ? ` after ${Math.round(c.waitedMs / 1000)} s` : ''}]` : `  [${c.captcha} not cleared]`) : '';

export function formatEvents(events) {
  return events.map(e => e.type === 'note'
    ? `  note ${e.id} (${e.kind}) after step ${e.after_step}: "${clip(e.text, 80)}" ${e.ok ? 'handled' : 'failed'}`
    : e.type === 'dismissed'
    ? `  dismissed ${e.category} after step ${e.after_step}: "${clip(e.text, 80)}" → ${e.control}`
    : `  notice after step ${e.after_step}: "${clip(e.text, 120)}"`);
}

// The main list (mainGroup); badges such as Ad, Sponsored or Spotlight (in the text or
// class hints) mark items that are not part of it.
const AD = /(^|[\s·{,_-])(ad|ads|sponsored|promoted|spotlight)([\s·},_-]|$)/i;
export function mainLinks(items, n, base) {
  const g = mainGroup(items);
  if (!g) return [];
  const out = [];
  for (const it of g.items) {
    if (out.length >= n) break;
    if (!it.link || AD.test(it.text || '') || (it.hints || []).some(h => AD.test(` ${h} `))) continue;
    try { const u = new URL(it.link, base).href; if (!out.includes(u)) out.push(u); } catch {}
  }
  return out;
}

export function formatParams(params) {
  return params.map(p => `${p.name}${p.values.length ? ` (${p.values.join(', ')})` : ''}${p.from.includes('form') ? ' [form]' : ''}`).join(' · ');
}

export function formatSteps(r) {
  const lines = r.challenge ? [`challenge before step 1:${met(r.challenge)}`] : [];
  for (const s of r.steps) {
    const mark = s.stopped ? '✗' : s.skipped ? '–' : s.unsure ? '⚠' : '✓';
    const p = s.p !== undefined ? ` (p=${s.p})` : s.expect_p !== undefined ? ` (expected p=${s.expect_p})` : '';
    lines.push(`${mark} ${s.step}. ${s.do}${s.target ? `  → ${s.target}` : ''}${s.how ? ` (${s.how})` : ''}${p}${s.unsure ? '  unsure: check the page' : ''}${s.checked !== undefined ? (s.already ? `  already ${s.pressed_kind ? 'pressed' : 'checked'}` : `  now ${s.pressed_kind ? (s.checked ? 'pressed' : 'not pressed') : s.checked ? 'checked' : 'unchecked'}`) : ''}${s.slider !== undefined ? `  now ${s.slider}` : ''}${s.expanded !== undefined ? `  ${s.already && s.checked === undefined ? 'already' : 'now'} ${s.expanded ? 'open' : 'closed'}` : ''}${s.skipped ? `  skipped: ${s.skipped}` : ''}  ${s.ms ?? 0} ms${met(s.challenge)}${s.url_change ? `\n     url: ${s.url_change}` : ''}`);
    // A reveal step that could not run was skipped (the page was already past it).
    for (const v of s.via_notes || []) lines.push(`     ${v.ok || (v.kind === 'reveal' && s.how?.includes(`via note ${v.id}`)) ? 'via' : 'tried'} note ${v.id} (${v.kind}): ${(s.note_steps || []).map(n => `${n.do}${n.stopped ? (v.kind === 'reveal' ? ' (skipped)' : ' ✗') : ''}`).join(' → ')}`);
    for (const h of s.hints || []) lines.push(`     hint: ${h}`);
  }
  for (const sg of r.suggestions || []) lines.push(`note ${sg.id}: ${sg.text}`);
  if (r.notes_applied?.length) lines.push(`notes: ${r.notes_applied.map(n => `${n.id} ${n.ok ? 'confirmed' : 'contradicted'}`).join(', ')}`);
  if (r.events?.length) lines.push('\nevents:', ...formatEvents(r.events));
  if (r.loop) lines.push(`\nrepeated over ${r.loop.pages} pages, ended by ${r.loop.ended}`);
  if (r.stopped) {
    lines.push(`\nStopped ${r.stopped.step ? `at step ${r.stopped.step}` : 'before step 1'}: ${r.stopped.reason}`);
    for (const c of r.stopped.candidates || []) lines.push(`  ${String(Math.round(c.p * 100)).padStart(3)}%  ${c.ref}${c.name ? ` ${c.role} "${c.name.slice(0, 60)}"` : ''}`);
    if (r.stopped.hidden) lines.push(`Present but hidden: ${r.stopped.hidden.join('; ')}`);
    if (r.stopped.covered) lines.push(`Covered: ${r.stopped.covered}`);
    if (r.stopped.onTop) lines.push(`On top: ${r.stopped.onTop}`);
    if (r.stopped.overlay) lines.push(`Overlay: "${clip(r.stopped.overlay, 300)}"`);
    if (r.stopped.controls) lines.push(`${r.stopped.overlay ? 'Overlay controls' : 'On screen'}: ${r.stopped.controls.join(', ')}`);
  }
  if (r.overlay) lines.push(`\nStill covering the page: "${clip(r.overlay, 300)}"`);
  if (r.params?.length) lines.push(`\nurl params (set them with a nav step): ${formatParams(r.params)}`);
  lines.push(`\n${r.page.title}\n${r.page.url}${r.flags ? `\nflags: ${r.flags.join(', ')}` : ''}${r.cooldown ? `\ncool-down: ${cooldown.describe(r.cooldown)}` : ''}   total ${r.ms} ms, ${r.jev_calls} Jev calls`);
  if (r.collected?.groups) {
    lines.push(`\ncollected ${r.collected.groups.reduce((n, g) => n + g.count, 0)} items over ${r.collected.pages} pages (${r.collected.duplicates} duplicates dropped)`);
    for (const g of r.collected.groups) {
      lines.push(`${g.id}  ${[g.region, g.heading && `"${g.heading}"`, g.label && `[${g.label}]`].filter(Boolean).join(' · ') || '(no region)'}  · ${g.count} items`);
      for (const it of g.items) lines.push(`  p${it.page} ${clip(it.text, 160) || '(no text)'}${it.link ? `  → ${it.link.slice(0, 80)}` : ''}`);
    }
  } else if (r.collected?.text) lines.push(`\n${r.collected.text}`);
  if (r.scrolled) lines.push(`\nscrolled the results into view (${r.scrolled})`);
  if (r.items) lines.push(`\n${formatItems(r.items, { main: true })}`);
  if (r.opened) lines.push(`\nopened ${r.opened.length}:\n${formatVisits(r.opened)}`);
  if (r.text) lines.push(`\n${r.text}`);
  return lines.join('\n');
}
