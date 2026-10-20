// Whole-task plans: extract, pick, if, alternatives, and the commit check for labels the
// word lists cannot judge, end to end against a fixture page with a fake Jev.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev, optionWith } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn;
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { await conn?.stop(); } catch {}
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
});
const t = (name, fn) => test(name, { skip: !haveBrowser && 'no Chromium-family browser installed' }, fn);
const open = async () => { const { targetId } = await ops.newTab(conn, `${fixture.url}fixtures/judge.html`); await ops.waitForReady(conn, targetId); return targetId; };
const run = async (tab, steps, jev) => { const r = await runSteps(conn, tab, steps, { jev, noNotes: true, prefetch: false }); console.log(formatSteps(r)); return r; };

t('extract copies the line that answers into the report, from below the fold too', async () => {
  const tab = await open();
  const jev = fakeJev({ choice: (q, id) => (id === 'extract' ? optionWith(q, 'Total for 3 nights') : undefined) });
  const r = await run(tab, ['extract "the total price for the stay"'], jev);
  assert.equal(r.done, true);
  assert.equal(r.extracted[0].value, 'Total for 3 nights: $597');
  assert.match(formatSteps(r), /extracted:\n {2}the total price for the stay: "Total for 3 nights: \$597"/);
  assert.equal(jev.calls.length, 2, 'one request for the step, one closing check');
});

t('pick opens the item that fits, by its link', async () => {
  const tab = await open();
  const jev = fakeJev({ choice: (q, id) => (id === 'pick' ? optionWith(q, '$199') : undefined) });
  const r = await run(tab, ['pick "the cheapest hotel with free cancellation"'], jev);
  assert.equal(r.done, true);
  assert.match(r.steps[0].picked.text, /Hotel C/);
  assert.match(r.page.url, /page\.html\?h=c$/);
});

t('pick stops with the closest items when none fits', async () => {
  const tab = await open();
  const r = await run(tab, ['pick "a hotel with a pool"'], fakeJev());
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /No listed item fits "a hotel with a pool"/);
});

t('if runs its step only when the page shows the condition', async () => {
  const tab = await open();
  const shows = (q) => (/cookie/i.test(q.instructions) ? 0.95 : /popup appeared/i.test(q.instructions) ? 0.02 : undefined);
  const r = await run(tab, ['if "a cookie banner" then click "Accept all"', 'if "a popup appeared" then click "Filters"'], fakeJev({ noul: shows }));
  assert.equal(r.done, true);
  assert.equal(r.steps[0].skipped, undefined);
  assert.equal(await ops.evaluate(conn, tab, '!document.getElementById("cookies")'), true, 'the banner was accepted');
  assert.match(r.steps[1].skipped, /does not show "a popup appeared"/);
  assert.equal(await ops.evaluate(conn, tab, 'document.getElementById("f").hidden'), true, 'its step did not run');
});

t('alternatives take the first name the page has, with no model call', async () => {
  const tab = await open();
  const jev = fakeJev();
  const r = await run(tab, ['click "All filters" | "Filters"'], jev);
  assert.equal(r.done, true);
  assert.match(r.steps[0].how, /^exact/);
  assert.equal(await ops.evaluate(conn, tab, 'document.getElementById("f").hidden'), false);
  assert.ok(jev.calls.every(c => !c.questions.target), 'no grounding question was asked');
});

t('a button in a language the word lists do not cover is checked before it is clicked', async () => {
  const tab = await open();
  const yes = fakeJev({ noul: (q, id) => (id === 'commits' ? 0.92 : undefined) });
  const r = await run(tab, ['click "Αγορά τώρα"'], yes);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /"Αγορά τώρα" can commit something \(p=0\.92\); to click it, mark the step: click! "Αγορά τώρα"/);
  // With the step marked, it is clicked.
  const marked = await run(tab, ['click! "Αγορά τώρα"'], yes);
  assert.equal(marked.done, true);
  assert.equal(marked.steps[0].committed, true);
  // No Jev: browserctrl cannot tell, so it does not click unmarked.
  const off = await run(tab, ['click "Αγορά τώρα"'], fakeJev({ fail: true }));
  assert.match(off.stopped.reason, /cannot tell whether "Αγορά τώρα" commits something/);
});

