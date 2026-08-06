// Human-to-agent handoff: tab identity, marks, annotations, recording and the
// resolution of video marks back to real events.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Every test in this file writes state, so give it a throwaway CDP_HOME before
// anything imports the modules that read it.
process.env.CDP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-home-'));

const { connect } = await import('../lib/daemon.mjs');
const ops = await import('../lib/ops.mjs');
const state = await import('../lib/state.mjs');
const annotations = await import('../lib/annotations.mjs');
const recstore = await import('../lib/recstore.mjs');
const recorder = await import('../lib/recorder.mjs');
const { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } = await import('./helpers.mjs');

const haveBrowser = Boolean(chromeBinary());
let fixture;
let browser;
let conn;
let tabId;

before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT + 1);
  conn = await connect(TEST_PORT + 1);
  const tab = await ops.newTab(conn, fixture.url);
  tabId = tab.targetId;
  await ops.waitForReady(conn, tabId, { waitUntil: 'load' });
});

after(async () => {
  try {
    conn?.close();
  } catch {}
  browser?.close();
  await fixture?.close();
  fs.rmSync(process.env.CDP_HOME, { recursive: true, force: true });
});

const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);

// ------------------------------------------------------------ identity ------

t('tabs report which one the human is focused on', async () => {
  const rows = await ops.tabs(conn, { focus: true });
  const row = rows.find(r => r.targetId === tabId);
  assert.ok(row, 'the fixture tab should be listed');
  assert.equal(typeof row.focused, 'boolean', 'focus must be answered, not omitted');
});

t('an alias resolves a tab, and naming it again moves the alias', async () => {
  state.setAlias(TEST_PORT + 1, tabId, 'fixture');
  const resolved = await ops.resolveTab(conn, 'fixture');
  assert.equal(resolved.targetId, tabId);

  const second = await ops.newTab(conn, 'about:blank');
  state.setAlias(TEST_PORT + 1, second.targetId, 'fixture');
  const moved = await ops.resolveTab(conn, 'fixture');
  assert.equal(moved.targetId, second.targetId, 'an alias names exactly one tab');
  await ops.closeTab(conn, second.targetId);
  state.setAlias(TEST_PORT + 1, tabId, 'fixture');
});

// --------------------------------------------------------------- marks ------

t('a marked tab resolves as "marked", and two marked tabs make it ask', async () => {
  state.mark(TEST_PORT + 1, tabId, { note: 'look at the empty state' });
  const resolved = await ops.resolveTab(conn, 'marked');
  assert.equal(resolved.targetId, tabId);
  assert.equal(resolved.marked.note, 'look at the empty state');

  const second = await ops.newTab(conn, 'about:blank');
  state.mark(TEST_PORT + 1, second.targetId, {});
  await assert.rejects(() => ops.resolveTab(conn, 'marked'), /2 tabs are marked/);
  state.unmark(TEST_PORT + 1, second.targetId);
  await ops.closeTab(conn, second.targetId);
});

