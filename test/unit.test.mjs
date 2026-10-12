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

test('no implicit browser default: omitting one errors with the list', async () => {
  await assert.rejects(() => requireBrowser({}), /No browser specified/);
});

test('browser names resolve to their ports', () => {
  assert.equal(resolveBrowserArg({ browser: 'dia' }), 9223);
  assert.equal(resolveBrowserArg({ browser: 'Chrome' }), 9222);
  assert.equal(resolveBrowserArg({ port: '9333' }), 9333);
  assert.throws(() => resolveBrowserArg({ browser: 'safari' }), /Unknown browser/);
});

test('every command documented in SKILL.md exists in the CLI', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  const cli = fs.readFileSync(path.join(ROOT, 'bin', 'browserctrl.mjs'), 'utf8');
  const documented = new Set(
    [...skill.matchAll(/^\s*(?:\$\s*)?(?:browserctrl|cdp)\s+([a-z-]+)/gm)].map(m => m[1]).filter(c => c !== 'help'),
  );
  assert.ok(documented.size > 5, 'SKILL.md should document commands');
  const missing = [...documented].filter(c => !cli.includes(`'${c}'`) && !cli.includes(`case '${c}'`));
  assert.deepEqual(missing, [], `SKILL.md documents commands the CLI does not implement: ${missing.join(', ')}`);
});

test('MCP tool schemas are well formed and every tool has a handler', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'mcp', 'server.mjs'), 'utf8');
  const toolNames = [...src.matchAll(/name: '(browser_[a-z_]+)'/g)].map(m => m[1]);
  assert.ok(toolNames.length >= 10, `expected the full tool surface, got ${toolNames.length}`);
  for (const name of toolNames) {
    assert.ok(new RegExp(`${name}:\\s`).test(src), `${name} is declared but has no handler`);
  }
});

test('the MCP server starts and lists its tools over stdio', () => {
  const req = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ].join('\n') + '\n';
  const outText = execFileSync(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs')], {
    input: req,
    encoding: 'utf8',
    timeout: 20000,
  });
  const listed = outText
    .split('\n')
    .filter(Boolean)
    .map(l => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find(m => m?.id === 2);
  assert.ok(listed, 'server should answer tools/list');
  const names = listed.result.tools.map(t => t.name);
  assert.ok(names.includes('browser_read'), `browser_read missing from ${names.join(', ')}`);
  assert.ok(names.includes('browser_act'));
  const open = listed.result.tools.find(t => t.name === 'browser_open');
  assert.equal(open.inputSchema.properties.anonymous?.type, 'boolean');
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