const longLines = n => Array.from({ length: n }, (_, i) => `primary language entry ${i} ${'x'.repeat(130)}`);
t('extract offers a distant short answer with heading context in one request', async () => {
  const tab = await open();
  const lines = [...Array.from({length: 350}, (_, i) => `Unrelated row ${i}`), 'Languages', 'JavaScript 100.0%'];
  await ops.evaluate(conn, tab, `document.body.innerText=${JSON.stringify(lines.join('\n'))}`);
  const jev = fakeJev({choice: q => optionWith(q, 'Languages: JavaScript 100.0%')});
  const r = await run(tab, ['extract "the primary language" as $lang'], jev);
  assert.equal(r.done, true);
  assert.equal(r.bindings[0].raw, 'JavaScript 100.0%');
  assert.equal(jev.calls.filter(c => c.questions.extract).length, 1);
});
t('extract retries omitted lines once and respects the question budget', async () => {
  const tab = await open();
  const lines = longLines(500);
  await ops.evaluate(conn, tab, `document.body.innerText=${JSON.stringify(lines.join('\n'))}`);
  let first;
  const jev = fakeJev({choice: q => {
    first ||= new Set(Object.values(q.criteria));
    return Object.entries(q.criteria).find(([id, text]) => id !== 'none' && !first.has(text))?.[0] || 'none';
  }});
  const r = await run(tab, ['extract "primary language" as $lang'], jev);
  assert.equal(r.done, true);
  const calls = jev.calls.filter(c => c.questions.extract);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => JSON.stringify(c.questions.extract).length <= 24000));
  assert.match(formatSteps(r), /second pass/);
});
t('none diagnostics show probability and coverage without zero candidates', async () => {
  const tab = await open();
  await ops.evaluate(conn, tab, `document.body.innerText=${JSON.stringify(longLines(500).join('\n'))}`);
  const jev = fakeJev({choice: () => ({choice:'none', probabilities:{none:.97}})});
  const r = await run(tab, ['extract "primary language" as $lang'], jev);
  assert.match(r.stopped.reason, /Jev: no offered line answers \(none p=0\.97\); \d+ of 500 lines offered/);
  assert.equal(jev.calls.filter(c => c.questions.extract).length, 3, 'two evidence passes plus one young-page retry');
});

t('extraction diagnostics print two decimal probabilities', async () => {
  const tab = await open();
  const jev = fakeJev({choice: q => ({choice: optionWith(q, 'Total for 3 nights'), probabilities: {
    [optionWith(q, 'Total for 3 nights')]: .14 + .15, none: .71,
  }})});
  const r = await run(tab, ['extract "the total" as $price'], jev);
  assert.match(r.stopped.reason, /p=0\.29/);
  assert.doesNotMatch(formatSteps(r), /0\.29000000000000004/);
});

t('extract joins sidebar inline facts and marks attribute evidence', async () => {
  const tab = await open();
  await ops.evaluate(conn, tab, `document.body.innerHTML='<h2>Languages</h2><div role="progressbar" aria-label="JavaScript: 100%"><span>JavaScript</span><span style="display:block">100%</span></div>'`);
  const joined = await run(tab, ['extract "the primary language" as $lang'], fakeJev({choice: q => optionWith(q, 'Languages: JavaScript 100%')}));
  assert.equal(joined.done, true);
  assert.equal(joined.bindings[0].raw, 'JavaScript 100%');
  const attr = await run(tab, ['extract "the primary language" as $lang'], fakeJev({choice: q => optionWith(q, 'JavaScript: 100%')}));
  assert.equal(attr.done, true);
  assert.equal(attr.bindings[0].source_attribute, 'aria-label');
  assert.match(formatSteps(attr), /aria-label/);
});

t('extract asks once more for late content after an initial none', async () => {
  const tab = await open();
  let asks = 0;
  const jev = fakeJev({choice: (q, id) => {
    if (id !== 'extract') return;
    asks++;
    if (asks === 1) {
      // Schedule from the first ask so initial plan readiness cannot consume the delay.
      void ops.evaluate(conn, tab, `setTimeout(() => { document.body.innerHTML='<h2>Languages</h2><p>JavaScript 100%</p>'; }, 1500)`);
      return 'none';
    }
    return optionWith(q, 'JavaScript 100%');
  }});
  const r = await run(tab, ['extract "the primary language" as $lang'], jev);
  assert.equal(r.done, true);
  assert.equal(asks, 2);
  assert.match(formatSteps(r), /waited \d+ ms for the page to fill in/);
});

