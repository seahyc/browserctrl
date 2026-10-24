import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as notes from '../lib/notes.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev } from './fake-jev.mjs';
import { ranking } from '../lib/do/rank-lines.mjs';
import { UNAVAILABLE } from '../lib/judge.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

let fixture, browser, conn;
const haveBrowser = Boolean(chromeBinary());
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { await conn?.stop(); } catch {}
  conn?.close();
  await browser?.close();
  await fixture?.close();
});
const t = (name, fn) => test(name, { skip: !haveBrowser }, async () => {
  const tab = (await ops.newTab(conn, fixture.url + 'fixtures/page.html')).targetId;
  await ops.waitForReady(conn, tab);
  try { await fn(tab); } finally { await ops.closeTab(conn, tab); }
});
async function listing(tab, rows) {
  const cards = rows.map((row, i) => `<li style="width:600px;height:90px"${row.hint ? ` data-testid="${row.hint}"` : ''}><a href="/detail/${row.link || i + 1}">${row.name}</a><p>${row.price ?? ''}</p><span>${row.policy || 'free cancellation'}</span></li>`).join('');
  await ops.evaluate(conn, tab, `document.body.innerHTML=${JSON.stringify(`<button id="ready">Ready</button><main><h1>Hotels</h1><ul>${cards}</ul></main>`)}; window.sourceMarker=42`);
}
// Rules answer eligibility; a price ranking with no requirement beyond availability asks
// whether the item says it is sold out or unavailable instead, answered as the inverse.
const rankedJev = (rules = {}) => {
  const { noul = (q, id) => id.endsWith('.eligible') || id === 'prev_expect' ? .95 : .04, ...rest } = rules;
  return fakeJev({
    choice: (q, id) => id.endsWith('.key') ? Object.keys(q.criteria).find(k => k !== 'none') || 'none' : 'none',
    ...rest,
    noul: (q, id, state) => { const p = noul(q, id, state); return q.instructions.startsWith(UNAVAILABLE) ? 1 - p : p; },
  });
};
const run = (tab, plan, jev) => runSteps(conn, tab, plan, { jev, noNotes: true, traceRun: false, prefetch: false });
const choices = report => report.bindings.find(b => b.name === 'choices').value;
const selectionCall = jev => jev.calls.filter(call => Object.keys(call.questions).some(key => key.endsWith('.eligible')));

test('pure first and page-order ranking criteria do not require a value key', () => {
  assert.deepEqual(ranking('first in page order'), { type: 'order', direction: 1 });
  assert.deepEqual(ranking('first'), { type: 'order', direction: 1 });
  assert.deepEqual(ranking('first available cabin'), { type: 'order', direction: 1 });
});

t('ranked top-k sorts numeric keys locally, preserves ties, and never opens details', async tab => {
  await listing(tab, [
    { name: 'First', price: 'SGD 200' },
    { name: 'Second', price: 'SGD 100' },
    { name: 'Third', price: 'SGD 100' },
  ]);
  const before = (await ops.tabs(conn)).map(t => t.id).sort();
  const source = await ops.evaluate(conn, tab, '({url:location.href,html:document.body.innerHTML})');
  const j = rankedJev();
  const r = await run(tab, ['pick "lowest listed price with free cancellation" top 3 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.key), [100, 100, 200]);
  assert.match(choices(r)[0].text, /Second/);
  assert.match(choices(r)[1].text, /Third/);
  assert.equal(r.steps[0].tie_order, 'page order');
  assert.equal(selectionCall(j).length, 1);
  assert.equal(Object.keys(selectionCall(j)[0].questions).filter(k => k.endsWith('.eligible')).length, 3);
  assert.equal(Object.keys(selectionCall(j)[0].questions).filter(k => k.endsWith('.key')).length, 3);
  assert.equal(choices(r)[0].evidence.raw, 'SGD 100');
  assert.equal(choices(r)[0].eligibility_p, .95);
  assert.equal(r.steps[0].coverage.offered, 3);
  assert.deepEqual((await ops.tabs(conn)).map(t => t.id).sort(), before);
  assert.deepEqual(await ops.evaluate(conn, tab, '({url:location.href,html:document.body.innerHTML})'), source);
  assert.equal(await ops.evaluate(conn, tab, 'sourceMarker'), 42);
  assert.match(formatSteps(r), /✓ done:/);
});

t('ranked picks report fewer than k eligible matches and source exhaustion', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'SGD 100' }, { name: 'Third', price: 'SGD 300' }]);
  const j = rankedJev({ noul: (q, id) => id.endsWith('.eligible') ? /First|Third/.test(q.instructions.split('Item ')[1]) ? .1 : .95 : .04 });
  const r = await run(tab, ['pick "lowest listed price" top 3 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(choices(r).length, 1);
  assert.equal(choices(r)[0].key, 100);
  assert.equal(r.steps[0].source_exhausted, true);
});

t('ranked shortlist excludes ad text and Spotlight hints before requesting judgments', async tab => {
  await listing(tab, [{ name: 'Organic', price: 'SGD 200' }, { name: 'Sponsored offer', price: 'SGD 1' }, { name: 'Featured offer', price: 'SGD 2', hint: 'spotlight' }, { name: 'Other organic', price: 'SGD 100' }]);
  const j = rankedJev();
  const r = await run(tab, ['pick "lowest price" top 3 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.key), [100, 200]);
  const questions = selectionCall(j)[0].questions;
  assert.equal(Object.keys(questions).filter(k => k.endsWith('.eligible')).length, 2);
  assert.ok(!JSON.stringify(questions).includes('SGD 1"'));
  assert.ok(!JSON.stringify(questions).includes('Featured offer'));
});

t('ranked pick stops on an eligible item with no observable price', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'Contact hotel' }, { name: 'Third', price: 'SGD 100' }]);
  const j = rankedJev();
  const r = await run(tab, ['pick "lowest price" top 2 as $choices'], j);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /Missing or uncertain observable sort key/);
  assert.ok(!r.bindings?.length);
  assert.equal(selectionCall(j).length, 1);
});

