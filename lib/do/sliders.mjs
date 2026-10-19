// Sliders: find the one a step names (alone or as a range), and move each thumb to its value
// as a person would: its value (native), then keys, then a drag along its track.
import * as ops from '../ops.mjs';
import * as jev from '../jev.mjs';
import { page } from '../page/index.mjs';
import { SLIDER, sleep } from '../timing.mjs';
import { sliderValues } from './parse.mjs';
import { findDirect, sameWords } from './ground.mjs';
import { norm, clip, pinKey } from './context.mjs';

// The slider (or range) a step names: by its own or its group's words, or directly by ref
// or selector. score is the share of the step's words found (1 = all of them).
export async function matchSlider(ctx, step) {
  const { conn, tab } = ctx;
  const pin = pinKey();
  let only = null;
  if (step.ref || step.item || step.selector) {
    const d = await findDirect(ctx, step, null);
    if (d?.stop) return d;
    only = d?.el?.selector || null;
    if (!only) return null;
  }
  const groups = await ops.evaluate(conn, tab, page('slider-find', { pin, only })).catch(() => []);
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
export async function moveThumb(ctx, th, v) {
  const { conn, tab } = ctx;
  const read = () => ops.evaluate(conn, tab, page('slider-state', { selector: th.selector })).catch(() => null);
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
    await ops.evaluate(conn, tab, page('slider-set-native', { selector: th.selector, value: goal })).catch(() => null);
    st = await read();
    if (st && close(st.now)) return { now: st.now, how: 'value', goal };
  }
  // Keys, as a person using the keyboard would: Home and End for the limits, arrows (and
  // Page keys for long ways) toward the value, watching the value after each press.
  // The pointer rests on the thumb, as a person's would: a panel that opened on hover (a
  // filter flyout) closes when the pointer is elsewhere.
  if (Number.isFinite(st.x) && Number.isFinite(st.y)) await ops.hover(conn, tab, { x: Math.round(st.x), y: Math.round(st.y) }).catch(() => {});
  await ops.evaluate(conn, tab, page('focus', { selector: th.selector })).catch(() => false);
  // A busy page applies a key a moment late: read once more before calling a press stalled.
  const press = async (k) => {
    const was = now;
    await ops.key(conn, tab, k);
    let n = (await read())?.now;
    if (n === was) { await sleep(SLIDER.KEY_LATE); n = (await read())?.now; }
    return n;
  };
  let now = st.now, moved = false, passed = false;
  if (goal === th.min || goal === th.max) {
    const n = await press(goal === th.min ? 'Home' : 'End');
    if (Number.isFinite(n) && n !== now) { moved = true; now = n; if (close(now)) return { now, how: 'keys', goal }; }
  }
  const t0 = Date.now();
  let axis = 0, stalls = 0, presses = 0, big = null;
  const KEYS = [['ArrowRight', 'ArrowLeft'], ['ArrowUp', 'ArrowDown']];
  while (presses < SLIDER.PRESSES_MAX && Date.now() - t0 < SLIDER.KEYS_MAX && !close(now)) {
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
      passed = true;
      if (Math.abs(before - goal) < Math.abs(now - goal)) now = await press(KEYS[axis][up ? 1 : 0]);
      break;
    }
  }
  // A slow page applies keys late, so the count above can drift: read the value once it
  // has settled, then nudge one key at a time, waiting for each.
  if (moved && !close(now)) {
    await sleep(SLIDER.NUDGE);
    const fin = (await read())?.now;
    if (Number.isFinite(fin)) now = fin;
    for (let k = 0, still = 0; k < 20 && !close(now) && still < 3; k++) {
      const up = goal > now, before = now;
      await ops.key(conn, tab, KEYS[axis][up ? 0 : 1]);
      await sleep(SLIDER.NUDGE);
      const n = (await read())?.now;
      if (!Number.isFinite(n) || n === before) { still++; continue; }
      now = n;
      if ((up && now > goal) || (!up && now < goal)) { passed = true; break; }
    }
  }
  // Within a step only when its steps skip the value; a slider that stopped short is not there.
  if (moved && (close(now) || (passed && Math.abs(now - goal) <= unit))) return { now, how: 'keys', goal };
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
export async function setSlider(ctx, step, row, found) {
  const m = found || await matchSlider(ctx, step);
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
    const r = await ctx.timed('input', moveThumb(ctx, th, v));
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

// A fill whose value is a number, on a slider of exactly that name, sets the slider. A text
// box for the same value ("Max Price $" beside the price slider) takes the number exactly; a
// slider rounds it to its steps. Prefer the box, unless the step named the slider directly.
// Returns the slider to set, or null.
export async function sliderForFill(ctx, step) {
  if (step.action !== 'fill' || !sliderValues(step.value)) return null;
  const m = await matchSlider(ctx, step).catch(() => null);
  if (!(m?.group && (m.exact || m.direct))) return null;
  if (!m.direct) {
    const boxes = await ctx.readPage().catch(() => null);
    if (boxes && jev.candidatesFor(boxes.elements, 'fill').some(e => e.role !== 'slider' && sameWords(e.name || e.placeholder, step.target))) return null;
  }
  return m;
}