t('old quiet page with no answer does not wait or ask again', async () => {
  const tab = await open();
  await new Promise(resolve => setTimeout(resolve, 8100));
  const jev = fakeJev();
  const start = Date.now();
  const r = await run(tab, ['extract "a missing answer" as $missing'], jev);
  assert.equal(r.done, false);
  assert.equal(jev.calls.filter(c => c.questions.extract).length, 1);
  assert.equal(r.steps[0].content_wait_ms, undefined);
  assert.ok(Date.now() - start < 3000);
});

t('pick retries a young empty list after none', async () => {
  const tab = await open();
  await ops.evaluate(conn, tab, `document.body.innerHTML='<h1>Loading hotels</h1>'`);
  let asks = 0;
  const jev = fakeJev({choice: (q, id) => {
    if (id !== 'pick') return;
    if (++asks === 1) {
      void ops.evaluate(conn, tab, `setTimeout(() => { document.body.innerHTML='<main><ul><li><a href="/fixtures/page.html">Hotel A</a></li><li><a href="/fixtures/page.html">Hotel B</a></li><li><a href="/fixtures/page.html">Hotel C</a></li></ul></main>'; }, 1500)`);
      return 'none';
    }
    return optionWith(q, 'Hotel B');
  }});
  const r = await run(tab, ['pick "Hotel B"'], jev);
  assert.equal(r.done, true);
  assert.equal(asks, 2);
  assert.ok(r.steps[0].content_wait_ms >= 1500);
});

t('GitHub language markup offers joined inline text and accessible progress text', async () => {
  const { targetId: tab } = await ops.newTab(conn, `${fixture.url}fixtures/github-languages.html`);
  await ops.waitForReady(conn, tab);
  const jev = fakeJev({ choice: q => {
    assert.ok(optionWith(q, 'Languages: JavaScript: 100%') !== 'none');
    return optionWith(q, 'Languages: JavaScript 100.0%');
  }});
  const r = await run(tab, ['extract "the primary language" as $lang'], jev);
  assert.equal(r.done, true);
  assert.equal(r.bindings[0].raw, 'JavaScript 100.0%');
});

for (const [label, line, p, verify, binds] of [
  ['weak numeric fragment', '100%', .71, .12, false],
  ['strong numeric fragment', '100%', .9, .12, false],
  ['short text', 'JavaScript', .9, .7, true],
  ['rounded weak full answer', 'JavaScript 100.0%', .7499, .8, true],
  ['weak full answer', 'JavaScript 100.0%', .71, .8, true],
  ['strong full answer', 'JavaScript 100.0%', .9, null, true],
]) t(`binding verification: ${label}`, async () => {
  const tab = await open();
  await ops.evaluate(conn, tab, `document.body.innerHTML='<h2>Languages</h2><p>${line}</p>'`);
  const jev = fakeJev({
    choice: q => ({ choice: optionWith(q, `Languages: ${line}`), probabilities: { [optionWith(q, `Languages: ${line}`)]: p, none: .1 } }),
    noul: (q, id) => id === 'extract_verify' ? verify : undefined,
  });
  const r = await run(tab, ['extract "the primary language" as $lang'], jev);
  assert.equal(r.done, binds);
  const calls = jev.calls.filter(c => c.questions.extract_verify);
  assert.equal(calls.length, verify === null ? 0 : 1);
  if (verify !== null) {
    assert.equal(calls[0].assets, undefined);
    assert.match(calls[0].questions.extract_verify.instructions, /state the primary language itself/);
    assert.match(calls[0].questions.extract_verify.instructions, new RegExp(`Languages: ${line.replace('.', '\\.')}`));
    assert.equal(r.steps[0].extract_verify.p, verify);
    assert.equal(typeof r.steps[0].extract_verify.ms, 'number');
  }
  if (!binds) {
    assert.equal(r.bindings?.length || 0, 0);
    assert.match(r.stopped.reason, new RegExp(`group p=${p.toFixed(2)}.*verify p=0.12`));
  }
});

for (const display of ['inline-flex', 'flex']) t(`extract joins short ${display} rows`, async () => {
  const tab = await open();
  await ops.evaluate(conn, tab, `document.body.innerHTML='<h2>Languages</h2><div style="display:${display}"><div>JavaScript</div><div>100.0%</div></div>'`);
  const r = await run(tab, ['extract "the primary language" as $lang'], fakeJev({ choice: q => optionWith(q, 'Languages: JavaScript 100.0%') }));
  assert.equal(r.done, true);
  assert.equal(r.bindings[0].raw, 'JavaScript 100.0%');
});