t('ranked vague quality criteria stop without asking Jev', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'SGD 100' }, { name: 'Third', price: 'SGD 300' }]);
  const j = rankedJev();
  const r = await run(tab, ['pick "best overall hotel" top 2 as $choices'], j);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /observable numeric\/date/);
  assert.equal(selectionCall(j).length, 0);
});

t('ranked choice distributions select per-item keys, never a confidence runner-up list', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 300', policy: 'free cancellation, rating 5' }, { name: 'Second', price: 'SGD 100', policy: 'free cancellation, rating 4' }, { name: 'Third', price: 'SGD 200', policy: 'free cancellation, rating 3' }]);
  const j = rankedJev({ choice: (q, id) => {
    if (!id.endsWith('.key')) return 'none';
    const price = Object.keys(q.criteria).find(key => q.criteria[key].startsWith('SGD '));
    const other = Object.keys(q.criteria).find(key => key !== 'none' && key !== price);
    return { choice: price, probabilities: { [price]: .8, ...(other ? { [other]: .15 } : {}), none: .05 } };
  } });
  const r = await run(tab, ['pick "lowest listed price" top 2 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.key), [100, 200]);
  assert.equal(selectionCall(j).length, 1);
});

t('ranked entry bundles the pending expectation with all item questions', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'SGD 100' }, { name: 'Third', price: 'SGD 300' }]);
  await ops.evaluate(conn, tab, `document.querySelector('#ready').onclick = () => { document.body.dataset.ready = 'true'; }`);
  const j = rankedJev();
  const r = await run(tab, ['click "Ready" => "ready"', 'pick "lowest price" top 2 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  const request = selectionCall(j)[0];
  assert.ok(request.questions.prev_expect);
  assert.equal(Object.keys(request.questions).filter(k => k.endsWith('.key')).length, 3);
});

t('ranked date keys sort calendar dates locally', async tab => {
  await listing(tab, [{ name: 'First', price: '2026-03-04' }, { name: 'Second', price: '2026-01-02' }, { name: 'Third', price: '2026-02-03' }]);
  const r = await run(tab, ['pick "earliest listed date" top 2 as $choices'], rankedJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.key), ['2026-01-02', '2026-02-03']);
});

t('page-order-only criteria rank the main listing without Jev or line extraction', async tab => {
  await listing(tab, [{ name: 'First', price: '' }, { name: 'Second', price: '' }, { name: 'Third', price: '' }]);
  const j = rankedJev();
  const r = await run(tab, ['pick "first in page order" top 2 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.text.match(/First|Second|Third/)?.[0]), ['First', 'Second']);
  assert.equal(selectionCall(j).length, 0);
});

t('mixed price periods choose primary prices, report excluded units, and honor requested unit', async tab => {
  await listing(tab, [
    { name: 'A', price: '$100 per person · was $120 per person' },
    { name: 'B', price: '$80 per person' },
    { name: 'C', price: '$30 per night' },
  ]);
  const j = rankedJev({ choice: (q, id) => id.endsWith('.key') ? Object.keys(q.criteria).find(k => k !== 'none') || 'none' : 'none' });
  const r = await run(tab, ['pick "lowest listed price per person" top 1 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(choices(r)[0].key, 80);
  assert.match(r.steps[0].excluded.join(' '), /i\d+ excluded/);
});

t('unresolved eligibility that could change top K answers provisionally and names the item', async tab => {
  await listing(tab, [{ name: 'Resolved A', price: 'SGD 200' }, { name: 'Unresolved', price: 'SGD 1' }, { name: 'Resolved B', price: 'SGD 100' }]);
  const j = rankedJev({ noul: (q, id) => id.endsWith('.eligible') || id.endsWith('.confirm') ? /Unresolved/.test(q.instructions) ? .5 : .95 : .04 });
  const r = await run(tab, ['pick "lowest price" top 1 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(choices(r)[0].text, /Resolved B/);
  assert.match(r.bindings[0].provisional, /unresolved for i\d+ \(SGD 1\), which could be in the top 1/);
});

for (const p of [.749, .251]) {
  t(`ranked membership ${p} stops without rounding across confidence boundaries`, async tab => {
    await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'SGD 100' }, { name: 'Third', price: 'SGD 300' }]);
    const j = rankedJev({ noul: (q, id) => id.endsWith('.eligible') || id.endsWith('.confirm') ? p : .04 });
    const r = await run(tab, ['pick "lowest price" top 2 as $choices'], j);
    assert.equal(r.done, false);
    assert.match(r.stopped.reason, /eligibility unresolved/);
    assert.ok(!r.bindings?.length);
  });
}

t('ranked entry keeps source unchanged when a runnable on-note matches', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'SGD 100' }, { name: 'Third', price: 'SGD 300' }]);
  await ops.evaluate(conn, tab, `document.body.insertAdjacentHTML('afterbegin','<button id="changeSource">Change source</button>'); changeSource.onclick=()=>{sourceMarker++;document.querySelector('main').remove()}`);
  const source = await ops.evaluate(conn, tab, '({url:location.href,html:document.body.innerHTML,marker:sourceMarker})');
  try {
    const added = await notes.add(source.url, 'The source filter is available', { force: true, on: { situation: 'the source filter is available', steps: ['click "Change source"'] } });
    assert.equal(added.ok, true, JSON.stringify(added));
    const j = rankedJev({ noul: (q, id) => id.startsWith('on_') || id.endsWith('.eligible') ? .95 : .04 });
    const r = await runSteps(conn, tab, ['pick "lowest price" top 2 as $choices'], { jev: j, noNotes: false, traceRun: false, prefetch: false });
    assert.equal(r.done, true, JSON.stringify(r.stopped));
    assert.deepEqual(choices(r).map(item => item.key), [100, 200]);
    assert.deepEqual(await ops.evaluate(conn, tab, '({url:location.href,html:document.body.innerHTML,marker:sourceMarker})'), source);
    assert.ok(j.calls.every(call => Object.keys(call.questions).every(id => !id.startsWith('on_'))));
  } finally {
    notes.clear(source.url);
  }
});

