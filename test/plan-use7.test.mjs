import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { page } from '../lib/page/index.mjs';
import { fakeJev } from './fake-jev.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_NOTIFY = '0';
let fixture, browser, conn;
const haveBrowser = Boolean(chromeBinary());
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer(); browser = await startHeadlessBrowser(TEST_PORT); conn = await connect(TEST_PORT);
});
after(async () => { conn?.close(); await browser?.close(); await fixture?.close(); });
for (const [name, steps, valid] of [
  ['numeric rate form', ['fill "#weight" = "3"', 'click "#rates"'], true],
  ['explicit expectation wins', ['fill "#destination" = "Paris"', 'click "#search" => "Results for Tokyo"'], true],
  ['destination mismatch', ['fill "#destination" = "Paris"', 'click "#search"'], false],
  ['unlinked option owner', ['fill "#from" = "10019"', 'click "#address"', 'click! "#continue"'], true],
  ['hidden unlinked option', ['fill "#from" = "10019"', 'click "#address"', 'click! "#continue"'], true],
  ['preexisting unlinked option', ['fill "#from" = "10019"', 'click "#address"', 'click! "#continue"'], false],
  ['wrong unlinked owner', ['fill "#from" = "10019"', 'click "#address"', 'click! "#continue"'], false],
]) {
  test(name, { skip: !haveBrowser }, async () => {
    const id = (await ops.newTab(conn, `${fixture.url}fixtures/plan-use7.html${name.startsWith('wrong') ? '?wrong' : name.startsWith('hidden') ? '?hidden' : name.startsWith('preexisting') ? '?preexisting' : ''}`)).targetId;
    try {
      await ops.waitForReady(conn, id, { waitUntil: 'load' });
      const r = await runSteps(conn, id, steps, { noNotes: true, jev: fakeJev({ choice: () => { throw Error('unexpected model call'); }, noul: (_q, id) => id === 'prev_expect' ? .98 : .01 }) });
      console.log(formatSteps(r));
      assert.equal(r.done, valid, formatSteps(r));
      if (name.includes('option owner')) assert.ok(!r.steps[1].unsure, formatSteps(r));
      if (name === 'destination mismatch') assert.match(r.stopped.reason, /not the typed/);
    } finally { await ops.closeTab(conn, id); }
  });
}
for (const [name, question, expected] of [
  ['grid ranking', 'pick "earliest available date" top 1 as $d', '2027-03-01'],
  ['grid superlative extraction', 'extract "the first available date"', null],
  ['empty ranking', 'pick "earliest unavailable date" top 1 as $d', null],
  ['first in page order', 'pick "first available cabin" top 1 as $d', 'Available cabin B'],
  ['last in page order', 'pick "last available cabin" top 1 as $d', 'Available cabin A'],
]) {
  test(name, { skip: !haveBrowser }, async () => {
    const id = (await ops.newTab(conn, `${fixture.url}fixtures/plan-use7.html`)).targetId;
    try {
      await ops.waitForReady(conn, id, { waitUntil: 'load' });
      await ops.evaluate(conn, id, `document.body.innerHTML=${JSON.stringify('<main>' + Array.from({length:785}, (_, i) => `<button aria-label="${i % 27 + 1} Mar 2027 - Site E${i+100} is available">Open</button>`).join('') + '<p>Available cabin B</p><p>Available cabin A</p></main>')}`);
      const r = await runSteps(conn, id, [question], { noNotes: true, jev: fakeJev({ choice: () => { throw Error('unexpected model call'); } }) });
      console.log(formatSteps(r));
      if (expected) {
        assert.equal(r.done, true, formatSteps(r));
        const item = r.bindings[0].value[0];
        assert.equal(name === 'grid ranking' ? item.key : item.text, expected);
        assert.ok(item.text);
      } else {
        assert.equal(r.done, false, formatSteps(r));
        assert.match(r.stopped.reason, name === 'empty ranking' ? /no list or lines to rank/ : /785 lines; use pick "earliest available date" top 1 as \$d/);
      }
    } finally { await ops.closeTab(conn, id); }
  });
}

