// WebDriver BiDi adapter (Firefox, Camoufox) against a fake BiDi server: sessions, command
// translation, refs, input actions and errors. A real-browser run is in bidi-browser.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeBidi, pageResult } from './bidi-fake.mjs';
import { openSession, withSession, deserialize } from '../lib/bidi/client.mjs';
import { bidiCommand, daemonRequest } from '../lib/bidi/cli.mjs';
import { runCommand } from '../lib/bidi/commands.mjs';
import { startDaemon } from '../lib/bidi/daemon.mjs';
import { keyActions, typingActions, targetOf, KEYS } from '../lib/bidi/ops.mjs';
import { planBidiLaunch, bidiPort, findBidiBrowser, bidiCandidates, isBidiBrowser } from '../lib/bidi/launch.mjs';

const CTX = 'f1e2d3c4-1111-2222-3333-444455556666';
const OTHER = 'a9b8c7d6-1111-2222-3333-444455556666';

// A fake browser with two tabs; page functions are told apart by their source.
function browser({ refs = [{ ref: 'ref_1', role: 'link', name: 'Learn more', state: [], where: '' }], located = { found: true, x: 120, y: 340, tag: 'a' } } = {}) {
  const state = { url: 'https://example.com/', actions: [] };
  return {
    state,
    handler: async (method, params) => {
      switch (method) {
        case 'session.new': return { sessionId: 's1', capabilities: { browserName: 'firefox', browserVersion: '135.0' } };
        case 'session.end': return {};
        case 'browsingContext.getTree': return { contexts: [{ context: CTX, url: state.url, children: [] }, { context: OTHER, url: 'about:blank', children: [] }] };
        case 'browsingContext.create': return { context: CTX };
        case 'browsingContext.navigate': state.url = params.url; return { navigation: 'n1', url: params.url };
        case 'browsingContext.close': case 'browsingContext.activate': return {};
        case 'browsingContext.captureScreenshot': return { data: Buffer.from('PNGDATA').toString('base64') };
        case 'input.performActions': state.actions.push(params); return {};
        case 'input.releaseActions': return {};
        case 'script.evaluate': return { type: 'success', realm: 'r', result: { type: 'object', value: [['a', { type: 'number', value: 1 }], ['b', { type: 'array', value: [{ type: 'string', value: 'x' }, { type: 'null' }] }]] } };
        case 'script.callFunction': {
          const fn = params.functionDeclaration;
          assert.equal(params.target.sandbox, 'browserctrl', 'page helpers run in the sandbox realm');
          if (fn.includes('refs.push')) return pageResult({ title: 'Example Domain', url: state.url, refs, text: 'This domain is for examples.', scrollY: 0, scrollHeight: 800, viewport: 700 });
          if (fn.includes('scrollIntoView')) return pageResult(located);
          if (fn.includes('document.readyState')) {
            const args = JSON.parse(params.arguments[0].value);
            return pageResult({ url: state.url, ready: 'complete', ...(args.text !== undefined ? { text: false } : {}) });
          }
          if (fn.includes('document.title, url')) return pageResult({ title: 'Example Domain', url: state.url });
          if (fn.includes('typeof el.select')) return pageResult({ found: true, value: 'Ada' });
          if (fn.includes('no option')) return pageResult({ found: true, error: 'no option', options: ['Alpha', 'Beta'] });
          return pageResult(null);
        }
        default: throw Object.assign(new Error('unknown'), { error: 'unknown command', message: method });
      }
    },
  };
}

async function withFake(opts, fn) {
  const b = browser(opts);
  const fake = await startFakeBidi(b.handler);
  try { await fn(fake, b.state); } finally { await fake.close(); }
}

// Commands run on one session, as the daemon runs them.
async function run(fake, cmd, positional, flags = {}, key = 'firefox') {
  const s = await openSession(fake.port);
  try { return await runCommand(s, { cmd, positional: [cmd, ...positional], flags: { port: fake.port, ...flags }, port: fake.port, key, owner: 'test-agent' }); }
  finally { await s.close(); }
}

