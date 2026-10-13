#!/usr/bin/env node
// Opt-in live check of browser profiles: `node test/profiles-live.mjs [--port 9341] [--keep]`.
// Starts a separate, visible Chrome on a throwaway --user-data-dir under the OS
// temp dir with three seeded profiles (Alpha, Beta, Gamma), drives it only
// through the browserctrl CLI, and removes it afterwards. Visible because a
// headless Chrome runs no process singleton, so a profile window could not be
// opened into it. It never touches the user's own browser or profile.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeBinary } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf('--port') + 1] || 0) || 9341;
const KEEP = argv.includes('--keep');
const PROFILES = { Default: 'Alpha', 'Profile 1': 'Beta', 'Profile 2': 'Gamma' };
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-profiles-live-'));
const userDataDir = path.join(work, 'ud');
const env = {
  ...process.env,
  CDP_AGENT_ID: 'profiles-live',
  CDP_AGENT_LABEL: 'profiles-live',
  BROWSERCTRL_PROFILE_CONTEXTS: path.join(work, 'contexts'),
  BROWSERCTRL_EXEMPLARS: path.join(work, 'exemplars'),
  BROWSERCTRL_RECIPE_TABS: path.join(work, 'recipe-tabs.json'),
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cli(...args) {
  const quiet = args[0] === '--quiet' && args.shift();
  const shown = `browserctrl ${args.map(a => (/[\s?&'"()]/.test(a) ? `'${a.replaceAll("'", "'\\''")}'` : a)).join(' ')}`;
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(ROOT, 'bin', 'browserctrl.mjs'), ...args], { env, timeout: 90000 }, (err, stdout, stderr) => {
      const output = (stdout + stderr).trim();
      if (!quiet) console.log(`\n$ ${shown}\n${output}`);
      resolve({ ok: !err, output, json: () => JSON.parse(stdout) });
    });
  });
}

async function fixture() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>profile fixture ${new URL(req.url, 'http://x').searchParams.get('p') || ''}</title><p>fixture</p>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
    closeAllConnections: () => server.closeAllConnections(),
  };
}

function seedProfiles() {
  const info = Object.fromEntries(Object.entries(PROFILES).map(([dir, name]) => [dir, { name }]));
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'Local State'), JSON.stringify({ profile: { info_cache: info } }));
  for (const [dir, name] of Object.entries(PROFILES)) {
    fs.mkdirSync(path.join(userDataDir, dir), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, dir, 'Preferences'), JSON.stringify({ profile: { name } }));
  }
}

async function startChrome(binary) {
  const child = spawn(binary, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, '--profile-directory=Default',
    '--no-first-run', '--no-default-browser-check', '--window-size=900,640', 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return child;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`Chrome did not open port ${PORT}`);
}

const tabLine = (output, id) => output.split('\n').find(l => l.startsWith(id)) || '';

