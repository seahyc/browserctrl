// Unit tests that need no browser: claims, discovery errors, and the doc/CLI
// parity check that v1 lacked (SKILL.md documented commands that did not exist).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
const claimsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-unit-claims-'));
process.env.CDP_CLAIMS_FILE = path.join(claimsDir, 'claims.json');
const { CLAIMS_FILE } = await import('../lib/env.mjs');
const claims = await import('../lib/claims.mjs');
after(() => fs.rmSync(claimsDir, { recursive: true, force: true }));
const { requireBrowser, resolveBrowserArg } = await import('../lib/discovery.mjs');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('claims: an agent can claim a tab and see it listed', () => {
  process.env.CDP_AGENT_ID = 'agent-a';
  claims.releaseMine();
  claims.claim(9999, 'target-1');
  const mine = claims.list(9999).filter(c => c.targetId === 'target-1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].owner, 'agent-a');
  claims.release(9999, 'target-1');
});

test('claims: a second agent is refused by name, and --steal wins', () => {
  process.env.CDP_AGENT_ID = 'agent-a';
  claims.claim(9999, 'target-2');
  process.env.CDP_AGENT_ID = 'agent-b';
  assert.throws(() => claims.claim(9999, 'target-2'), /claimed by/);
  const stolen = claims.claim(9999, 'target-2', { steal: true });
  assert.equal(stolen.owner, 'agent-b');
  claims.release(9999, 'target-2');
  delete process.env.CDP_AGENT_ID;
});

test('claims: releaseMine only drops this agent\'s claims', () => {
  process.env.CDP_AGENT_ID = 'agent-a';
  claims.claim(9999, 'target-a');
  process.env.CDP_AGENT_ID = 'agent-b';
  claims.claim(9999, 'target-b');
  assert.equal(claims.releaseMine(), 1);
  assert.ok(claims.get(9999, 'target-a'), "agent-a's claim should survive");
  process.env.CDP_AGENT_ID = 'agent-a';
  claims.releaseMine();
  delete process.env.CDP_AGENT_ID;
  try {
    fs.unlinkSync(CLAIMS_FILE);
  } catch {}
});

test('claims: a claim held by a pid owner whose process is gone counts as released', async () => {
  const { spawnSync } = await import('node:child_process');
  // A process that has already exited: its pid is free again.
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.equal(claims.ownerGone(`pid:${dead}`), true);
  assert.equal(claims.ownerGone(`pid:${process.pid}`), false);
  assert.equal(claims.ownerGone('agent-a'), false, 'only pid:N owners are checked');
  fs.writeFileSync(CLAIMS_FILE, JSON.stringify({
    '9999:gone': { owner: `pid:${dead}`, label: 'shell', ts: Date.now() },
    '9999:alive': { owner: `pid:${process.pid}`, label: 'shell', ts: Date.now() },
  }));
  assert.equal(claims.get(9999, 'gone'), null);
  assert.ok(claims.get(9999, 'alive'));
  // The next command of the same agent (new shell, new pid) is not blocked by the dead one.
  assert.doesNotThrow(() => claims.claim(9999, 'gone', { owner: 'pid:1234567', label: 'shell' }));
  assert.throws(() => claims.claim(9999, 'alive', { owner: 'someone-else' }), /claimed by/);
  fs.unlinkSync(CLAIMS_FILE);
});

test('agentId falls back to the parent pid, and BROWSERCTRL_AGENT_ID wins over CDP_AGENT_ID', async () => {
  const { agentId } = await import('../lib/env.mjs');
  const keep = Object.fromEntries(['CDP_AGENT_ID', 'BROWSERCTRL_AGENT_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID'].map(k => [k, process.env[k]]));
  for (const k of Object.keys(keep)) delete process.env[k];
  try {
    assert.equal(agentId(), `pid:${process.ppid}`);
    process.env.CODEX_THREAD_ID = 'inherited-thread';
    process.env.CODEX_SESSION_ID = 'inherited-codex-session';
    process.env.CLAUDE_CODE_SESSION_ID = 'inherited-claude-session';
    assert.equal(agentId(), `pid:${process.ppid}`, 'inherited harness IDs do not identify a CLI agent');
    process.env.CDP_AGENT_ID = 'old';
    assert.equal(agentId(), 'old');
    process.env.BROWSERCTRL_AGENT_ID = 'new';
    assert.equal(agentId(), 'new');
  } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('no implicit browser default: omitting one errors with the list', async () => {
  await assert.rejects(() => requireBrowser({}), /No browser specified/);
});

test('browser names resolve to their ports', () => {
  assert.equal(resolveBrowserArg({ browser: 'dia' }), 9223);
  assert.equal(resolveBrowserArg({ browser: 'Chrome' }), 9222);
  assert.equal(resolveBrowserArg({ port: '9333' }), 9333);
  assert.throws(() => resolveBrowserArg({ browser: 'safari' }), /Unknown browser/);
});

test('every command documented in SKILL.md and its references exists in the CLI', () => {
  // The skill is a short core plus references/*.md; commands are documented across both.
  const refs = fs.readdirSync(path.join(ROOT, 'references')).filter(f => f.endsWith('.md')).map(f => fs.readFileSync(path.join(ROOT, 'references', f), 'utf8'));
  const skill = [fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8'), ...refs].join('\n');
  const cli = fs.readFileSync(path.join(ROOT, 'bin', 'browserctrl.mjs'), 'utf8');
  const documented = new Set(
    [...skill.matchAll(/^\s*(?:\$\s*)?(?:browserctrl|cdp)\s+([a-z-]+)/gm)].map(m => m[1]).filter(c => c !== 'help'),
  );
  assert.ok(documented.size > 5, 'SKILL.md should document commands');
  const missing = [...documented].filter(c => !cli.includes(`'${c}'`) && !cli.includes(`case '${c}'`));
  assert.deepEqual(missing, [], `SKILL.md documents commands the CLI does not implement: ${missing.join(', ')}`);
});

test('CLI help documents isolated anonymous tabs', () => {
  const help = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'browserctrl.mjs'), 'help'], { encoding: 'utf8' });
  assert.match(help, /browserctrl open <url> --browser dia --anonymous/);
});

test('a stale DevToolsActivePort file does not report a dead browser as debuggable', async () => {
  // Port 9 (discard) is never a browser; nothing should ever be open here.
  const { portOpen, browserWsUrl } = await import('../lib/discovery.mjs');
  assert.equal(await portOpen(9, 200), false);
  await assert.rejects(() => browserWsUrl(9), /No browser is debuggable/);
});

test('toggle mode on another port than the usual one is found through DevToolsActivePort', async () => {
  const net = await import('node:net');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const { browserWsUrl } = await import('../lib/discovery.mjs');
  const { BROWSERS } = await import('../lib/env.mjs');
  const server = net.createServer(s => s.destroy());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port: actual } = server.address();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-activeport-'));
  const saved = BROWSERS.edge.dataDirs;
  try {
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${actual}\n/devtools/browser/abc\n`);
    BROWSERS.edge.dataDirs = [dir];
    assert.equal(await browserWsUrl(BROWSERS.edge.port), `ws://127.0.0.1:${actual}/devtools/browser/abc`);
  } finally {
    BROWSERS.edge.dataDirs = saved;
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown command names the nearest one instead of printing all of help', async () => {
  const { execFile } = await import('node:child_process');
  const run = (c) => new Promise(res => execFile(process.execPath, [fileURLToPath(new URL('../bin/browserctrl.mjs', import.meta.url)), c], (e, so, se) => res(se)));
  // screenshot, navigate and list are aliases now; other near words still get a pointer.
  assert.match(await run('snapshot'), /Unknown command "snapshot"\. Did you mean "read"\?/);
  assert.match(await run('shto'), /Did you mean "shot"\?/);
  assert.match(await run('zzqqxx'), /Unknown command "zzqqxx"\. Run browserctrl help/);
});

test('traces are on and capture is off by default, each switchable, the environment winning', async () => {
  const rec = await import('../lib/recording.mjs');
  const saved = { c: process.env.BROWSERCTRL_CAPTURE, t: process.env.BROWSERCTRL_TRACE, f: process.env.BROWSERCTRL_RECORDING };
  process.env.BROWSERCTRL_RECORDING = path.join(os.tmpdir(), `bc-recording-${process.pid}-${Date.now()}.json`);
  delete process.env.BROWSERCTRL_CAPTURE; delete process.env.BROWSERCTRL_TRACE;
  try {
    assert.equal(rec.enabled('capture'), false);
    assert.equal(rec.enabled('trace'), true);
    rec.set('trace', false);
    assert.equal(rec.enabled('trace'), false);
    rec.set('capture', true);
    assert.equal(rec.enabled('capture'), true);
    process.env.BROWSERCTRL_CAPTURE = '0';
    assert.equal(rec.enabled('capture'), false, 'the environment wins');
  } finally {
    fs.rmSync(process.env.BROWSERCTRL_RECORDING, { force: true });
    for (const [k, v] of [['BROWSERCTRL_CAPTURE', saved.c], ['BROWSERCTRL_TRACE', saved.t], ['BROWSERCTRL_RECORDING', saved.f]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('caps keep a log under its size and a folder under its total, oldest first', async () => {
  const caps = await import('../lib/caps.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-caps-'));
  try {
    const log = path.join(dir, 'a.jsonl');
    fs.writeFileSync(log, Array.from({ length: 2000 }, (_, i) => JSON.stringify({ i })).join('\n') + '\n');
    assert.equal(caps.trimLog(log, 4000), true);
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(fs.statSync(log).size <= 4000 && JSON.parse(lines.at(-1)).i === 1999 && JSON.parse(lines[0]).i > 0, 'kept the newest whole lines');
    for (const [n, t] of [['old', 1], ['mid', 2], ['new', 3]]) { fs.writeFileSync(path.join(dir, n), 'x'.repeat(1000)); fs.utimesSync(path.join(dir, n), t * 1000, t * 1000); }
    caps.prune(dir, fs.statSync(log).size + 1500, { keep: ['a.jsonl'] }); // room for the log and one more file
    assert.deepEqual(fs.readdirSync(dir).sort(), ['a.jsonl', 'new']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