test('status without a daemon looks with a short session of its own', async () => {
  await withFake({}, async fake => {
    const r = await bidiCommand('status', ['status'], { port: fake.port }, { browser: 'firefox', request: async () => { throw new Error('no daemon'); } });
    assert.equal(r.data.daemon, false);
    assert.equal(r.data.browser, 'firefox');
    assert.equal(r.data.tabs, 2);
    assert.deepEqual(fake.methods(), ['session.new', 'browsingContext.getTree', 'session.end']);
  });
});

test('tabs, open (sets the current tab), nav and close by id prefix', async () => {
  await withFake({}, async (fake, state) => {
    const list = await run(fake, 'tabs', []);
    assert.match(list.text, /^f1e2d3c4  Example Domain  https:\/\/example\.com\/$/m);
    const opened = await run(fake, 'open', ['https://example.org/'], { id: true });
    assert.equal(opened.text, 'f1e2d3c4');
    const nav = fake.calls.find(c => c.method === 'browsingContext.navigate');
    assert.deepEqual(nav.params, { context: CTX, url: 'https://example.org/', wait: 'none' });
    await run(fake, 'nav', ['.', 'https://example.net/']);
    assert.equal(state.url, 'https://example.net/');
    await run(fake, 'close', ['a9b8']);
    assert.deepEqual(fake.calls.find(c => c.method === 'browsingContext.close').params, { context: OTHER });
  });
});

test('Camoufox: open makes the tab from a page (its browsingContext.create never answers)', async () => {
  const contexts = [{ context: CTX, url: 'about:blank', children: [] }];
  let landed = 'about:blank';
  const fake = await startFakeBidi(async (method, params) => {
    if (method === 'session.new') return { capabilities: { browserName: 'camoufox' } };
    if (method === 'browsingContext.getTree') return { contexts };
    if (method === 'browsingContext.create') return new Promise(() => {});
    if (method === 'script.evaluate') {
      assert.equal(params.userActivation, true);
      assert.equal(params.expression, 'Boolean(window.open("https://example.com/", "_blank"))');
      // The popup first appears blank under one id, then Camoufox swaps in a loaded context.
      setTimeout(() => contexts.push({ context: 'deadbeef-0000', url: 'about:blank', children: [] }), 30);
      setTimeout(() => { contexts.pop(); contexts.push({ context: OTHER, url: 'https://example.com/', children: [] }); landed = 'https://example.com/'; }, 200);
      return { type: 'success', result: { type: 'boolean', value: true } };
    }
    if (method === 'script.callFunction') return pageResult({ url: landed, ready: 'complete' });
    return {};
  });
  try {
    const r = await run(fake, 'open', ['https://example.com/'], { id: true }, 'camoufox');
    assert.equal(r.text, 'a9b8c7d6');
    assert.ok(!fake.methods().includes('browsingContext.create'));
    assert.ok(!fake.methods().includes('browsingContext.navigate'), 'the popup is opened at the URL, not navigated');
  } finally { await fake.close(); }
});