// Real stop shapes from the om2w ablation: mixed price formats, ranges, per-night vs total,
// other currencies, borderline eligibility, product cards that are not a list, heading-led results.
async function page(tab, html) {
  await ops.evaluate(conn, tab, `document.body.innerHTML=${JSON.stringify(html)}`);
}
const ids = (tab, names) => ops.evaluate(conn, tab, `(${JSON.stringify(names)}).map(n => { const s = window.__bcItems; for (const el of document.querySelectorAll('body *')) if (s && s.ids.get(el) && (el.innerText || '').startsWith(n)) return s.ids.get(el); return null; })`);
const keyLabels = jev => selectionCall(jev).flatMap(call => Object.entries(call.questions).filter(([k]) => k.endsWith('.key')).flatMap(([, q]) => Object.values(q.criteria)));
const confirmCalls = jev => jev.calls.filter(call => Object.keys(call.questions).some(key => key.endsWith('.confirm')));

t('the same currency written as "$" and "USD" is compared as one currency and says so', async tab => {
  await listing(tab, [
    { name: 'Cruise A', price: 'from $1,299 per person' },
    { name: 'Cruise B', price: 'USD 899 per person' },
    { name: 'Cruise C', price: '$1,050 per person' },
  ]);
  const r = await run(tab, ['pick "lowest price" top 2 as $choices'], rankedJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.key), [899, 1050]);
  assert.match(choices(r)[0].text, /Cruise B/);
  assert.match(formatSteps(r), /note: "\$" read as USD/);
  assert.ok(!r.steps[0].excluded?.length);
});

t('price ranges rank by their low end for lowest and their high end for highest, and say so', async tab => {
  await listing(tab, [
    { name: 'Suite', price: '$99–$149 per night' },
    { name: 'Double', price: '$120 per night' },
    { name: 'Single', price: '$140 per night' },
  ]);
  const low = rankedJev();
  const r = await run(tab, ['pick "lowest price" top 1 as $choices'], low);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(choices(r)[0].text, /Suite/);
  assert.equal(choices(r)[0].key, 99);
  assert.ok(keyLabels(low).includes('$99 (low end of the range $99–$149)'));
  assert.match(formatSteps(r), /lists a range \$99–\$149; ranked by its low end/);
  const r2 = await run(tab, ['pick "highest price" top 1 as $choices'], rankedJev());
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.match(choices(r2)[0].text, /Suite/);
  assert.equal(choices(r2)[0].key, 149);
  assert.match(formatSteps(r2), /ranked by its high end/);
});

t('a range is never ranked by the wrong end: highest picks a plain price above the range top', async tab => {
  await listing(tab, [{ name: 'Suite', price: '$99–$149' }, { name: 'Loft', price: '$140' }, { name: 'Villa', price: '$200' }]);
  const r = await run(tab, ['pick "lowest price" top 3 as $choices'], rankedJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.key), [99, 140, 200]);
  const r2 = await run(tab, ['pick "highest price" top 2 as $choices'], rankedJev());
  assert.deepEqual(choices(r2).map(item => item.key), [200, 149]);
});

