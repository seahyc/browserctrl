import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLocalState, resolveProfile, parseProcessCommand, mapContexts, launchCommand, labelTabs } from '../lib/profiles.mjs';

const LOCAL_STATE = {
  profile: {
    info_cache: {
      'Profile 10': { name: 'Ten' },
      'Profile 2': { name: 'Beta Work', user_name: 'beta@example.com' },
      Default: { name: 'Alpha' },
      'Profile 1': { name: 'Beta' },
    },
    last_active_profiles: ['Default', 'Profile 2'],
  },
};

test('Local State parsing: names, emails, active flags, natural order', () => {
  const profiles = parseLocalState(LOCAL_STATE);
  assert.deepEqual(profiles.map(p => p.dir), ['Default', 'Profile 1', 'Profile 2', 'Profile 10']);
  assert.deepEqual(profiles[2], { dir: 'Profile 2', name: 'Beta Work', email: 'beta@example.com', lastActive: true });
  assert.equal(profiles[1].lastActive, false);
  assert.deepEqual(parseLocalState({}), []);
  assert.deepEqual(parseLocalState({ profile: { info_cache: { Default: {} } } }), [{ dir: 'Default', name: 'Default', email: null, lastActive: false }]);
});

test('profile resolution: directory, exact name, unique prefix, case-insensitive', () => {
  const profiles = parseLocalState(LOCAL_STATE);
  assert.equal(resolveProfile(profiles, 'profile 2').dir, 'Profile 2');
  assert.equal(resolveProfile(profiles, 'alpha').dir, 'Default');
  assert.equal(resolveProfile(profiles, 'Al').dir, 'Default');
  // "Beta" is both an exact name and a prefix of "Beta Work": exact wins.
  assert.equal(resolveProfile(profiles, 'beta').dir, 'Profile 1');
  assert.equal(resolveProfile(profiles, 'Beta W').dir, 'Profile 2');
});

test('profile resolution: ambiguous prefix and unknown names list the profiles', () => {
  const profiles = parseLocalState(LOCAL_STATE);
  assert.throws(() => resolveProfile(profiles, 'be'), /Ambiguous profile "be": matches Beta \(Profile 1\), Beta Work \(Profile 2, beta@example\.com\)\. Use the directory name or account email/);
  assert.equal(resolveProfile(profiles, 'BETA@example.com').dir, 'Profile 2');
  assert.throws(() => resolveProfile(profiles, 'gamma'), /Unknown profile "gamma"\. Profiles: Alpha \(Default\), Beta \(Profile 1\)/);
  assert.throws(() => resolveProfile(profiles, ''), /No profile given/);
});

