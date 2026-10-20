#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createDiaAdapter, installCleanupSignals } from './dia.mjs';
const browserName = process.argv.includes('--browser') ? process.argv[process.argv.indexOf('--browser') + 1] : process.env.EXTRACT_EVAL_BROWSER || 'headless';
// Any browser the installed CLI can reach: a name (dia, chrome, brave, edge, arc) or port:NNNN.
if (!/^(headless|dia|chrome|brave|edge|chromium|arc|port:\d+)$/.test(browserName)) throw Error('Expected --browser headless|dia|chrome|brave|edge|chromium|arc|port:NNNN');
const dia = browserName === 'headless' ? null
  : createDiaAdapter(browserName.startsWith('port:') ? { port: Number(browserName.slice(5)) } : { browser: browserName });
let home, startHeadlessBrowser, connect, ops, runSteps, port;
if (dia) {
  ops = dia;
  runSteps = dia.runSteps;
} else {
  home = fs.mkdtempSync(path.join('/tmp', 'bc-extract-eval-'));
  for (const key of Object.keys(process.env)) if (/^(?:BROWSERCTRL|CDP)_/.test(key) && !['BROWSERCTRL_JEV_ENV', 'BROWSERCTRL_JEV_ENDPOINT'].includes(key)) delete process.env[key];
  process.env.BROWSERCTRL_HOME = home;
  process.env.BROWSERCTRL_AGENT_ID = `extract-eval-${process.pid}`;
  delete process.env.CDP_AGENT_ID;
  process.env.BROWSERCTRL_NOTIFY = '0';
  process.env.BROWSERCTRL_NOTES = 'off';
  process.env.BROWSERCTRL_JEV_ENV ||= path.join(os.homedir(), 'Code/jev-ultrafast/.env');
  [{ startHeadlessBrowser }, { connect }, ops, { runSteps }] = await Promise.all([
    import('../../test/helpers.mjs'), import('../../lib/daemon.mjs'), import('../../lib/ops.mjs'), import('../../lib/steps.mjs'),
  ]);
  port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
let browser, browserStarting, conn, cleaning, stopping = false;
async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    if (dia) return dia.cleanup();
    if (browserStarting) browser = await browserStarting.catch(() => null);
    try { await conn?.stop(); } catch {}
    try { conn?.close(); } catch {}
    await browser?.close();
    fs.rmSync(home, { recursive: true, force: true });
  })();
  return cleaning;
}
installCleanupSignals(cleanup, { onSignal: () => { stopping = true; } });
const cases = JSON.parse(fs.readFileSync(new URL('./cases.json', import.meta.url)));
const results = [];
const normalize = s => String(s).replace(/\s+/g, ' ').trim();
function number(s) { const m = String(s).replace(/,/g, '').match(/^\s*([\d.]+)\s*([kmb])?\s*$/i); return m ? Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1) : null; }
async function oracle(tab, c) {
  if (c.expect === 'stop' || c.expect.exact !== undefined || c.expect.regex) return c.expect;
  const o = c.expect;
  let text;
  for (let attempt = 0; attempt < 12; attempt++) {
    text = await ops.evaluate(conn, tab, `(() => { const e = document.querySelector(${JSON.stringify(o.selector)}); return e ? (${JSON.stringify(o.attribute || null)} ? e.getAttribute(${JSON.stringify(o.attribute || null)}) : (e.innerText || e.textContent || '')).trim() : null; })()`);
    if (text) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!text) throw Error(`oracle selector absent: ${o.selector}`);
  const value = o.capture ? String(text).match(new RegExp(o.capture, 'i'))?.[1] : text;
  if (!value) throw Error('oracle capture absent');
  if (o.number) { const n = number(value); if (n === null) throw Error(`oracle not numeric: ${value}`); return { exact: n, observed: text }; }
  return { exactText: normalize(value), observed: text, kind: o.kind };
}
function matches(value, expected) {
  if (expected.exact !== undefined) return value === expected.exact;
  if (expected.regex) return new RegExp(expected.regex, 'i').test(String(value));
  const actual = normalize(value), wanted = expected.exactText;
  if (expected.kind === 'python') return actual === wanted || actual === 'Download ' + wanted || actual === wanted.replace(/^Python /, '');
  if (expected.kind === 'language') return new RegExp(`^(?:Languages?:? )?${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?::? \\d+(?:\\.\\d+)?\\s*%)?$`, 'i').test(actual);
  return expected.kind === 'release' ? actual === wanted || actual === wanted + ' Latest' : actual === wanted;
}
try {
  if (!dia) {
    browserStarting = startHeadlessBrowser(port);
    browser = await browserStarting;
    if (stopping) throw Error('Interrupted during browser startup');
    if (!browser) throw Error('Chrome unavailable');
    conn = await connect(port);
  }
  console.log(`Browser: ${browserName}${dia ? " (installed browserctrl on PATH)" : ""}`);
  console.log('| case | classification | value | expected | ms | calls | input/output tokens |');
  console.log('| --- | --- | --- | --- | ---: | ---: | ---: |');
  for (const c of cases.filter(c => !process.env.EXTRACT_EVAL_FILTER || new RegExp(process.env.EXTRACT_EVAL_FILTER).test(c.id))) {
    if (dia && c.dia === false) { console.log(`| ${c.id} | skipped (dia: false) | | | | | |`); continue; }
    let tab, expected, report, error, tokens = { input: 0, output: 0, complete: true }, calls = 0;
    const started = Date.now();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { tab = (await ops.newTab(conn, c.url)).targetId; await ops.waitForReady(conn, tab, { waitUntil: 'load', timeoutMs: 25000 }); break; }
        catch (e) { if (tab) await ops.closeTab(conn, tab).catch(() => {}); tab = null; if (attempt) throw e; }
      }
      if (process.env.EXTRACT_EVAL_INSPECT) await new Promise(resolve => setTimeout(resolve, 1500));
      const diagnostics = await ops.evaluate(conn, tab, `({title:document.title,text:document.body?.innerText.slice(0,1200),tail:document.body?.innerText.slice(-1800),languageHTML:[...document.querySelectorAll('h2')].find(e=>e.textContent.trim()==='Languages')?.parentElement.outerHTML,links:[...document.querySelectorAll('a')].filter(e=>/release|language|download/i.test(e.href)).slice(-35).map(e=>({text:e.innerText,href:e.getAttribute('href')}))})`);
      if (process.env.EXTRACT_EVAL_INSPECT) {
        const expected = await oracle(tab, c).catch(error => ({ unavailable: error.message }));
        let extraction;
        if (!dia) {
          const [{ judgment }, { parseStep }] = await Promise.all([import('../../lib/do/judgments.mjs'), import('../../lib/do/parse.mjs')]);
          const j = await judgment({ conn, tab }, parseStep(c.step));
          extraction = { spans: j.spans, all: j.all, fields: j.fields };
        }
        console.log(JSON.stringify({ id: c.id, diagnostics, expected, extraction }));
        continue;
      }
      if (/just a moment|access denied|security check|captcha/i.test(diagnostics.title) || /Bad Gateway|upstream connect error/.test(diagnostics.text || '')) throw Error('public page blocked: ' + diagnostics.title);
      expected = await oracle(tab, c);
      if (dia) tokens.complete = false;
      report = await runSteps(conn, tab, [c.step], { handoff: false, noNotes: true, traceRun: false, diff: false, jev: { fetchImpl: async (...args) => {
        calls++;
        const response = await fetch(...args);
        try { const body = await response.clone().json(); if (body.usage?.input_tokens == null || body.usage?.output_tokens == null) tokens.complete = false; tokens.input += body.usage?.input_tokens || 0; tokens.output += body.usage?.output_tokens || 0; } catch { tokens.complete = false; }
        return response;
      } } });
      if (dia) calls = report.jev_calls || 0;
    } catch (e) { error = e.message; }
    finally { if (tab) await ops.closeTab(conn, tab).catch(() => {}); }
    const value = report?.bindings?.[0]?.value ?? report?.extracted?.[0]?.value;
    // Untyped extraction can report null without report.stopped: it still made no binding.
    const stopped = value === null || value === undefined;
    const classification = error ? 'unavailable' : stopped ? expected === 'stop' ? 'honest stop' : 'wrong stop' : expected !== 'stop' && matches(value, expected) ? 'correct binding' : 'FALSE BINDING';
    const row = { id: c.id, classification, value: value ?? null, expected, ms: Date.now() - started, calls, tokens, error, reason: report?.stopped, report };
    results.push(row);
    const cell = v => JSON.stringify(v)?.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 170) ?? '';
    console.log(`| ${c.id} | ${classification} | ${cell(error || value)} | ${cell(expected)} | ${row.ms} | ${calls} | ${tokens.input}/${tokens.output}${tokens.complete ? '' : ' (incomplete)'} |`);
  }
  if (process.env.EXTRACT_EVAL_INSPECT) { console.log('\nInspection only; no extraction results or Jev calls.'); }
  const counts = Object.fromEntries(['correct binding', 'FALSE BINDING', 'honest stop', 'wrong stop', 'unavailable'].map(k => [k, results.filter(r => r.classification === k).length]));
  if (!process.env.EXTRACT_EVAL_INSPECT) console.log('\nTotals: ' + JSON.stringify({ ...counts, calls: results.reduce((n, r) => n + r.calls, 0), input_tokens: results.reduce((n, r) => n + r.tokens.input, 0), output_tokens: results.reduce((n, r) => n + r.tokens.output, 0), ms: results.reduce((n, r) => n + r.ms, 0) }));
  if (process.env.EXTRACT_EVAL_RESULTS) fs.writeFileSync(process.env.EXTRACT_EVAL_RESULTS, JSON.stringify(results, null, 2));
  process.exitCode = counts['FALSE BINDING'] ? 1 : counts.unavailable ? 2 : 0;
} finally { await cleanup(); }