t('per-night and total prices are compared only within the basis most items share; a cheaper total is reported', async tab => {
  await listing(tab, [
    { name: 'Hotel A', price: 'from $45/night' },
    { name: 'Hotel B', price: '$60/night' },
    { name: 'Hotel C', price: '$40 total' },
    { name: 'Hotel D', price: '$52 per night' },
  ]);
  const r = await run(tab, ['pick "lowest price" top 1 as $choices'], rankedJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(choices(r)[0].text, /Hotel A/);
  assert.equal(choices(r)[0].evidence.unit, 'night');
  const [c] = await ids(tab, ['Hotel C']);
  const line = r.steps[0].excluded.find(x => x.startsWith(c));
  assert.match(line, /\$40 is total price; most items are per night/);
  assert.match(line, /⚠ at face value it would be in the top 1/);
  assert.match(formatSteps(r), new RegExp(`${c} excluded: \\$40 is total price`));
  const r2 = await run(tab, ['pick "lowest total price" top 1 as $choices'], rankedJev());
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.match(choices(r2)[0].text, /Hotel C/);
});

t('a monthly instalment or deposit is never read as the price', async tab => {
  await listing(tab, [
    { name: 'Sailing A', price: '$428* · or from $46/mo · average per person' },
    { name: 'Sailing B', price: 'deposits from $49* · $512* · or from $55/mo · average per person' },
    { name: 'Sailing C', price: '$610* · or from $66/mo · average per person' },
  ]);
  const j = rankedJev();
  const r = await run(tab, ['pick "lowest price" top 2 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.key), [428, 512]);
  assert.ok(!keyLabels(j).some(label => /\$4[69]\b|\$55|\$66/.test(label)), JSON.stringify(keyLabels(j)));
});

t('another currency is ranked apart: the majority currency answers and a cheaper excluded item is reported', async tab => {
  await listing(tab, [
    { name: 'Desk A', price: 'USD 300' },
    { name: 'Desk B', price: 'EUR 80' },
    { name: 'Desk C', price: 'USD 250' },
    { name: 'Desk D', price: 'USD 410' },
  ]);
  const r = await run(tab, ['pick "lowest price" top 1 as $choices'], rankedJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(choices(r)[0].text, /Desk C/);
  assert.equal(choices(r)[0].key, 250);
  const [b] = await ids(tab, ['Desk B']);
  assert.match(formatSteps(r), new RegExp(`${b} excluded: EUR 80 is in EUR; most items are in USD and no conversion is made ⚠ at face value it would be in the top 1`));
  const r2 = await run(tab, ['pick "lowest EUR price" top 1 as $choices'], rankedJev());
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.match(choices(r2)[0].text, /Desk B/);
});

t('currencies split evenly stop with the criterion form that resolves them', async tab => {
  await listing(tab, [{ name: 'Lamp A', price: 'USD 30' }, { name: 'Lamp B', price: 'EUR 20' }, { name: 'Lamp C', price: 'USD 25' }, { name: 'Lamp D', price: 'EUR 35' }]);
  const r = await run(tab, ['pick "lowest price" top 1 as $choices'], rankedJev());
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /split evenly between .*USD.* and .*EUR/);
  assert.match(r.stopped.reason, /pick "lowest (USD|EUR) price" top 1/);
  assert.ok(!r.bindings?.length);
});

t('borderline eligibility below the chosen keys is ignored and reported without a confirmation call', async tab => {
  await listing(tab, [{ name: 'Sofa A', price: 'SGD 300' }, { name: 'Sofa Borderline', price: 'SGD 900' }, { name: 'Sofa B', price: 'SGD 200' }]);
  const j = rankedJev({ noul: (q, id) => id.endsWith('.eligible') ? /Borderline/.test(q.instructions) ? .5 : .95 : .04 });
  const r = await run(tab, ['pick "lowest price leather sofa" top 2 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.key), [200, 300]);
  assert.equal(confirmCalls(j).length, 0);
  assert.match(formatSteps(r), /unresolved, not ranked: its key cannot reach the top 2/);
});

t('borderline items that could be in the answer get one batched confirmation of the requirement', async tab => {
  await listing(tab, [{ name: 'Sofa A', price: 'SGD 300' }, { name: 'Sofa Maybe One', price: 'SGD 100' }, { name: 'Sofa Maybe Two', price: 'SGD 150' }, { name: 'Sofa Far', price: 'SGD 900' }]);
  const j = rankedJev({ noul: (q, id) => {
    if (id.endsWith('.eligible')) return /Maybe|Far/.test(q.instructions) ? .5 : .95;
    if (id.endsWith('.confirm')) return /Maybe One/.test(q.instructions) ? .1 : .9;
    return .04;
  } });
  const r = await run(tab, ['pick "lowest price leather sofa" top 1 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(choices(r)[0].text, /Maybe Two/);
  assert.equal(confirmCalls(j).length, 1);
  const asked = Object.keys(confirmCalls(j)[0].questions).filter(k => k.endsWith('.confirm'));
  assert.equal(asked.length, 2);
  assert.match(confirmCalls(j)[0].questions[asked[0]].instructions, /requirement "leather sofa"/);
  assert.ok(!JSON.stringify(confirmCalls(j)[0].questions).includes('Sofa Far'));
});

t('a borderline item still unresolved after confirmation yields a ⚠ provisional best resolved pick, never a certain one', async tab => {
  await listing(tab, [{ name: 'Sofa A', price: 'SGD 300' }, { name: 'Sofa Maybe', price: 'SGD 100' }, { name: 'Sofa B', price: 'SGD 400' }]);
  const j = rankedJev({ noul: (q, id) => id.endsWith('.eligible') || id.endsWith('.confirm') ? /Maybe/.test(q.instructions) ? .5 : .95 : .04 });
  const r = await run(tab, ['pick "lowest price leather sofa" top 1 as $choices', 'answer "${choices.title}"'], j);
  const [maybe] = await ids(tab, ['Sofa Maybe']);
  assert.equal(confirmCalls(j).length, 1);
  assert.match(choices(r)[0].text, /Sofa A/);
  // Never certain: the binding is provisional with p at most 0.5, the step and run are unsure,
  // the answer is provisional, and the unresolved item is named with its price.
  const binding = r.bindings.find(b => b.name === 'choices');
  assert.ok(binding.p <= 0.5, String(binding.p));
  assert.match(binding.provisional, new RegExp(`eligibility unresolved for ${maybe} \\(SGD 100\\), which could be in the top 1`));
  assert.equal(r.steps[0].unsure, true);
  assert.equal(r.unsure, true);
  assert.equal(r.answer, 'Sofa A');
  assert.equal(r.answer_provisional, true);
  const out = formatSteps(r);
  assert.match(out, /^⚠ 1\. pick "lowest price leather sofa"/m);
  assert.match(out, new RegExp(`⚠ provisional: best resolved items only; eligibility unresolved for ${maybe} \\(SGD 100\\)`));
  assert.match(out, /answer: Sofa A \(provisional\)/);
  assert.match(out, /unsure: a ranked pick is provisional/);
  assert.doesNotMatch(out, /✓ 1\. pick/);
});

t('borderline items with no resolved alternative still stop', async tab => {
  await listing(tab, [{ name: 'Sofa Maybe A', price: 'SGD 300' }, { name: 'Sofa Maybe B', price: 'SGD 100' }, { name: 'Sofa No', price: 'SGD 50' }]);
  const j = rankedJev({ noul: (q, id) => id.endsWith('.eligible') || id.endsWith('.confirm') ? /Maybe/.test(q.instructions) ? .5 : .05 : .04 });
  const r = await run(tab, ['pick "lowest price leather sofa" top 1 as $choices'], j);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /Ranked eligibility unresolved for i\d+ \(SGD \d+\), i\d+ \(SGD \d+\)/);
  assert.ok(!r.bindings?.length);
});

t('a shown price before a hidden "Previous price" label does not hide a tie with an unresolved item', async tab => {
  await listing(tab, [
    { name: 'FINNALA Clearance', price: '$1,699.00Previous price $ 1699.00 · $1,299.00Price $ 1299.00 · 23% off, save $400.00' },
    { name: 'KIVIK', price: '$1,299.00Price $ 1299.00' },
    { name: 'EKTORP', price: '$1,499.00Price $ 1499.00' },
  ]);
  const j = rankedJev({ noul: (q, id) => id.endsWith('.eligible') || id.endsWith('.confirm') ? /FINNALA/.test(q.instructions) ? .5 : .95 : .04 });
  const r = await run(tab, ['pick "lowest price black leather sofa" top 1 as $choices'], j);
  assert.match(choices(r)[0].text, /KIVIK/);
  assert.match(r.bindings[0].provisional, /unresolved for i\d+ \(\$1,299\.00\)/);
  assert.ok(r.bindings[0].p <= 0.5);
  assert.ok(!keyLabels(j).some(label => /1699|400/.test(label)), JSON.stringify(keyLabels(j)));
});

// B&H: each product card holds its own non-link heading, so every headline-led card was a
// group of one and two of them tied on area.
const cards = products => products.map((p, i) => {
  const tag = ['article', 'div', 'section'][i % 3];
  return `<${tag} style="display:block;width:${600 + i * 7}px;margin:12px 0;padding:8px"><h3><a href="/product/${i + 1}">${p.name} with M4 Max 16-Core CPU</a></h3><h4>Shipping Restriction:</h4><p>No shipping to SINGAPORE</p><div><span>${p.price}</span><button>Add to Cart</button><span>In Stock</span></div></${tag}>`;
}).join('');

t('product cards that are not a list, each a headline group of one, rank as one list', async tab => {
  await page(tab, `<main><h2>Search Within Results</h2>${cards([
    { name: 'Mac Studio Silver', price: '$8,899<sup>00</sup>' },
    { name: 'Mac Studio Used', price: '$899<sup>00</sup>' },
    { name: 'Mac Studio Grey', price: '$9,084<sup>00</sup>' },
    { name: 'Mac Studio Refurb', price: '$2,499<sup>00</sup>' },
  ])}</main>`);
  const r = await run(tab, ['pick "lowest price" top 2 as $choices'], rankedJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(choices(r)[0].text, /Mac Studio Used/);
  assert.match(choices(r)[1].text, /Mac Studio Refurb/);
  assert.deepEqual(choices(r).map(item => item.key), [899, 2499]);
  assert.match(choices(r)[0].text, /\$899\.00/);
  assert.match(choices(r)[0].link, /\/product\/2$/);
  assert.match(formatSteps(r), /note: list: .*headlines outside lists.*4 items with the sort key/);
});

// Results led by a plain heading each, in blocks of different tags and classes: no sibling
// group, no headline link, no repeated class.
const blocks = rows => rows.map((row, i) => {
  const tag = ['div', 'section', 'article'][i % 3];
  return `<${tag} class="result-${i}" style="display:block;margin:10px 0"><h3>${row.name}</h3><p>${row.detail}</p><a href="/r/${i + 1}">View</a></${tag}>`;
}).join('');

t('heading-led results without a list rank by price and by page order', async tab => {
  await page(tab, `<main><h1>Laptops</h1><div style="display:flex;gap:8px"><a href="/f/1">Filter one</a><a href="/f/2">Filter two</a></div>${blocks([
    { name: 'Laptop Alpha 14', detail: 'Our price: S$1,499' },
    { name: 'Laptop Beta 13', detail: 'Our price: S$1,099' },
    { name: 'Laptop Gamma 16', detail: 'Our price: S$2,199' },
  ])}</main>`);
  const r = await run(tab, ['pick "lowest price" top 1 as $choices'], rankedJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(choices(r)[0].text, /Laptop Beta 13/);
  assert.equal(choices(r)[0].key, 1099);
  assert.match(choices(r)[0].link, /\/r\/2$/);
  const r2 = await run(tab, ['pick "first" top 2 as $choices'], rankedJev());
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.deepEqual(choices(r2).map(item => item.text.match(/Laptop \w+/)[0]), ['Laptop Alpha', 'Laptop Beta']);
  const [beta] = await ids(tab, ['Laptop Beta']);
  assert.equal(choices(r)[0].id, beta);
});

t('a list still redrawing after a sort is read again before ranking', async tab => {
  await page(tab, `<main><div id="chips"><button>8 Days</button><button>14 Days</button><button>15 Days</button></div><h2>Cruise Results</h2><ul id="results"></ul></main>`);
  await ops.evaluate(conn, tab, `setTimeout(() => { results.innerHTML = ${JSON.stringify(['8-Day Mexican Riviera · $428* · average per person', '14-Day Hawaii · $1,299* · average per person', '15-Day South America · $1,104* · average per person'].map((x, i) => `<li style="height:80px"><h3><a href="/itin/${i + 1}">${x.split(' · ')[0]}</a></h3><p>${x.split(' · ').slice(1).join(' · ')}</p></li>`).join(''))}; }, 250)`);
  const r = await run(tab, ['pick "lowest price" top 1 as $choices'], rankedJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(choices(r)[0].text, /Mexican Riviera/);
  assert.equal(choices(r)[0].key, 428);
});

t('groups tied on keyed and linked items still stop as ambiguous', async tab => {
  const half = (label, a, b, c) => `<section aria-label="${label}"><ul>${[a, b, c].map((x, i) => `<li style="width:500px;height:60px"><a href="/${label}/${i}">${label} item ${i}</a> <span>${x}</span></li>`).join('')}</ul></section>`;
  await page(tab, `<main>${half('North', 'SGD 10', 'SGD 20', 'SGD 30')}${half('South', 'SGD 5', 'SGD 15', 'SGD 25')}</main>`);
  const r = await run(tab, ['pick "lowest price" top 1 as $choices'], rankedJev());
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /Ambiguous main groups: .*\(3 keyed, 3 linked\).*\(3 keyed, 3 linked\)/);
  assert.ok(!r.bindings?.length);
});

t('vague or keyless criteria stop with the accepted form in one line', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'SGD 100' }, { name: 'Third', price: 'SGD 300' }]);
  for (const criterion of ['best overall hotel', '2022 rank 1']) {
    const j = rankedJev();
    const r = await run(tab, [`pick "${criterion}" top 1 as $choices`], j);
    assert.equal(r.done, false);
    assert.match(r.stopped.reason, /write it as pick "lowest price" top 1/);
    assert.ok(!r.stopped.reason.includes('\n'));
    assert.equal(selectionCall(j).length, 0);
  }
});

t('a pick binding drives later steps: nav ${x.link} and click "${x.title}"', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'SGD 100' }, { name: 'Third', price: 'SGD 300' }]);
  const r = await run(tab, ['pick "lowest price" top 1 as $x', 'nav ${x.link}'], rankedJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(await ops.evaluate(conn, tab, 'location.pathname'), /^\/detail\/2$/);
  assert.match(formatSteps(r), /with target "http:\/\/127\.0\.0\.1:\d+\/detail\/2"/);
  await ops.navigate(conn, tab, fixture.url + 'fixtures/page.html');
  await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'SGD 100' }, { name: 'Third', price: 'SGD 300' }]);
  const r2 = await run(tab, ['pick "lowest price" top 1 as $x', 'click "${x.title}"', 'answer "${x.key}"'], rankedJev());
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.deepEqual(r2.steps[1].rendered, { target: 'Second' });
  assert.match(await ops.evaluate(conn, tab, 'location.pathname'), /^\/detail\/2$/);
  assert.equal(r2.answer, '100');
});