test('search checks recognize search structure and exclude ordinary fields', { skip: !haveBrowser }, async () => {
  const id = (await ops.newTab(conn, 'about:blank')).targetId;
  try {
    for (const [html, expected] of [
      ['<input role="searchbox">', true], ['<input type="search">', true],
      ['<form role="search"><input></form>', true], ['<label>Where to?<input></label>', true],
      ['<input role="combobox" aria-label="Location">', true],
      ['<input aria-autocomplete="list" aria-label="City">', true],
      ['<label>Package weight<input></label>', false], ['<label>Quantity<input></label>', false],
      ['<label>Destination date<input type="date"></label>', false], ['<label>Postal code<input></label>', false],
    ]) {
      await ops.evaluate(conn, id, `document.body.innerHTML=${JSON.stringify(html)}`);
      assert.equal(await ops.evaluate(conn, id, page('search-field', {selector: 'input'})), expected, html);
    }
  } finally { await ops.closeTab(conn, id); }
});
test('local ranking resolves a pending expectation before binding', { skip: !haveBrowser }, async () => {
  const id = (await ops.newTab(conn, 'about:blank')).targetId;
  try {
    await ops.evaluate(conn, id, `document.body.innerHTML='<button id="ready" onclick="document.body.dataset.ready=1">Ready</button><p>2 Mar 2027 available</p><p>1 Mar 2027 available</p>'`);
    const r = await runSteps(conn, id, ['click "#ready" => "missing"', 'pick "earliest available date" top 1 as $d'], {noNotes:true, jev:fakeJev()});
    assert.equal(r.done, false, formatSteps(r));
    assert.match(r.stopped.reason, /expected "missing"/);
    assert.ok(!r.bindings?.length);
  } finally { await ops.closeTab(conn, id); }
});
test('a list without price keys falls back to price lines', { skip: !haveBrowser }, async () => {
  const id = (await ops.newTab(conn, 'about:blank')).targetId;
  try {
    await ops.evaluate(conn, id, `document.body.innerHTML='<main><ul><li>Navigation 1</li><li>Navigation 2</li><li>Navigation 3</li></ul><p>Shipping rate $50.59</p><p>Shipping rate $20.00</p></main>'`);
    const r = await runSteps(conn, id, ['pick "cheapest shipping rate" top 1 as $d'], {noNotes:true, jev:fakeJev()});
    assert.equal(r.done, true, formatSteps(r));
    assert.equal(r.bindings[0].value[0].key, 20);
  } finally { await ops.closeTab(conn, id); }
});

test('first listed uses the main list rather than preceding page text', { skip: !haveBrowser }, async () => {
  const id = (await ops.newTab(conn, 'about:blank')).targetId;
  try {
    await ops.evaluate(conn, id, `document.body.innerHTML='<h1>Preceding title</h1><main><ul><li>Cabin B</li><li>Cabin A</li><li>Cabin C</li></ul></main>'`);
    const r = await runSteps(conn, id, ['pick "first listed" top 1 as $d'], {noNotes:true, jev:fakeJev()});
    assert.equal(r.done, true, formatSteps(r));
    assert.equal(r.bindings[0].value[0].text, 'Cabin B');
  } finally { await ops.closeTab(conn, id); }
});

test('a list with unrelated counters falls back to score lines', { skip: !haveBrowser }, async () => {
  const id = (await ops.newTab(conn, 'about:blank')).targetId;
  try {
    await ops.evaluate(conn, id, `document.body.innerHTML='<main><ul><li>Navigation 1</li><li>Navigation 2</li><li>Navigation 3</li></ul><p>Score 9</p><p>Score 3</p></main>'`);
    const r = await runSteps(conn, id, ['pick "highest score" top 1 as $d'], {noNotes:true, jev:fakeJev()});
    assert.equal(r.done, true, formatSteps(r));
    assert.equal(r.bindings[0].value[0].key, 9);
  } finally { await ops.closeTab(conn, id); }
});