async function main() {
  const binary = chromeBinary();
  if (!binary || process.platform !== 'darwin') throw new Error('Needs macOS and a local Chrome (the profile-window path uses `open -na`).');
  if ((await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false))) throw new Error(`Port ${PORT} is already in use; pass --port N.`);
  const server = await fixture();
  let chrome;
  try {
    seedProfiles();
    chrome = await startChrome(binary);
    console.log(`Chrome ${binary} on :${PORT}, user data ${userDataDir}`);

    let r = await cli('profiles', '--port', String(PORT));
    assert.ok(r.ok);
    assert.match(r.output, /Default\s+Alpha\s+1 tab\s+\[default/);
    assert.match(r.output, /Profile 1\s+Beta\s+no window/);
    assert.match(r.output, /Profile 2\s+Gamma\s+no window/);

    // Beta has no window yet: browserctrl must open one, then find its tab.
    const beta = (r = await cli('open', `${server.origin}/?p=beta`, '--profile', 'Beta', '--port', String(PORT))).json();
    assert.equal(beta.profileDir, 'Profile 1');
    assert.equal(beta.how, 'opened profile window');
    // Only the default (last-used) profile takes Target.createTarget; any other
    // is reached through one of its own tabs. Which profile is default moves
    // with window activation, so ask before each open and check the path taken.
    const openIn = async (query, dir, p) => {
      const { profiles } = (await cli('--quiet', 'profiles', '--json', '--port', String(PORT))).json();
      const isDefault = profiles.find(x => x.dir === dir).default;
      const res = (await cli('open', `${server.origin}/?p=${p}`, '--profile', query, '--port', String(PORT))).json();
      assert.equal(res.profileDir, dir);
      assert.equal(res.how, isDefault ? 'createTarget' : 'existing window');
      return res;
    };
    const alpha = await openIn('alpha', 'Default', 'alpha');
    const beta2 = await openIn('Profile 1', 'Profile 1', 'beta2');
    const hows = new Set([beta.how, alpha.how, beta2.how]);

    r = await cli('tabs', '--port', String(PORT), '--no-focus');
    assert.match(tabLine(r.output, alpha.id), /\bAlpha\b.*p=alpha/);
    assert.match(tabLine(r.output, beta.id), /\bBeta\b.*p=beta/);
    assert.match(tabLine(r.output, beta2.id), /\bBeta\b.*p=beta2/);

    r = await cli('tabs', '--profile', 'beta', '--port', String(PORT), '--no-focus');
    const lines = r.output.split('\n');
    assert.ok(lines.every(l => /\bBeta\b/.test(l)), 'every filtered tab is Beta');
    assert.ok(lines.some(l => l.startsWith(beta.id)) && lines.some(l => l.startsWith(beta2.id)));
    assert.ok(!lines.some(l => l.startsWith(alpha.id)));

    // Isolation: storage written in Alpha is invisible to Beta on the same origin,
    // and visible to a second Alpha tab, so the write itself is not in doubt.
    r = await cli('eval', alpha.id, "document.cookie = 'who=alpha; path=/'; localStorage.setItem('who', 'alpha'); document.cookie + ' | ' + localStorage.getItem('who')", '--port', String(PORT));
    assert.match(r.output, /who=alpha \| alpha/);
    r = await cli('eval', beta.id, "JSON.stringify({ cookie: document.cookie, local: localStorage.getItem('who') })", '--port', String(PORT));
    assert.match(r.output, /\{"cookie":"","local":null\}/);
    const alpha2 = await openIn('Alpha', 'Default', 'alpha2');
    hows.add(alpha2.how);
    // Opening through a profile's own tab makes it the last-used one (observed
    // on Chrome 155), so a second tab there takes the direct path.
    hows.add((await openIn('Alpha', 'Default', 'alpha3')).how);
    r = await cli('eval', alpha2.id, "JSON.stringify({ cookie: document.cookie, local: localStorage.getItem('who') })", '--port', String(PORT));
    assert.match(r.output, /\{"cookie":"who=alpha","local":"alpha"\}/);

    r = await cli('profiles', '--port', String(PORT));
    assert.match(r.output, /Default\s+Alpha\s+4 tabs/);
    assert.match(r.output, /Profile 1\s+Beta\s+\d+ tabs?/);
    assert.match(r.output, /Profile 2\s+Gamma\s+no window/);

    r = await cli('open', server.origin, '--profile', 'Nobody', '--port', String(PORT));
    assert.ok(!r.ok);
    assert.match(r.output, /Unknown profile "Nobody"\. Profiles: Alpha \(Default\), Beta \(Profile 1\), Gamma \(Profile 2\)/);

    console.log(`\nopen paths exercised: ${[...hows].join(', ')}`);
    assert.deepEqual([...hows].sort(), ['createTarget', 'existing window', 'opened profile window']);
    console.log('\nPASS: profiles listed, tabs opened and labelled per profile, filter and storage isolation verified.');
  } finally {
    await cli('stop', '--port', String(PORT));
    if (!KEEP) {
      if (chrome) {
        const alive = () => { try { process.kill(chrome.pid, 0); return true; } catch { return false; } };
        try { process.kill(chrome.pid, 'SIGTERM'); } catch { /* already gone */ }
        for (let i = 0; i < 60 && alive(); i++) await sleep(250);
        if (alive()) process.kill(chrome.pid, 'SIGKILL');
      }
      // Extension renderers can outlive their browser for a moment.
      await new Promise(r => execFile('/usr/bin/pkill', ['-f', '--', `--user-data-dir=${userDataDir}`], r));
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      console.log(`cleaned up Chrome :${PORT} and ${work}`);
    }
    server.close();
    server.closeAllConnections();
  }
}

main().catch(e => {
  console.error(`\nFAIL: ${e.stack || e.message}`);
  process.exitCode = 1;
});