t('a step using a binding of several items stops instead of acting on a joined value', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'SGD 100' }, { name: 'Third', price: 'SGD 300' }]);
  const before = await ops.evaluate(conn, tab, 'location.href');
  const r = await run(tab, ['pick "lowest price" top 2 as $x', 'nav ${x.link}'], rankedJev());
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /\$x holds 2 items; a step can use one/);
  assert.equal(await ops.evaluate(conn, tab, 'location.href'), before);
});

t('pick "first" after a click that re-sorts the list takes the new page order', async tab => {
  const rows = names => names.map((n, i) => `<li style="width:600px;height:80px"><a href="/detail/${n}">${n} sofa</a><p>SGD ${100 * (i + 1)}</p></li>`).join('');
  await page(tab, `<button id="sort">Sort by price</button><main><h1>Sofas</h1><ul id="list">${rows(['Kivik', 'Ektorp', 'Finnala'])}</ul></main>`);
  // The sorted list arrives from a request slower than a click's settle (4 s), as a search API's can.
  await ops.evaluate(conn, tab, `sort.onclick = () => { list.classList.add('is-loading'); fetch('/delay?ms=4600').then(() => { list.innerHTML = ${JSON.stringify(rows(['Finnala', 'Kivik', 'Ektorp']))}; list.classList.remove('is-loading'); }); }`);
  const r = await run(tab, ['click "Sort by price"', 'pick "first" top 2 as $choices'], rankedJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.text.match(/^\w+/)[0]), ['Finnala', 'Kivik']);
});

