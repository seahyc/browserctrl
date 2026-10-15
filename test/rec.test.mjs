// Watch-later recordings: the page script, the files a recording leaves, the
// Online-Mind2Web export and the replay page, then one real recording end to end.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as rec from '../lib/rec.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-rec-test-'));
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function fakeRecording() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'trajectory'));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ targetId: 'T', startedAt: 1000, label: 'demo' }));
  const steps = [
    { step: 0, at: 1000, url: 'https://a.test/', action: 'start recording', status: null, screenshot: '0000.jpg' },
    { step: null, at: 1500, action: 'click ref_9', status: 'SUCCESS', error: 'capture timed out' },
    { step: 1, at: 2000, url: 'https://a.test/x', action: 'do: click "Sort"', status: 'SUCCESS', screenshot: '0001.jpg' },
    { step: 2, at: 3000, url: 'https://a.test/x', action: 'stop recording', status: null, screenshot: '0002.jpg' },
  ];
  fs.writeFileSync(path.join(dir, 'steps.jsonl'), steps.map(s => JSON.stringify(s)).join('\n') + '\n');
  for (const n of ['0000', '0001', '0002']) fs.writeFileSync(path.join(dir, 'trajectory', `${n}.jpg`), jpeg);
  fs.writeFileSync(path.join(dir, 'rrweb.ndjson'), [{ type: 4, timestamp: 1000, data: {} }, { type: 2, timestamp: 1001, data: {} }].map(e => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

test('page script keeps rrweb private and records only the top frame', () => {
  const s = rec.pageScript();
  assert.match(s, /window\.top !== window \|\| window\.__bcRec/);
  assert.match(s, /\}\)\.call\(holder, undefined, undefined, undefined\)/, 'an AMD or CommonJS shim on the page must not capture rrweb');
  assert.match(s, /mousemove: false/);
  assert.match(s, /inlineImages: false/);
  assert.doesNotThrow(() => new Function(s), 'the page script parses');
});

test('finish compresses the event stream and keeps appending across stops', () => {
  const dir = fakeRecording();
  const first = rec.finish(dir);
  assert.ok(!fs.existsSync(path.join(dir, 'rrweb.ndjson')));
  assert.ok(first.rrweb_bytes > 0);
  fs.writeFileSync(path.join(dir, 'rrweb.ndjson'), JSON.stringify({ type: 3, timestamp: 1500, data: {} }) + '\n');
  rec.finish(dir);
  assert.deepEqual(rec.readEvents(dir).map(e => e.type), [4, 2, 3]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).label, 'demo');
  assert.equal(first.steps, 3);
});

test('Online-Mind2Web export writes a v2 result its judge can read', () => {
  const dir = fakeRecording();
  const root = tmp();
  const r = rec.exportOm2w(dir, { taskId: 'abc', task: 'Find a sofa', answer: 'done', root });
  const result = JSON.parse(fs.readFileSync(r.result, 'utf8'));
  assert.equal(result.schema_version, 'online-mind2web-v2');
  assert.equal(result.task_id, 'abc');
  assert.equal(result.agent_final_answer, 'done');
  // The failed capture reuses the previous still; the final stop row is dropped.
  assert.deepEqual(result.action_history.map(h => [h.step, h.screenshot, h.action]), [
    [0, '0000.jpg', 'start recording'], [1, '0000.jpg', 'click ref_9'], [2, '0001.jpg', 'do: click "Sort"'],
  ]);
  for (const h of result.action_history) assert.ok(fs.existsSync(path.join(root, 'abc', 'trajectory', h.screenshot)));
  assert.throws(() => rec.exportOm2w(dir, { task: 'x' }), /task-id/);
});

