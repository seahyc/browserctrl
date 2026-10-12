import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const moduleUrl = new URL('../lib/claims.mjs', import.meta.url).href;
const envUrl = new URL('../lib/env.mjs', import.meta.url).href;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-claims-concurrency-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'claims.json');
}
function run(file, owner, body, start = Date.now()) {
  return new Promise((resolve, reject) => {
    const code = `
      const env = await import(${JSON.stringify(envUrl)});
      if (env.CLAIMS_FILE !== process.env.CDP_CLAIMS_FILE) throw new Error('Claims isolation unavailable');
      const claims = await import(${JSON.stringify(moduleUrl)});
      await new Promise(resolve => setTimeout(resolve, Math.max(0, ${start} - Date.now())));
      try { ${body}; console.log(JSON.stringify({ok: true})); }
      catch (error) { console.log(JSON.stringify({ok: false, code: error.code, message: error.message})); }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, CDP_CLAIMS_FILE: file, CDP_AGENT_ID: owner, CDP_AGENT_LABEL: owner },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', status => {
      if (status !== 0) return reject(new Error(`Child exited ${status}: ${err}`));
      try { resolve(JSON.parse(out)); } catch (error) { reject(error); }
    });
  });
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('ten simultaneous processes competing for one tab have exactly one winner', async t => {
  const file = fixture(t), start = Date.now() + 800;
  const results = await Promise.all(Array.from({length: 10}, (_, i) =>
    run(file, `agent-${i}`, "claims.claim(9223, 'same-tab')", start)));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => r.code === 'CLAIMED').length, 9);
  assert.equal(Object.keys(read(file)).length, 1);
});

test('ten simultaneous processes claiming distinct tabs preserve every claim', async t => {
  const file = fixture(t), start = Date.now() + 800;
  const results = await Promise.all(Array.from({length: 10}, (_, i) =>
    run(file, `agent-${i}`, `claims.claim(9223, 'tab-${i}')`, start)));
  assert.ok(results.every(r => r.ok), JSON.stringify(results));
  assert.equal(Object.keys(read(file)).length, 10);
});

test('owners cannot release or access another owner claim; explicit steal remains available', async t => {
  const file = fixture(t);
  assert.equal((await run(file, 'a', "claims.claim(9223, 'tab')")).ok, true);
  for (const action of ["claims.release(9223, 'tab')", "claims.assertAccess(9223, 'tab')"]) {
    assert.equal((await run(file, 'b', action)).code, 'CLAIMED');
    assert.equal(read(file)['9223:tab'].owner, 'a');
  }
  assert.equal((await run(file, 'a', "claims.assertAccess(9223, 'unclaimed')")).ok, true);
  assert.equal(Object.keys(read(file)).length, 1);
  assert.equal((await run(file, 'b', "claims.release(9223, 'tab', {steal: true})")).ok, true);
  assert.deepEqual(read(file), {});
});

test('malformed JSON and invalid records fail closed without overwriting claims', async t => {
  const file = fixture(t);
  for (const bad of ['{bad', '[]', 'null', '{"9223:tab":{"owner":"a"}}']) {
    fs.writeFileSync(file, bad);
    for (const action of ["claims.claim(9223, 'tab')", "claims.release(9223, 'tab')", 'claims.releaseMine()', "claims.assertAccess(9223, 'tab')"]) {
      assert.equal((await run(file, 'a', action)).code, 'INVALID_CLAIMS');
      assert.equal(fs.readFileSync(file, 'utf8'), bad);
    }
  }
});

test('releaseMine races with nine writers without erasing their claims', async t => {
  const file = fixture(t);
  assert.equal((await run(file, 'old-owner', "for (let i=0; i<50; i++) claims.claim(9223, 'old-' + i)")).ok, true);
  const start = Date.now() + 800;
  const results = await Promise.all([
    run(file, 'old-owner', 'for (let i=0; i<20; i++) claims.releaseMine()', start),
    ...Array.from({length: 9}, (_, i) => run(file, `agent-${i}`, `for (let j=0; j<10; j++) claims.claim(9223, 'new-${i}-' + j)`, start)),
  ]);
  assert.ok(results.every(r => r.ok), JSON.stringify(results));
  const all = read(file);
  assert.equal(Object.keys(all).length, 90);
  assert.ok(Object.values(all).every(c => c.owner !== 'old-owner'));
});