// Page text in a binding is a literal argument value, never plan syntax.
const HOSTILE = 'Shoes"; click! "Place order => done {x} ${y} ! ; \'Buy\'';
t('a page title full of plan syntax fills the click target literally: one step, no expectation, no commit', async tab => {
  const rows = [{ name: HOSTILE, price: 'SGD 100' }, { name: 'Boots', price: 'SGD 200' }, { name: 'Sandals', price: 'SGD 300' }];
  const cards = rows.map((row, i) => `<li style="width:600px;height:90px"><a href="#detail-${i + 1}" onclick="(window.clicks = window.clicks || []).push(${i + 1})"></a><p>${row.price}</p></li>`).join('');
  await page(tab, `<main><h1>Shoes</h1><ul>${cards}</ul><button id="place" onclick="window.placed=1">Place order</button><button id="buy" onclick="window.bought=1">Buy</button></main>`);
  await ops.evaluate(conn, tab, `document.querySelectorAll('li a').forEach((a, i) => { a.textContent = ${JSON.stringify(rows.map(r => r.name))}[i]; })`);
  const r = await run(tab, ['pick "lowest price" top 1 as $x', 'click "${x.title}"'], rankedJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(r.bindings.find(b => b.name === 'x').value[0].text.split(' · ')[0], HOSTILE);
  // Exactly the two planned steps ran; the click used the whole title as its target.
  assert.equal(r.planned_leaves, 2);
  assert.equal(r.steps.length, 2);
  assert.deepEqual(r.steps[1].rendered, { target: HOSTILE });
  assert.equal(r.steps[1].expect_p, undefined);
  assert.ok(!r.steps[1].committed);
  assert.deepEqual(await ops.evaluate(conn, tab, '({ clicks: window.clicks, placed: window.placed ?? null, bought: window.bought ?? null, hash: location.hash })'), { clicks: [1], placed: null, bought: null, hash: '#detail-1' });
});

t('a bound title naming a commit control does not press it: the commit guard still applies', async tab => {
  const rows = ['Place order', 'Boots', 'Sandals'];
  const cards = rows.map((name, i) => `<li style="width:600px;height:90px"><a href="#item-${i + 1}" onclick="(window.clicks = window.clicks || []).push(${i + 1})">${name}</a><p>SGD ${100 * (i + 1)}</p></li>`).join('');
  await page(tab, `<main><h1>Shop</h1><ul>${cards}</ul><form onsubmit="return false"><button id="place" type="submit" onclick="window.placed=1">Place order</button></form></main>`);
  const r = await run(tab, ['pick "lowest price" top 1 as $x', 'click "${x.title}"'], rankedJev());
  assert.equal(r.steps.length, 2);
  assert.deepEqual(r.steps[1].rendered, { target: 'Place order' });
  assert.ok(!r.steps[1].committed);
  assert.equal(await ops.evaluate(conn, tab, 'window.placed ?? null'), null);
});

// The om2w stays page (bench/om2w/features, feat-stays-cheapest): hosts quote in their own
// currency, per night or for the stay, and the page states the stay length and the rates.
const STAYS = [
  ['Casa Alfama', '$139 / night'], ['Lapa Flat', '$79 / night', true], ['Hotel Tejo', '€360 total for 3 nights'],
  ['Estrela House', '$89 / night + $70 cleaning fee'], ['Rio View Suites', '£95 per night'], ['Baixa Hostel Private Room', 'S$480 for your stay'],
  ['Belém Garden', '$105–$125 / night'], ['Alfama Nest', '€99 / night'], ['Graça Terrace', '$329 total'],
  ['Chiado Rooms', 'USD 112 per night'], ['Sunset Bairro', '€305 for 3 nights'], ['Mouraria Studio', '£250–£280 total'],
];
const STAYS_HEAD = '<p>Thu, Nov 12 – Sun, Nov 15, 2026 · 3 nights · 2 guests. Prices are shown in each host\'s own currency; some hosts quote per night, others for the whole stay.</p>';
const STAYS_RATES = '<p>Exchange rates used for payment: 1 EUR = 1.08 USD · 1 GBP = 1.27 USD · 1 SGD = 0.74 USD.</p>';
const staysPage = (tab, { head = STAYS_HEAD, rates = STAYS_RATES, stays = STAYS } = {}) => page(tab, `<style>.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px}.card{border:1px solid #ddd;padding:14px}</style><header><b>Wanderly</b><span>Stays</span></header><main><h1>Stays in Lisbon</h1>${head}${rates}<div class="grid">${stays.map(([name, price, soldOut]) => `<div class="card"><div style="height:60px"></div><h3>${name}</h3><div>★ 4.3 · Lisbon</div><div class="price">${price}</div>${soldOut ? '<div>Sold out for your dates</div>' : '<div>Available</div>'}<button>View</button></div>`).join('\n')}</div></main>`);
const staysJev = () => rankedJev({ noul: (q, id) => id.endsWith('.eligible') || id.endsWith('.confirm') ? /Sold out/.test(q.instructions) ? .03 : .95 : .04 });

t('the stays page: per-night prices become totals for the stated nights and currencies convert at the stated rates', async tab => {
  await staysPage(tab);
  const r = await run(tab, ['pick "lowest total price in USD, counting the upper end of ranges" top 3 as $choices'], staysJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(choices(r)[0].text, /Alfama Nest/);
  assert.equal(choices(r)[0].key, 320.76);
  assert.equal(choices(r)[0].evidence.currency, 'USD');
  assert.equal(choices(r)[0].evidence.unit, 'total');
  assert.deepEqual(choices(r).map(item => item.text.split(" · ")[0]), ['Alfama Nest', 'Graça Terrace', 'Sunset Bairro']);
  assert.deepEqual(choices(r).map(item => item.key), [320.76, 329, 329.4]);
  const out = formatSteps(r);
  assert.match(out, /note: exchange rates the page states: 1 EUR = 1\.08 USD · 1 GBP = 1\.27 USD · 1 SGD = 0\.74 USD/);
  assert.match(out, /note: stay length the page states: 3 nights/);
  assert.match(out, /note: i\d+: €99\/night × 3 × 1\.08 = USD 320\.76/);
  assert.match(out, /note: i\d+: \(\$89\/night × 3 \+ \$70 fee\) = USD 337\.00/);
  assert.match(out, /note: i\d+: £280 \(high end of £250–£280\) × 1\.27 = USD 355\.60/);
  assert.match(out, /note: i\d+: \$125\/night \(high end of \$105–\$125\) × 3 = USD 375\.00/);
  assert.match(out, /note: i\d+: S\$480 × 0\.74 = USD 355\.20/);
  assert.ok(!r.steps[0].excluded?.length, JSON.stringify(r.steps[0].excluded));
  assert.ok(!choices(r).some(item => /Lapa Flat/.test(item.text)));
  // Without the range clause a range ranks by its low end, as before: Belém at $105 × 3.
  const r2 = await run(tab, ['pick "lowest total price in USD" top 1 as $choices'], staysJev());
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.match(choices(r2)[0].text, /Belém Garden/);
  assert.equal(choices(r2)[0].key, 315);
});

t('rates without a stated stay length convert currencies only; per-night prices are not guessed into totals', async tab => {
  await staysPage(tab, { head: '<p>2 guests. Prices are shown in each host\'s own currency.</p>' });
  const r = await run(tab, ['pick "lowest total price in USD, counting the upper end of ranges" top 1 as $choices'], staysJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  // Totals only: $329, €305 × 1.08 = 329.40, €360 × 1.08, S$480 × 0.74 = 355.20, £280 × 1.27.
  assert.match(choices(r)[0].text, /Graça Terrace/);
  assert.equal(choices(r)[0].key, 329);
  const out = formatSteps(r);
  assert.doesNotMatch(out, /stay length the page states/);
  assert.doesNotMatch(out, /\/night ×/);
  const [nest, estrela] = await ids(tab, ['Alfama Nest', 'Estrela House']);
  assert.match(out, new RegExp(`${nest} excluded: €99 is per night, not total price`));
  assert.match(out, new RegExp(`${estrela} excluded: \\$89 is per night, not total price`));
});

t('a page that states no rates ranks as before: other currencies are excluded, not converted', async tab => {
  await staysPage(tab, { rates: '' });
  const r = await run(tab, ['pick "lowest total price in USD, counting the upper end of ranges" top 1 as $choices'], staysJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  // USD only, per-night prices made totals for the stated 3 nights. "$" next to "S$" stays
  // ambiguous without the page's rates, so only Chiado (USD 112 × 3) is in USD.
  assert.match(choices(r)[0].text, /Chiado Rooms/);
  assert.equal(choices(r)[0].key, 336);
  const out = formatSteps(r);
  assert.doesNotMatch(out, /exchange rates the page states/);
  assert.doesNotMatch(out, / × (?!3 )/);
  const [nest, graca] = await ids(tab, ['Alfama Nest', 'Graça Terrace']);
  assert.match(out, new RegExp(`${nest} excluded: €99 is in EUR, not USD`));
  assert.match(out, new RegExp(`${graca} excluded: \\$329 is in dollar, not USD`));
  // A list in one currency and basis with no rates keeps today's output exactly.
  await listing(tab, [{ name: 'Desk A', price: 'USD 300' }, { name: 'Desk B', price: 'EUR 80' }, { name: 'Desk C', price: 'USD 250' }]);
  const r2 = await run(tab, ['pick "lowest price" top 1 as $choices'], rankedJev());
  assert.match(choices(r2)[0].text, /Desk C/);
  assert.match(formatSteps(r2), /excluded: EUR 80 is in EUR; most items are in USD and no conversion is made ⚠/);
  assert.doesNotMatch(formatSteps(r2), /×/);
});

t('ambiguous rate statements are ignored: approximate, ranged, contradicted or naming an ambiguous "$"', async tab => {
  const desks = [{ name: 'Desk A', price: 'USD 300' }, { name: 'Desk B', price: 'EUR 80' }, { name: 'Desk C', price: 'USD 250' }];
  for (const [rates, why] of [
    ['Approx. 1 EUR = 1.08 USD', /1 EUR = 1\.08 USD \(approximate\)/],
    ['1 EUR = 1.08 USD at checkout; 1 EUR = 1.20 USD on arrival', /\(they disagree\)/],
    ['1 EUR = 1.05–1.10 USD', null],
  ]) {
    await listing(tab, desks);
    await ops.evaluate(conn, tab, `document.querySelector('main').insertAdjacentHTML('afterbegin', ${JSON.stringify(`<p>${rates}</p>`)})`);
    const r = await run(tab, ['pick "lowest price" top 1 as $choices'], rankedJev());
    assert.equal(r.done, true, JSON.stringify(r.stopped));
    assert.match(choices(r)[0].text, /Desk C/, rates);
    const out = formatSteps(r);
    assert.match(out, /EUR 80 is in EUR; most items are in USD and no conversion is made/, rates);
    assert.doesNotMatch(out, /×/, rates);
    if (why) assert.match(out, why, rates);
  }
  // "$" is ambiguous where the page writes both SGD and USD: a rate quoted in "$" is not used.
  await listing(tab, [{ name: 'Lamp A', price: 'SGD 30' }, { name: 'Lamp B', price: '€10' }, { name: 'Lamp C', price: 'SGD 25' }, { name: 'Lamp D', price: 'USD 40' }]);
  await ops.evaluate(conn, tab, `document.querySelector('main').insertAdjacentHTML('afterbegin', '<p>€1 = $1.45</p>')`);
  const r = await run(tab, ['pick "lowest price" top 1 as $choices'], rankedJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(choices(r)[0].text, /Lamp C/);
  assert.doesNotMatch(formatSteps(r), /×/);
});

t('rates in either direction and symbol forms convert to the criterion currency; stated stay lengths that disagree give none', async tab => {
  await listing(tab, [{ name: 'Room A', price: 'SGD 270 total' }, { name: 'Room B', price: '€150 total' }, { name: 'Room C', price: 'USD 210 total' }]);
  await ops.evaluate(conn, tab, `document.querySelector('main').insertAdjacentHTML('afterbegin', '<p>USD 1 = SGD 1.35 · €1 = US$1.10</p>')`);
  const r = await run(tab, ['pick "lowest price in USD" top 3 as $choices'], rankedJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.key), [165, 200, 210]);
  assert.match(formatSteps(r), /€150 × 1\.1 = USD 165\.00/);
  assert.match(formatSteps(r), /SGD 270 \/ 1\.35 = USD 200\.00/);
  await listing(tab, [{ name: 'Room A', price: '$100 per night' }, { name: 'Room B', price: '$250 total' }, { name: 'Room C', price: '$90 per night' }]);
  await ops.evaluate(conn, tab, `document.querySelector('main').insertAdjacentHTML('afterbegin', '<p>3 nights · Nov 12 – Nov 16, 2026</p>')`);
  const r2 = await run(tab, ['pick "lowest total price" top 1 as $choices'], rankedJev());
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.match(choices(r2)[0].text, /Room B/);
  assert.match(formatSteps(r2), /different stay lengths \(3, 4 nights\)/);
  assert.doesNotMatch(formatSteps(r2), /\/night ×/);
});