test('process command parsing keeps paths with spaces', () => {
  assert.deepEqual(
    parseProcessCommand('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9339 --user-data-dir=/tmp/my profiles/ud --no-first-run about:blank'),
    { exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', userDataDir: '/tmp/my profiles/ud' },
  );
  assert.deepEqual(parseProcessCommand('/Applications/Dia.app/Contents/MacOS/Dia'), { exe: '/Applications/Dia.app/Contents/MacOS/Dia', userDataDir: null });
});

test('context mapping: cached probes, anonymous contexts, single-profile shortcut', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-ud-'));
  try {
    const profiles = parseLocalState(LOCAL_STATE);
    const cache = { CTX_A: path.join(ud, 'Default'), CTX_B: path.join(ud, 'Profile 1'), CTX_ELSEWHERE: '/other/ud/Profile 2' };
    const map = mapContexts({ contexts: ['CTX_A', 'CTX_B', 'CTX_NEW', 'CTX_ANON', 'CTX_ELSEWHERE'], cache, profiles, userDataDir: ud, anonymous: ['CTX_ANON'] });
    assert.deepEqual([...map], [['CTX_A', 'Default'], ['CTX_B', 'Profile 1'], ['CTX_NEW', null], ['CTX_ELSEWHERE', null]]);
    // One profile: nothing to tell apart, so no probe is needed.
    const one = mapContexts({ contexts: ['X', 'Y'], cache: {}, profiles: [profiles[0]], userDataDir: ud });
    assert.deepEqual([...one], [['X', 'Default'], ['Y', 'Default']]);
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('launch command forwards to the same instance via its own user-data-dir', () => {
  const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.deepEqual(launchCommand({ exe, userDataDir: '/tmp/ud' }, 'Profile 2', 'https://example.com/', 'darwin'),
    ['/usr/bin/open', ['-na', '/Applications/Google Chrome.app', '--args', '--user-data-dir=/tmp/ud', '--profile-directory=Profile 2', 'https://example.com/']]);
  assert.deepEqual(launchCommand({ exe: '/usr/bin/google-chrome', userDataDir: null }, 'Default', 'about:blank', 'linux'),
    ['/usr/bin/google-chrome', ['--profile-directory=Default', 'about:blank']]);
});

test('labelTabs maps tabs to profile names from cached probes without opening tabs', async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-ud-'));
  const cachePrefix = path.join(ud, 'ctx');
  const previous = process.env.BROWSERCTRL_PROFILE_CONTEXTS;
  process.env.BROWSERCTRL_PROFILE_CONTEXTS = cachePrefix;
  try {
    fs.writeFileSync(path.join(ud, 'Local State'), JSON.stringify(LOCAL_STATE));
    fs.writeFileSync(`${cachePrefix}-65431.json`, JSON.stringify({ CA: path.join(ud, 'Default'), CB: path.join(ud, 'Profile 2'), GONE: path.join(ud, 'Profile 1') }));
    const targetInfos = [
      { targetId: 'T1', type: 'page', url: 'https://a.test/', browserContextId: 'CA' },
      { targetId: 'T2', type: 'page', url: 'https://b.test/', browserContextId: 'CB' },
      { targetId: 'T3', type: 'page', url: 'https://c.test/', browserContextId: 'ANON' },
    ];
    const calls = [];
    const conn = {
      port: 65431,
      async browser(method) {
        calls.push(method);
        if (method === 'Target.getTargets') return { targetInfos };
        if (method === 'Target.getBrowserContexts') return { browserContextIds: ['ANON'], defaultBrowserContextId: 'CA' };
        throw new Error(`unexpected ${method}`);
      },
      async send() { throw new Error('no tab should be touched'); },
    };
    const rows = await labelTabs(conn, targetInfos.map(t => ({ targetId: t.targetId, browserContextId: t.browserContextId })));
    assert.deepEqual(rows.map(r => [r.targetId, r.profile, r.profileDir]), [['T1', 'Alpha', 'Default'], ['T2', 'Beta Work', 'Profile 2'], ['T3', null, null]]);
    assert.deepEqual(calls, ['Target.getTargets', 'Target.getBrowserContexts']);
    // The closed profile's context is pruned from the cache.
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(`${cachePrefix}-65431.json`, 'utf8'))), ['CA', 'CB']);
  } finally {
    if (previous === undefined) delete process.env.BROWSERCTRL_PROFILE_CONTEXTS;
    else process.env.BROWSERCTRL_PROFILE_CONTEXTS = previous;
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

import { parseWindowsProcess, browserKeyFor } from '../lib/profiles.mjs';

test('parses the PowerShell process row, quoted or not', () => {
  const row = c => JSON.stringify({ ProcessId: 4242, ExecutablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', CommandLine: c });
  const a = parseWindowsProcess(row('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 "--user-data-dir=C:\\Users\\a b\\prof" about:blank'));
  assert.equal(a.pid, 4242);
  assert.equal(a.userDataDir, 'C:\\Users\\a b\\prof');
  assert.equal(parseWindowsProcess(row('chrome.exe --user-data-dir=C:\\prof --x')).userDataDir, 'C:\\prof');
  assert.equal(parseWindowsProcess(row('chrome.exe --user-data-dir="C:\\my prof"')).userDataDir, 'C:\\my prof');
  assert.equal(parseWindowsProcess(row('chrome.exe')).userDataDir, null);
  assert.equal(parseWindowsProcess('[' + row('chrome.exe') + ']').pid, 4242);
  assert.equal(parseWindowsProcess(''), null);
  assert.equal(browserKeyFor('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 9222), 'edge');
  assert.equal(browserKeyFor('C:\\x\\unknown.exe', 9225), 'edge');
});