test('marks expire so a forgotten one cannot steer a later session', () => {
  const file = path.join(process.env.CDP_HOME, 'state.json');
  state.mark(4242, 'stale-target', { note: 'old' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = Object.keys(raw.marks).find(k => k.includes('stale-target'));
  raw.marks[key].ts = Date.now() - state.MARK_TTL_MS - 1000;
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(state.marks(4242).length, 0, 'an expired mark must not be reported');
});

// ---------------------------------------------------------- annotations -----

t('the overlay captures an element the way an agent can act on it', async () => {
  await ops.installOverlay(conn, tabId, { bridgePort: 1 });
  const identity = await ops.evaluate(conn, tabId, "JSON.stringify(window.__cdpOverlay.identity('#go'))");
  const parsed = JSON.parse(identity);
  assert.equal(parsed.role, 'button');
  assert.equal(parsed.name, 'Run it');
  assert.ok(
    parsed.selectors.some(s => s.includes('go-button')),
    `a test id should be the first selector offered, got ${parsed.selectors.join(' | ')}`,
  );
});

t('a captured annotation reaches the queue with tab identity and a screenshot', async () => {
  annotations.clear();
  await ops.evaluate(conn, tabId, "window.__cdpOverlay.capture('#go', 'this button should say Start')");
  // The daemon receives it over the binding, then screenshots it.
  await new Promise(r => setTimeout(r, 1500));
  const rows = annotations.pending();
  assert.equal(rows.length, 1, 'exactly one annotation should be queued');
  const row = rows[0];
  assert.equal(row.note, 'this button should say Start');
  assert.equal(row.element.role, 'button');
  assert.equal(row.element.name, 'Run it');
  assert.equal(row.tab.targetId, tabId, 'the annotation must know which tab it came from');
  assert.ok(fs.existsSync(row.screenshot), 'a cropped screenshot should be written');
  assert.ok(fs.statSync(row.screenshot).size > 100, 'the screenshot should not be empty');
  assert.ok(state.marks(TEST_PORT + 1).some(m => m.targetId === tabId), 'annotating a tab hands it over');
});

t('reading annotations is not consuming them', async () => {
  assert.equal(annotations.pending().length, 1);
  assert.equal(annotations.pending().length, 1, 'peeking twice must not drain the queue');
  assert.equal(annotations.consume().length, 1);
  assert.equal(annotations.pending().length, 0, 'consuming clears them');
});

test('the piggyback line is the harness-independent handoff', () => {
  annotations.clear();
  assert.equal(annotations.piggyback(0), '', 'nothing to say when the queue is empty');
  annotations.add({ note: 'x' });
  assert.match(annotations.piggyback(0), /1 pending annotation/);
  assert.match(annotations.piggyback(2), /2 marked tabs/);
  annotations.clear();
});

// ------------------------------------------------------------ recording -----

t('a recording captures a real click with element identity', async () => {
  const meta = await recorder.start({ port: TEST_PORT + 1, video: false, apps: false, label: 'test' });
  await ops.click(conn, tabId, { selector: '#go' });
  await new Promise(r => setTimeout(r, 1500));
  await recorder.stop(meta.id);

  const events = recstore.readJsonl(recstore.eventsPath(meta.id));
  const click = events.find(e => e.type === 'click');
  assert.ok(click, `a click should be recorded, saw ${events.map(e => e.type).join(',')}`);
  assert.equal(click.element.role, 'button');
  assert.equal(click.element.name, 'Run it');
  assert.equal(click.element.testid, 'go-button');

  const steps = fs.readFileSync(path.join(recstore.dir(meta.id), 'steps.md'), 'utf8');
  assert.match(steps, /\*\*click\*\* button "Run it"/, 'steps.md should read as prose');
});

t('a video mark resolves to the nearest real event, not a frame number', async () => {
  const meta = await recorder.start({ port: TEST_PORT + 1, video: false, apps: false });
  await ops.click(conn, tabId, { selector: '#go' });
  await new Promise(r => setTimeout(r, 1200));
  await recorder.stop(meta.id);

  const events = recstore.readJsonl(recstore.eventsPath(meta.id));
  const click = events.find(e => e.type === 'click');
  const seconds = (click.t - meta.startedAt) / 1000;
  recorder.addMark(meta.id, { t: seconds, note: 'this should have been disabled' });

  const [resolved] = recorder.resolvedMarks(meta.id);
  assert.equal(resolved.note, 'this should have been disabled');
  assert.match(resolved.summary, /click on button "Run it"/);
  assert.equal(resolved.events[0].element.testid, 'go-button');
});

t('a mark with nothing near it says so rather than inventing a link', async () => {
  const meta = await recorder.start({ port: TEST_PORT + 1, video: false, apps: false });
  await recorder.stop(meta.id);
  recorder.addMark(meta.id, { t: 9999, note: 'way out of range' });
  const [resolved] = recorder.resolvedMarks(meta.id);
  assert.equal(resolved.events.length, 0);
  assert.match(resolved.summary, /no nearby activity|frontmost/);
});

// ------------------------------------------------------------ extension -----

test('the extension does not fork the overlay', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const shared = fs.readFileSync(path.join(here, '..', 'lib', 'overlay', 'annotate.js'), 'utf8');
  const copy = fs.readFileSync(path.join(here, '..', 'extension', 'annotate.js'), 'utf8');
  assert.equal(copy, shared, 'extension/annotate.js is stale: run `npm run sync-extension`');
});

test('the extension asks for no more permission than it needs', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'extension', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'http://localhost/*'],
    'the extension must only be able to reach the local bridge');
  assert.ok(!manifest.permissions.includes('debugger'), 'the extension has no business with the debugger API');
});

// ---------------------------------------------------------------- pins ------