test('read lists refs like the Chromium read and click sends real pointer input at the element', async () => {
  await withFake({}, async (fake, state) => {
    const read = await run(fake, 'read', ['f1e2']);
    assert.match(read.text, /^Example Domain\nhttps:\/\/example\.com\//);
    assert.match(read.text, / ref_1    link       Learn more/);
    assert.match(read.text, /--- text ---\nThis domain is for examples\./);
    const click = await run(fake, 'click', ['f1e2', 'ref_1']);
    assert.equal(click.data.clicked, 'ref_1');
    const actions = state.actions.at(-1).actions[0];
    assert.equal(actions.type, 'pointer');
    assert.deepEqual(actions.actions[0], { type: 'pointerMove', x: 120, y: 340, origin: 'viewport' });
    assert.deepEqual(actions.actions.slice(1).map(a => a.type), ['pointerDown', 'pointerUp']);
  });
});

test('a ref that is gone asks for a fresh read; ambiguous and unknown tabs are usage errors', async () => {
  await withFake({ located: { found: false } }, async fake => {
    await assert.rejects(run(fake, 'click', ['f1e2', 'ref_9']), /ref_9 is not on the page any more; read it again/);
    await assert.rejects(run(fake, 'read', ['zzzz']), err => err.code === 'TAB_NOT_FOUND');
    await assert.rejects(run(fake, 'click', ['f1e2']), err => err.code === 'USAGE');
  });
});

test('fill clicks, selects the old text, then types; select reports the options when none match', async () => {
  await withFake({}, async (fake, state) => {
    const r = await run(fake, 'fill', ['f1e2', 'ref_1', 'Ada']);
    assert.equal(r.data.value, 'Ada');
    const typed = state.actions.flatMap(a => a.actions).filter(a => a.type === 'key').flatMap(a => a.actions);
    assert.equal(typed[0].value, KEYS.backspace);
    assert.deepEqual(typed.filter(a => a.type === 'keyDown').slice(1).map(a => a.value).join(''), 'Ada');
    await assert.rejects(run(fake, 'select', ['f1e2', 'ref_1', 'Gamma']), /No option "Gamma". Options: Alpha \| Beta/);
  });
});

test('eval returns plain values; wait times out with exit 1; screenshots are written', async () => {
  await withFake({}, async fake => {
    const e = await run(fake, 'eval', ['f1e2', '({a:1,b:["x",null]})']);
    assert.deepEqual(e.data, { a: 1, b: ['x', null] });
    const w = await run(fake, 'wait', ['f1e2'], { text: 'never', timeout: '300' });
    assert.equal(w.exitCode, 1);
    assert.equal(w.data.met, false);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-bidi-')), 'shot.png');
    const shot = await run(fake, 'shot', ['f1e2', file]);
    assert.match(shot.text, /^Saved .*shot\.png \(0 KB\)$/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'PNGDATA');
    const full = fake.calls.filter(c => c.method === 'browsingContext.captureScreenshot');
    assert.equal(full[0].params.origin, 'viewport');
  });
});

test('unsupported commands name what works; a second session is explained', async () => {
  await withFake({}, async fake => {
    await assert.rejects(bidiCommand('do', ['do', 'f1e2'], { port: fake.port }, { browser: 'firefox' }), err => err.exitCode === 2 && /Chromium-only/.test(err.message));
  });
  const busy = await startFakeBidi(async method => {
    if (method === 'session.new') throw Object.assign(new Error(), { error: 'session not created', message: 'Maximum number of active sessions' });
    return {};
  });
  try {
    await assert.rejects(openSession(busy.port), /already has a WebDriver BiDi session/);
  } finally { await busy.close(); }
  await assert.rejects(openSession(1, { timeoutMs: 2000 }), /Could not connect to WebDriver BiDi|No WebDriver BiDi endpoint/);
});

test('withSession serializes commands on one port', async () => {
  let active = 0;
  let maxActive = 0;
  const fake = await startFakeBidi(async method => {
    if (method === 'session.new') { active += 1; maxActive = Math.max(maxActive, active); return { capabilities: {} }; }
    if (method === 'session.end') { active -= 1; return {}; }
    await new Promise(r => setTimeout(r, 50));
    return { contexts: [] };
  });
  try {
    await Promise.all([1, 2, 3].map(() => withSession(fake.port, s => s.send('browsingContext.getTree', {}))));
    assert.equal(maxActive, 1);
  } finally { await fake.close(); }
});

test('key combos, typing and targets', () => {
  assert.deepEqual(keyActions('Control+a').map(a => [a.type, a.value]), [['keyDown', KEYS.control], ['keyDown', 'a'], ['keyUp', 'a'], ['keyUp', KEYS.control]]);
  assert.deepEqual(keyActions('Enter').map(a => a.value), [KEYS.enter, KEYS.enter]);
  assert.throws(() => keyActions('Hyper'), /Unknown key "Hyper"/);
  assert.equal(typingActions('a\n').filter(a => a.type === 'keyDown').map(a => a.value).join(''), `a${KEYS.enter}`);
  assert.deepEqual(targetOf(['click', 't', 'ref_3'], {}), { ref: 'ref_3' });
  assert.deepEqual(targetOf(['click', 't', '#go'], {}), { selector: '#go' });
  assert.deepEqual(targetOf(['click', 't'], { x: '5', y: '6' }), { x: 5, y: 6 });
  assert.equal(targetOf(['click', 't'], {}), null);
  assert.deepEqual(deserialize({ type: 'number', value: 'NaN' }), NaN);
  assert.equal(deserialize({ type: 'undefined' }), undefined);
});

test('launch planning: own profile, BiDi port, headless; binaries and ports from settings', () => {
  assert.ok(isBidiBrowser('Camoufox') && isBidiBrowser('firefox') && !isBidiBrowser('chrome'));
  assert.equal(bidiPort('firefox', { env: {} }), 9337);
  assert.equal(bidiPort('camoufox', { env: { BROWSERCTRL_CAMOUFOX_PORT: '9400' } }), 9400);
  assert.equal(bidiPort('camoufox', { port: '9341', env: {} }), 9341);
  assert.throws(() => bidiPort('firefox', { port: 'x' }), /TCP port/);
  const plan = planBidiLaunch({ key: 'camoufox', port: 9341, userDataDir: '/p', headless: true, platform: 'linux', env: {}, home: '/h', exists: p => p === '/h/.cache/camoufox/camoufox-bin', which: () => null });
  assert.equal(plan.exe, '/h/.cache/camoufox/camoufox-bin');
  assert.deepEqual(plan.args, ['--remote-debugging-port', '9341', '-no-remote', '-profile', '/p', '--headless', 'about:blank']);
  assert.equal(findBidiBrowser('firefox', { env: { BROWSERCTRL_FIREFOX_BIN: '/x/ff' }, exists: () => false }), null);
  assert.ok(bidiCandidates('firefox', { platform: 'darwin' })[0].includes('Firefox.app'));
  assert.throws(() => planBidiLaunch({ key: 'firefox', port: 1, platform: 'linux', env: {}, exists: () => false, which: () => null }), /BROWSERCTRL_FIREFOX_BIN/);
});

test('the daemon keeps one session across requests (Camoufox renumbers tabs per session) and stops on request', async () => {
  await withFake({}, async fake => {
    const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-bidi-d-')), 'd.sock');
    let exited = null;
    const d = await startDaemon({ port: fake.port, key: 'firefox', socketPath, idleMs: 60000, exit: code => { exited = code; } });
    const ask = payload => daemonRequest(fake.port, payload, { start: false, socketPath });
    const opened = await ask({ op: 'call', cmd: 'open', positional: ['open', 'https://example.org/'], flags: { id: true }, owner: 'agent-a', key: 'firefox' });
    assert.equal(opened.text, 'f1e2d3c4');
    const read = await ask({ op: 'call', cmd: 'read', positional: ['read', '.'], flags: {}, owner: 'agent-a', key: 'firefox' });
    assert.match(read.text, /ref_1/);
    await assert.rejects(ask({ op: 'call', cmd: 'read', positional: ['read', '.'], flags: {}, owner: 'agent-b', key: 'firefox' }), /no current tab/);
    assert.equal(fake.methods().filter(m => m === 'session.new').length, 1, 'one session for every request');
    assert.deepEqual(await ask({ op: 'stop' }), { stopped: true, port: fake.port });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(exited, 0);
    assert.ok(fake.methods().includes('session.end'));
    d.server.close();
  });
});