t('joined repository header also offers its precise descendant lines once', async () => {
  const tab = await open();
  await ops.evaluate(conn, tab, `document.body.innerHTML='<div style="display:flex"><span>Public</span><a>Watch <b>11</b></a><a>Fork <b>202</b></a><a>Star <b>3.3k</b></a></div><p>3.3k stars</p>'`);
  const jev = fakeJev({
    choice: (q, id) => {
      if (id !== 'extract') return;
      const texts = Object.values(q.criteria);
      assert.ok(texts.some(s => s === 'Public Watch 11 Fork 202 Star 3.3k'));
      assert.equal(texts.filter(s => s === 'Star 3.3k').length, 1);
      assert.equal(texts.filter(s => s === '3.3k stars').length, 1);
      assert.ok(texts.length <= 255);
      return { choice: optionWith(q, '3.3k stars'), probabilities: {
        [optionWith(q, '3.3k stars')]: .56,
        [Object.entries(q.criteria).find(([, text]) => text === 'Star 3.3k')[0]]: .27,
        none: .17,
      } };
    },
    noul: (q, id) => id === 'extract_verify' ? .9 : undefined,
  });
  const r = await run(tab, ['extract "the number of stars" as number as $stars'], jev);
  assert.equal(r.done, true);
  assert.equal(r.bindings[0].value, 3300);
  assert.equal(jev.calls.filter(c => c.questions.extract_value).length, 0);
});

t('chosen joined multi-number header resolves through one fake Jev follow-up', async () => {
  const tab = await open();
  const header = 'Public Watch 11 Fork 202 Star 3.3k';
  await ops.evaluate(conn, tab, `document.body.innerHTML='<p>${header}</p><p>3.3k stars</p>'`);
  const jev = fakeJev({
    choice: (q, id) => id === 'extract' ? { choice: optionWith(q, header), probabilities: {
      [optionWith(q, header)]: .6, [optionWith(q, '3.3k stars')]: .27, none: .13,
    } } : id === 'extract_value' ? { choice: optionWith(q, 'Star 3.3k'), probabilities: {
      [optionWith(q, 'Star 3.3k')]: .95, none: .05,
    } } : undefined,
    noul: (q, id) => id === 'extract_verify' ? .9 : undefined,
  });
  const r = await run(tab, ['extract "the number of stars" as number as $stars'], jev);
  assert.equal(r.done, true);
  assert.equal(r.bindings[0].value, 3300);
  assert.equal(r.bindings[0].raw, header);
  assert.equal(r.bindings[0].p, .84);
  assert.equal(jev.calls.filter(c => c.questions.extract_value).length, 1);
  assert.equal(jev.calls.filter(c => c.questions.extract).length, 1);
  assert.equal(jev.calls.filter(c => c.questions.extract_verify).length, 1);
});

t('rendered counter line survives a hidden duplicate in its joined DOM block', async () => {
  const tab = await open();
  await ops.evaluate(conn, tab, `document.body.innerHTML='<a>Star<span>3.3k</span><span style="display:block"> (3.3k)</span></a><p>3.3k stars</p>'`);
  const jev = fakeJev({
    choice: (q, id) => {
      if (id !== 'extract') return;
      const texts = Object.values(q.criteria);
      assert.ok(texts.some(text => text === 'Star 3.3k (3.3k)'));
      assert.equal(texts.filter(text => text === 'Star3.3k').length, 1);
      return { choice: optionWith(q, '3.3k stars'), probabilities: {
        [optionWith(q, '3.3k stars')]: .56,
        [Object.entries(q.criteria).find(([, text]) => text === 'Star3.3k')[0]]: .27,
        none: .17,
      } };
    },
    noul: (q, id) => id === 'extract_verify' ? .9 : undefined,
  });
  const r = await run(tab, ['extract "the number of stars" as number as $stars'], jev);
  assert.equal(r.done, true);
  assert.equal(r.bindings[0].value, 3300);
  assert.equal(r.bindings[0].p, .83);
});