t('past annotations show as pins anchored to their elements', async () => {
  annotations.clear();
  await ops.installOverlay(conn, tabId, { bridgePort: 1, force: true });
  await ops.evaluate(conn, tabId, "window.__cdpOverlay.capture('#go', 'first note')");
  await ops.evaluate(conn, tabId, "window.__cdpOverlay.capture('#name', 'second note')");
  await new Promise(r => setTimeout(r, 1200));

  const rows = annotations.pending();
  assert.equal(rows.length, 2);
  const shown = await ops.evaluate(
    conn,
    tabId,
    `window.__cdpOverlay.setPins(${JSON.stringify(rows)}, [])`,
  );
  assert.equal(shown, 2, 'both annotations should render as pins');

  const placed = await ops.evaluate(
    conn,
    tabId,
    `JSON.stringify([...document.documentElement.children]
       .filter(n => n.tagName === 'DIV' && n.style && (n.style.borderRadius || '').indexOf('50%') === 0)
       .map(n => ({ text: n.textContent, left: parseFloat(n.style.left), top: parseFloat(n.style.top) })))`,
  );
  const parsed = JSON.parse(placed);
  assert.equal(parsed.length, 2);
  assert.ok(parsed.every(p => p.left >= 0 && p.top >= 0), 'pins should be positioned on the page');
  assert.deepEqual(parsed.map(p => p.text), ['1', '2'], 'pins are numbered in order');
});

t('a pin for an element that no longer exists still shows, flagged', async () => {
  annotations.clear();
  await ops.evaluate(conn, tabId, "window.__cdpOverlay.capture('#go', 'about to vanish')");
  await new Promise(r => setTimeout(r, 1000));
  const rows = annotations.pending();
  await ops.evaluate(conn, tabId, "document.getElementById('go').remove(), true");
  await ops.evaluate(conn, tabId, `window.__cdpOverlay.setPins(${JSON.stringify(rows)}, [])`);
  const moved = await ops.evaluate(
    conn,
    tabId,
    `[...document.documentElement.children]
       .filter(n => n.tagName === 'DIV' && (n.style.borderRadius || '').indexOf('50%') === 0)
       .map(n => n.title)[0]`,
  );
  assert.match(moved || '', /gone/, 'an orphaned pin should say so rather than disappear');
  await ops.navigate(conn, tabId, fixture.url, { waitUntil: 'load' });
  annotations.clear();
});

// ------------------------------------------------------------- routing -----

test('an annotation aimed at one session is hidden from the others', () => {
  annotations.clear();
  annotations.add({ note: 'for everyone', page: { url: 'x' } });
  annotations.add({ note: 'for session A', for: 'session-a', page: { url: 'x' } });

  const seenByA = annotations.pending({ sessionId: 'session-a' }).map(r => r.note);
  const seenByB = annotations.pending({ sessionId: 'session-b' }).map(r => r.note);
  assert.deepEqual(seenByA, ['for everyone', 'for session A']);
  assert.deepEqual(seenByB, ['for everyone'], 'B must not see what was aimed at A');

  assert.equal(annotations.consume({ sessionId: 'session-b' }).length, 1);
  assert.deepEqual(
    annotations.pending({ sessionId: 'session-a' }).map(r => r.note),
    ['for session A'],
    "B consuming the shared one must not take A's",
  );
  annotations.clear();
});

test('resolving an annotation removes it and its screenshot', () => {
  annotations.clear();
  const row = annotations.add({ note: 'temporary', page: { url: 'x' } });
  fs.writeFileSync(annotations.shotPath(row.id), 'not really a png');
  annotations.update(row.id, { screenshot: annotations.shotPath(row.id) });
  assert.equal(annotations.remove(row.id), true);
  assert.equal(annotations.pending().length, 0);
  assert.equal(fs.existsSync(annotations.shotPath(row.id)), false, 'the screenshot should go with it');
});

test('live sessions are listed so an annotation can be aimed at one', async () => {
  const sessionsMod = await import('../lib/sessions.mjs');
  sessionsMod.register({ id: 'sess-1', client: 'claude-code', cwd: '/tmp/project-one' });
  sessionsMod.register({ id: 'sess-2', client: 'codex', cwd: '/tmp/project-two' });
  const live = sessionsMod.live();
  assert.ok(live.length >= 2);
  assert.ok(live.some(s => s.name.includes('project-one')), 'a session should be nameable by its project');
});
