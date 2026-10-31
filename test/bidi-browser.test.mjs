// A real Firefox-family browser over WebDriver BiDi, through the CLI: launch, open, read,
// fill, click, wait, select, eval, shot, stop. Runs only when CAMOUFOX_BIN or FIREFOX_BIN
// names a browser program; skipped otherwise.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'browserctrl.mjs');
// Run the CLI without blocking this process: the fixture server lives here and must answer.
function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
  });
}

const browsers = [['camoufox', process.env.CAMOUFOX_BIN], ['firefox', process.env.FIREFOX_BIN]].filter(([, bin]) => bin && fs.existsSync(bin));

for (const [key, bin] of browsers.length ? browsers : [['firefox', null]]) {
  test(`${key} over WebDriver BiDi: open, read, fill, click, wait, select, eval, shot`, { timeout: 180000 }, async t => {
    if (!bin) return t.skip('set CAMOUFOX_BIN or FIREFOX_BIN to run against a real browser');
    const port = 9500 + Math.floor(Math.random() * 400);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), `bc-${key}-`));
    const env = { ...process.env, [`BROWSERCTRL_${key.toUpperCase()}_BIN`]: bin };
    const cli = (...args) => runCli([...args, '--browser', key, '--port', String(port)], env);
    const fixture = await startFixtureServer();
    try {
      const launched = await runCli(['launch', key, '--headless', '--port', String(port), '--user-data-dir', profile], env);
      assert.equal(launched.code, 0, launched.err);
      assert.match(launched.out, /"ready": true/);

      const opened = await cli('open', fixture.url, '--id');
      assert.equal(opened.code, 0, opened.err);
      const tab = opened.out;
      const read = await cli('read', tab);
      assert.equal(read.code, 0, read.err);
      const ref = (role, name) => new RegExp(`(ref_\\d+)\\s+${role}\\s+${name}`).exec(read.out)?.[1];
      const go = ref('button', 'Run it');
      const name = ref('textbox', 'Your name');
      const pick = ref('combobox', 'Alpha');
      assert.ok(go && name && pick, read.out);

      assert.equal((await cli('fill', tab, name, 'Ada Lovelace')).code, 0);
      assert.equal((await cli('click', tab, go)).code, 0);
      const waited = await cli('wait', tab, '--text', 'Appeared after the click', '--timeout', '10000');
      assert.equal(waited.code, 0, waited.out + waited.err);
      assert.equal((await cli('select', tab, pick, 'Beta')).code, 0);
      const values = await cli('eval', '.', '[document.getElementById("name").value, document.getElementById("pick").value]');
      assert.deepEqual(JSON.parse(values.out), ['Ada Lovelace', 'b']);
      assert.equal((await cli('wait', tab, '--text', 'never on this page', '--timeout', '500')).code, 1);

      const file = path.join(profile, 'shot.png');
      const shot = await cli('shot', tab, file);
      assert.equal(shot.code, 0, shot.err);
      assert.equal(fs.readFileSync(file).subarray(1, 4).toString(), 'PNG');
      assert.match((await cli('tabs')).out, new RegExp(`^${tab} `, 'm'));
      assert.equal((await cli('close', tab)).code, 0);
    } finally {
      const stopped = await runCli(['launch', key, '--stop', '--user-data-dir', profile, '--port', String(port)], env);
      assert.match(stopped.out, /"stopped": true/);
      await fixture.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