t('table row evidence keeps the label with its value and excludes hidden cells', async () => {
  const tab = await open();
  await ops.evaluate(conn, tab, `document.body.innerHTML='<table><tr><th>Independence</th><td><span>9 August</span> <b>1965</b></td><td style="display:none">1 January 2000</td></tr></table>'`);
  const jev = fakeJev({ choice: (q, id) => id === 'extract' ? optionWith(q, 'Independence: 9 August 1965') : id === 'extract_value' ? optionWith(q, '9 August 1965') : undefined,
    noul: (q, id) => id === 'extract_verify' ? .95 : undefined });
  const r = await run(tab, ['extract "independence date" as date as $date'], jev);
  assert.equal(r.done, true);
  assert.equal(r.bindings[0].value, '1965-08-09');
  assert.equal(r.bindings[0].raw, 'Independence: 9 August 1965');
});

t('footnote markers are not part of a table value or a joined line', async () => {
  const tab = await open();
  // Wikipedia's infobox markup: the reference <sup> sits right after the value.
  await ops.evaluate(conn, tab, `document.body.innerHTML='<table><tr><th>Hauptstadt</th><td><a href="/wiki/S">Singapur</a><sup id="r3" class="reference"><a href="#cite_note-3">[3]</a></sup></td></tr><tr><th>Einwohnerzahl</th><td>5.640.000 (2025)<sup class="reference"><a href="#cite_note-4">[4]</a></sup></td></tr></table><p><span>Note</span><sup role="doc-noteref"><a href="#fn1">1</a></sup></p>'`);
  let offered = [];
  const jev = fakeJev({ choice: (q, id) => { if (id === 'extract') { offered = Object.values(q.criteria); return optionWith(q, 'Hauptstadt: Singapur'); } return undefined; },
    noul: (q, id) => id === 'extract_verify' ? .95 : undefined });
  const r = await run(tab, ['extract "the capital" as $cap'], jev);
  assert.ok(offered.includes('Hauptstadt: Singapur'), JSON.stringify(offered));
  assert.ok(offered.includes('Einwohnerzahl: 5.640.000 (2025)'), JSON.stringify(offered));
  assert.ok(!offered.some(text => typeof text === 'string' && /\[\s*[34]\s*\]|Singapur 3/.test(text)), JSON.stringify(offered));
  assert.equal(r.done, true);
  assert.match(r.bindings[0].value, /Singapur$/);
  assert.doesNotMatch(r.bindings[0].value, /\[|\d/);
});

t('release links offer an observed version tag with attribute provenance', async () => {
  const tab = await open();
  await ops.evaluate(conn, tab, `document.body.innerHTML='<h2>Releases</h2><a href="/project/tags/v4.2.1">Version 4.2.1 (Current) Latest</a><a href="/project/tags/v4.2.10">Version 4.2.100</a>'`);
  const r = await run(tab, ['extract "latest release tag" as $tag'], fakeJev({ choice: q => { assert.ok(!Object.values(q.criteria).includes('Releases: v4.2.10')); return optionWith(q, 'Releases: v4.2.1'); }, noul: (q, id) => id === 'extract_verify' ? .95 : undefined }));
  assert.equal(r.done, true);
  assert.equal(r.bindings[0].value, 'v4.2.1');
  assert.equal(r.bindings[0].source_attribute, 'href');
});

t('table section headings rank the following labelled rows', async () => {
  const tab = await open();
  await ops.evaluate(conn, tab, `document.body.innerHTML='<table><tr><th colspan="2">Population</th></tr><tr><th>2025 estimate</th><td>6,110,200</td></tr></table>'`);
  const jev = fakeJev({ choice: (q, id) => id === 'extract' ? optionWith(q, 'Population: 2025 estimate: 6,110,200') : id === 'extract_value' ? optionWith(q, '6,110,200') : undefined,
    noul: (q, id) => id === 'extract_verify' ? .95 : undefined });
  const r = await run(tab, ['extract "total population" as number as $population'], jev);
  assert.equal(r.done, true);
  assert.equal(r.bindings[0].value, 6110200);
});

t('numeric price headings retain their preceding plan heading', async () => {
  const tab = await open();
  await ops.evaluate(conn, tab, `document.body.innerHTML='<h2>Free</h2><p>For individuals</p><h3>$<span>0</span> USD per user/month</h3>'`);
  const r = await run(tab, ['extract "monthly per user price of the Free plan" as number as $price'], fakeJev({ choice: q => Object.entries(q.criteria).find(([, text]) => typeof text === 'string' && text.startsWith('Free:') && text.endsWith('$ 0 USD per user/month'))?.[0] || 'none', noul: (q, id) => id === 'extract_verify' ? .95 : undefined }));
  assert.equal(r.done, true);
  assert.equal(r.bindings[0].value, 0);
});
