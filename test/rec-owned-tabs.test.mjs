// The recording owns only tabs opened by its plan. All browser and state files
// come from the isolated test rig, never the user's browser or storage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { chromeBinary, startHeadlessBrowser, TEST_PORT } from './helpers.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as rec from '../lib/rec.mjs';
import { runSteps } from '../lib/steps.mjs';
import { renderVideo } from '../lib/video.mjs';
import { panelTimeline } from '../lib/recording-timeline.mjs';
import { fakeJev, optionWith } from './fake-jev.mjs';

const haveBrowser = Boolean(chromeBinary());
const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
let browser, conn, server, base, loopDir;
const dirs = [];
const makeDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-rec-owned-')); dirs.push(dir); return dir; };
const cards = () => `<main><h1>Hotels</h1><p>${'Browse the hotel prices and policies. '.repeat(8)}</p><ul>${[1, 2, 3].map(id => `<li style="height:90px;border:1px solid #ccc"><a href="${base}/detail?id=${id}">Hotel ${id}</a><p>SGD ${id * 100} free cancellation</p></li>`).join('')}</ul></main>`;
before(async () => {
  if (!haveBrowser) return;
  server = http.createServer((req, res) => {
    const id = new URL(req.url, 'http://local').searchParams.get('id');
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><title>${id ? `Detail ${id}` : 'Hotels'}</title><style>body{font:24px system-ui;padding:32px;background:#f7f4ec}main{max-width:850px}h1{color:#234b53}</style></head><body>${id ? `<main><h1>${id === '2' ? 'Correct hotel' : `Hotel ${id}`}</h1><p>${'Comfortable room with excellent transport connections and free cancellation. '.repeat(8)}</p><p>SGD ${Number(id) * 100}</p></main>` : cards()}</body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { await conn?.stop(); } catch {}
  conn?.close();
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
const options = jev => ({ jev, noNotes: true, traceRun: false, prefetch: false, minP: .3 });
const rows = dir => rec.readJsonl(path.join(dir, 'steps.jsonl'));
const meta = dir => JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const instrumented = tab => ops.evaluateInWorld(conn, tab, '!!window.__bcRec');
async function newSource() {
  const tab = (await ops.newTab(conn, `${base}/source`)).targetId;
  await ops.waitForReady(conn, tab);
  return tab;
}
function assertTrack(dir, track) {
  assert.equal(track.dir, `tracks/${track.tab}`);
  assert.match(track.url, /\/detail\?id=\d$/);
  assert.ok(track.label);
  const events = rec.readEvents(path.join(dir, track.dir));
  assert.ok(events.some(e => e.type === 2), `full DOM snapshot for ${track.path}`);
  const childRows = rows(dir).filter(row => row.tab === track.tab && row.screenshot);
  assert.ok(childRows.length > 0, `stills for ${track.path}`);
  assert.ok(childRows.every(row => typeof row.path === 'string'));
  assert.ok(childRows.some(row => row.path.startsWith(track.path)));
  assert.ok(events.every(event => event.tab === track.tab && event.path === track.path && event.url === track.url));
  for (const row of childRows) {
    assert.ok(fs.existsSync(path.join(dir, 'trajectory', row.screenshot)), row.screenshot);
    assert.deepEqual([...fs.readFileSync(path.join(dir, 'trajectory', row.screenshot)).subarray(0, 3)], [0xff, 0xd8, 0xff]);
  }
}
// Inspect immediately before CDP closes each child. Inspecting after close could
// miss instrumentation/state that leaked for the lifetime of the tab.
function observeCloses(source) {
  const original = conn.browser;
  const observations = [];
  conn.browser = async function(method, params, ...rest) {
    if (method === 'Target.closeTarget' && params.targetId !== source) {
      observations.push({ tab: params.targetId, state: rec.get(params.targetId), instrumented: await instrumented(params.targetId), sourceState: rec.get(source), sourceInstrumented: await instrumented(source) });
    }
    return original.call(this, method, params, ...rest);
  };
  return { observations, restore() { conn.browser = original; } };
}

test('panel timeline switches only at owned-tab rows and restores the source', () => {
  const source = 'SOURCE', child = 'CHILD';
  const steps = [
    { at: 1000, tab: source, action: 'start recording' },
    { at: 2000, event: 'tab-open', tab: child, sourceTab: source, label: 'item 2 of 3', url: 'https://hotel.test/detail' },
    { at: 2500, tab: child, path: '1.item[2].1', action: 'do: extract "price"' },
    { at: 3000, event: 'tab-close', tab: child, sourceTab: source },
    { at: 4000, tab: source, action: 'stop recording' },
  ];
  assert.deepEqual(panelTimeline(steps, source), [
    { at: 0, tab: source, label: '', url: '' },
    { at: 2000, tab: child, label: 'item 2 of 3', url: 'https://hotel.test/detail' },
    { at: 3000, tab: source, label: '', url: '' },
  ]);
  assert.deepEqual(panelTimeline([{ at: 1000, action: 'start recording' }, { at: 2000, action: 'read' }], source), [
    { at: 0, tab: source, label: '', url: '' },
  ], 'legacy recordings retain one source panel');
});

test('recorded loop follows all three owned tabs and removes instrumentation before close', { skip: !haveBrowser }, async () => {
  const tab = await newSource(), unrelated = (await ops.newTab(conn, `${base}/unrelated`)).targetId;
  loopDir = makeDir();
  const closes = observeCloses(tab);
  try {
    await rec.start(conn, tab, { out: loopDir, label: 'Three hotel prices' });
    const jev = fakeJev({ choice: q => optionWith(q, 'SGD'), noul: (q, id) => id === 'extract_verify' ? .95 : .04 });
    const result = await runSteps(conn, tab, ['for top 3 { extract "price" }'], options(jev));
    assert.equal(result.done, true, JSON.stringify(result.stopped));
    assert.equal(result.items_completed, 3);
    const tracks = meta(loopDir).tracks;
    assert.equal(tracks.length, 3);
    assert.deepEqual(tracks.map(track => track.path), ['1.item[1]', '1.item[2]', '1.item[3]']);
    for (const track of tracks) assertTrack(loopDir, track);
    assert.equal(closes.observations.length, 3);
    for (const observation of closes.observations) {
      assert.equal(observation.state, null);
      assert.equal(observation.instrumented, false);
      assert.ok(observation.sourceState);
      assert.equal(observation.sourceInstrumented, true);
    }
    assert.equal(rec.get(unrelated), null);
    assert.equal(await instrumented(unrelated), false);
    assert.equal(await instrumented(tab), true);
    const lifecycle = rows(loopDir).filter(row => ['tab-open', 'tab-close'].includes(row.event));
    assert.equal(lifecycle.length, 6);
    for (const track of tracks) {
      const events = lifecycle.filter(row => row.tab === track.tab);
      assert.deepEqual(events.map(row => row.event), ['tab-open', 'tab-close']);
      assert.ok(events.every(row => row.sourceTab === tab && row.path === track.path));
      assert.match(events[0].action, /opened item .*background tab/i);
      assert.match(events[1].action, /closed item/i);
      assert.ok(rows(loopDir).some(row => row.tab === track.tab && row.path === `${track.path}.1` && /extract/.test(row.action)));
    }
    const switches = panelTimeline(rows(loopDir), tab);
    assert.deepEqual(switches.map(row => row.tab), [tab, ...tracks.flatMap(track => [track.tab, tab])]);
    for (const track of tracks) {
      const opened = lifecycle.find(row => row.tab === track.tab && row.event === 'tab-open');
      assert.equal(switches.find(row => row.tab === track.tab).at, opened.at);
    }
    assert.deepEqual(result.owned_tabs, []);
    assert.ok(!(await ops.tabs(conn)).some(t => tracks.some(track => track.tab === t.id)));
    await rec.stop(conn, tab);
    assert.equal(await instrumented(tab), false);
    const html = rec.replayHtml(loopDir);
    assert.ok(tracks.every(track => html.includes(track.tab)), 'HTML replay contains all child tracks');
    const replayFile = path.join(loopDir, 'replay.html');
    fs.writeFileSync(replayFile, html);
    const replayTab = (await ops.newTab(conn, `file://${replayFile}`)).targetId;
    try {
      await ops.waitForReady(conn, replayTab);
      for (let i = 0; i < 100; i++) {
        if (await ops.evaluate(conn, replayTab, '!!window.__replay')) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(await ops.evaluate(conn, replayTab, '!!window.__replay'), true);
      const start = rec.readEvents(loopDir)[0].timestamp;
      for (const track of tracks) {
        const opened = lifecycle.find(row => row.event === 'tab-open' && row.tab === track.tab);
        const label = await ops.evaluate(conn, replayTab, `(() => {
          const seek = document.getElementById('seek');
          seek.value = ${opened.at - start}; seek.dispatchEvent(new Event('input'));
          return document.getElementById('note').textContent;
        })()`);
        assert.match(label, new RegExp(track.label));
      }
      await ops.evaluate(conn, replayTab, "document.getElementById('bstill').click()");
      const closed = lifecycle.find(row => row.event === 'tab-close');
      const state = await ops.evaluate(conn, replayTab, `(() => {
        const seek = document.getElementById('seek');
        seek.value = ${closed.at - start}; seek.dispatchEvent(new Event('input'));
        return {label:document.getElementById('note').textContent, still:document.getElementById('still').style.display, src:document.getElementById('still').src};
      })()`);
      assert.equal(state.label, '');
      assert.equal(state.still, 'block');
      assert.match(state.src, /^data:image\/jpeg;base64,/);
    } finally { await ops.closeTab(conn, replayTab); }

  } finally {
    closes.restore();
    if (rec.get(tab)) await rec.stop(conn, tab);
    await ops.closeTab(conn, unrelated);
    await ops.closeTab(conn, tab);
  }
});

test('recorded try pick captures rejection and retains an uninstrumented accepted tab', { skip: !haveBrowser }, async () => {
  const tab = await newSource(), dir = makeDir(), closes = observeCloses(tab);
  let result;
  try {
    await rec.start(conn, tab, { out: dir, label: 'Trying two hotels' });
    const jev = fakeJev({
      choice: (q, id) => {
        if (id !== 'pick' && id !== 'target') return optionWith(q, 'Correct hotel');
        const a = optionWith(q, 'Hotel 1'), b = optionWith(q, 'Hotel 2');
        return { choice: a, probabilities: { [a]: .55, [b]: .4, none: .05 } };
      },
      noul: (q, id, state) => id === 'prev_expect' ? (JSON.stringify(state).includes('Correct hotel') ? .75 : .25) : .04,
    });
    result = await runSteps(conn, tab, ['try pick "a suitable hotel" up to 3 => "the hotel is suitable"', 'extract "hotel name"'], options(jev));
    assert.equal(result.done, true, JSON.stringify(result.stopped));
    assert.deepEqual(result.attempts.map(attempt => attempt.check_p), [.25, .75]);
    const tracks = meta(dir).tracks;
    assert.equal(tracks.length, 2);
    assert.ok(tracks.every(track => /attempt\[\d\]/.test(track.path)));
    for (const track of tracks) assertTrack(dir, track);
    assert.equal(closes.observations.length, 1);
    assert.equal(closes.observations[0].state, null);
    assert.equal(closes.observations[0].instrumented, false);
    assert.equal(closes.observations[0].sourceInstrumented, true);
    assert.equal(result.owned_tabs.length, 1);
    const accepted = result.owned_tabs[0];
    assert.equal(rec.get(accepted), null);
    assert.ok(rows(dir).some(row => row.tab === accepted && row.event === 'track-stop'));
    assert.ok(!rows(dir).some(row => row.tab === accepted && row.event === 'tab-close'));
    assert.equal(await instrumented(accepted), false);
    assert.equal(await ops.evaluate(conn, accepted, 'location.search'), '?id=2');
    assert.equal(await instrumented(tab), true);
    assert.ok(rows(dir).some(row => row.tab === accepted && /extract/.test(row.action)), 'following extraction stays on accepted track');
    await rec.stop(conn, tab);
  } finally {
    closes.restore();
    if (rec.get(tab)) await rec.stop(conn, tab);
    for (const owned of result?.owned_tabs || []) await ops.closeTab(conn, owned);
    await ops.closeTab(conn, tab);
  }
});

test('a still write failure still removes child instrumentation and closes the owned tab', { skip: !haveBrowser }, async () => {
  const { openOwnedTab, closeOwnedTab } = await import('../lib/do/owned-tabs.mjs');
  const source = await newSource(), dir = makeDir();
  const ctx = { conn, tab: source, report: {} };
  let child;
  try {
    await rec.start(conn, source, { out: dir });
    child = await openOwnedTab(ctx, `${base}/detail?id=1`, { path: '1.item[1]', label: 'item 1 of 1' });
    fs.rmSync(path.join(dir, 'steps.jsonl'));
    fs.mkdirSync(path.join(dir, 'steps.jsonl'));
    await assert.rejects(closeOwnedTab(ctx, child), /EISDIR/);
    assert.equal(rec.get(child), null);
    assert.ok(!(await ops.tabs(conn)).some(tab => tab.id === child));
    assert.equal(await instrumented(source), true);
  } finally {
    fs.rmSync(path.join(dir, 'steps.jsonl'), { recursive: true, force: true });
    if (rec.get(source)) await rec.stop(conn, source);
    await ops.closeTab(conn, source);
  }
});

test('fixture loop renders a video and four sample frames', { skip: !haveBrowser || !haveFfmpeg }, async () => {
  assert.ok(loopDir, 'loop recording was created');
  const out = '/tmp/codex-bc/rec-tabs-loop.mp4';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const rendered = await renderVideo([loopDir], { out, fps: 2, width: 640, trace: true });
  assert.ok(fs.statSync(out).size > 0);
  for (let i = 0; i < 4; i++) {
    const at = rendered.seconds * (i + .5) / 4;
    const frame = `/tmp/codex-bc/rec-tabs-loop-frame-${i + 1}.jpg`;
    const extraction = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(at), '-i', out, '-frames:v', '1', frame], { encoding: 'utf8' });
    assert.equal(extraction.status, 0, extraction.stderr);
    assert.ok(fs.statSync(frame).size > 0);
  }
});