test('daemon sink writes only for tabs that are recording', () => {
  const dir = tmp();
  rec.update('SINKTAB', { dir, port: 1, startedAt: 1, n: 0 });
  try {
    assert.equal(rec.appendFromPage('OTHER', { kind: 'rr', events: [{ type: 2 }] }), false);
    assert.equal(rec.appendFromPage('SINKTAB', { kind: 'rr', events: [{ type: 4 }, { type: 2 }] }), true);
    rec.appendFromPage('SINKTAB', { kind: 'rr', events: [], end: true });
    assert.equal(fs.readFileSync(path.join(dir, 'rrweb.ndjson'), 'utf8').trim().split('\n').length, 2);
    assert.ok(fs.existsSync(path.join(dir, 'rrweb.end')));
  } finally { rec.update('SINKTAB', null); }
});

test('replay page carries the events, steps and stills inline', () => {
  const dir = fakeRecording();
  const html = rec.replayHtml(dir);
  const packed = JSON.parse(html.match(/const EV = ("[^"]*");/)[1]);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(Buffer.from(packed, 'base64'))).map(e => e.type), [4, 2]);
  assert.match(html, /do: click \\"Sort\\"/);
  assert.match(html, /"0001.jpg":"\/9j\//, 'stills are inlined as base64 JPEG');
  assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts');
});

// --------------------------------------------------------------- live ---

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn;

describe('live', { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, () => {
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { conn?.close(); } catch {}
  browser?.close();
  await fixture?.close();
});

test('a recording follows the tab across a navigation and replays', async () => {
  const tab = await ops.newTab(conn, fixture.url);
  await ops.waitForReady(conn, tab.targetId, { waitUntil: 'load' });
  const dir = path.join(tmp(), 'run');
  const started = await rec.start(conn, tab.targetId, { out: dir, label: 'fixture' });
  assert.equal(started.recording, dir);
  assert.ok(rec.get(tab.targetId));

  await ops.fill(conn, tab.targetId, { selector: '#name', value: 'hello' });
  await rec.still(conn, tab.targetId, 'fill #name = "hello"');
  await ops.click(conn, tab.targetId, { selector: '#go' });
  await rec.still(conn, tab.targetId, 'click #go');
  await ops.navigate(conn, tab.targetId, new URL('/slow', fixture.url).href, { waitUntil: 'load' });
  await rec.still(conn, tab.targetId, `nav /slow`);
  assert.equal(await rec.still(conn, tab.targetId, 'read', { ifChanged: true }), null, 'a read on an unchanged page takes no still');

  const res = await rec.stop(conn, tab.targetId);
  assert.equal(rec.get(tab.targetId), null);
  assert.equal(res.steps, 5, 'start, fill, click, nav, stop');
  const events = rec.readEvents(dir);
  const full = events.filter(e => e.type === 2);
  assert.ok(full.length >= 2, `a full snapshot per document (got ${full.length})`);
  assert.ok(events.some(e => e.type === 3), 'incremental events were recorded');
  const shots = fs.readdirSync(path.join(dir, 'trajectory'));
  assert.equal(shots.length, 5);
  for (const f of shots) assert.deepEqual([...fs.readFileSync(path.join(dir, 'trajectory', f)).subarray(0, 3)], [0xff, 0xd8, 0xff], `${f} is a JPEG`);
  const steps = rec.readJsonl(path.join(dir, 'steps.jsonl'));
  assert.match(steps.at(-2).url, /\/slow$/);

  // A navigation after stop is not recorded.
  await ops.navigate(conn, tab.targetId, fixture.url, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 500));
  assert.ok(!fs.existsSync(path.join(dir, 'rrweb.ndjson')));

  // The replay page plays in a browser: player built, events decoded.
  const file = path.join(tmp(), 'replay.html');
  fs.writeFileSync(file, rec.replayHtml(dir));
  await ops.navigate(conn, tab.targetId, `file://${file}`, { waitUntil: 'load' });
  let state = null;
  for (let i = 0; i < 50 && !state; i++) {
    state = await ops.evaluate(conn, tab.targetId, 'window.__replay || null');
    if (!state) await new Promise(r => setTimeout(r, 100));
  }
  assert.deepEqual(state, { events: events.length, steps: 5, dom: true });
  assert.ok(await ops.evaluate(conn, tab.targetId, '!!document.querySelector(".rr-player iframe")'), 'rrweb player mounted');
  await ops.closeTab(conn, tab.targetId);
});
});
