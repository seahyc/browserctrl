// config.mjs: settings, per-OS folders, the one-time move from old folders, runtime folder safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setting, flag, number, directories, ensureRuntimeDir, migrateLegacy } from '../lib/config.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bc-config-'));

test('setting reads BROWSERCTRL_X first, then the older CDP_X, and ignores empty values', () => {
  assert.equal(setting('X', {}), undefined);
  assert.equal(setting('X', { CDP_X: 'old' }), 'old');
  assert.equal(setting('X', { CDP_X: 'old', BROWSERCTRL_X: 'new' }), 'new');
  assert.equal(setting('X', { CDP_X: 'old', BROWSERCTRL_X: '' }), 'old');
  assert.equal(setting('X', { BROWSERCTRL_X: '' }), undefined);
});

test('flag and number parse settings with a fallback', () => {
  assert.equal(flag('F', true, {}), true);
  assert.equal(flag('F', false, { BROWSERCTRL_F: '1' }), true);
  for (const off of ['0', 'false', 'OFF', 'no']) assert.equal(flag('F', true, { CDP_F: off }), false, off);
  assert.equal(number('N', 7, {}), 7);
  assert.equal(number('N', 7, { BROWSERCTRL_N: '12' }), 12);
  assert.equal(number('N', 7, { BROWSERCTRL_N: 'abc' }), 7);
});

test('folders follow each OS convention', () => {
  const mac = directories({ platform: 'darwin', env: {}, home: '/Users/a', uid: 501 });
  assert.deepEqual(mac, { data: '/Users/a/Library/Application Support/browserctrl', config: '/Users/a/Library/Application Support/browserctrl', state: '/Users/a/Library/Application Support/browserctrl/state', runtime: '/tmp/browserctrl-501' });

  const linux = directories({ platform: 'linux', env: {}, home: '/home/a', uid: 1000 });
  assert.deepEqual(linux, { data: '/home/a/.local/share/browserctrl', config: '/home/a/.config/browserctrl', state: '/home/a/.local/state/browserctrl', runtime: '/tmp/browserctrl-1000' });

  const xdg = directories({ platform: 'linux', env: { XDG_DATA_HOME: '/d', XDG_CONFIG_HOME: '/c', XDG_STATE_HOME: '/s', XDG_RUNTIME_DIR: '/run/user/1000' }, home: '/home/a', uid: 1000 });
  assert.deepEqual(xdg, { data: '/d/browserctrl', config: '/c/browserctrl', state: '/s/browserctrl', runtime: '/run/user/1000/browserctrl' });

  const win = directories({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' }, home: 'C:\\Users\\a' });
  assert.equal(win.data, 'C:\\L\\browserctrl');
  assert.equal(win.config, 'C:\\R\\browserctrl');
  assert.equal(win.state, 'C:\\L\\browserctrl\\state');
  assert.equal(win.runtime, 'C:\\L\\browserctrl\\run');
});

test('BROWSERCTRL_HOME (or CDP_HOME) puts everything under one folder', () => {
  for (const platform of ['darwin', 'linux']) {
    const d = directories({ platform, env: { BROWSERCTRL_HOME: '/h' }, home: '/Users/a', uid: 1 });
    assert.deepEqual(d, { data: '/h', config: '/h', state: '/h', runtime: '/h/run' });
  }
  assert.equal(directories({ platform: 'linux', env: { CDP_HOME: '/legacy' }, home: '/x', uid: 1 }).data, '/legacy');
});

test('runtime folder is private to its owner', { skip: process.platform === 'win32' }, () => {
  const parent = tmp();
  const dir = path.join(parent, 'run');
  assert.equal(ensureRuntimeDir(dir), dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  fs.chmodSync(dir, 0o755);
  ensureRuntimeDir(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'a loose folder is tightened');
  const target = path.join(parent, 'real');
  fs.mkdirSync(target);
  const link = path.join(parent, 'link');
  fs.symlinkSync(target, link);
  assert.throws(() => ensureRuntimeDir(link), /not a directory browserctrl can use/);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('migrateLegacy moves into empty targets and skips what already exists', () => {
  // migrateLegacy is a no-op while BROWSERCTRL_HOME is set (the test suite sets it), so unset it here.
  const keep = { BROWSERCTRL_HOME: process.env.BROWSERCTRL_HOME, CDP_HOME: process.env.CDP_HOME };
  delete process.env.BROWSERCTRL_HOME; delete process.env.CDP_HOME;
  const root = tmp();
  try {
    const from1 = path.join(root, 'old1'), to1 = path.join(root, 'new1');
    const from2 = path.join(root, 'old2'), to2 = path.join(root, 'new2');
    const missing = path.join(root, 'old-missing');
    fs.mkdirSync(from1); fs.writeFileSync(path.join(from1, 'a.json'), 'old-a'); fs.writeFileSync(path.join(from1, 'b.json'), 'old-b');
    fs.mkdirSync(from2); fs.writeFileSync(path.join(from2, 'c.json'), 'old-c');
    fs.mkdirSync(to1); fs.writeFileSync(path.join(to1, 'a.json'), 'new-a');
    const logged = [];
    migrateLegacy({ moves: [[from1, to1], [from2, to2], [missing, path.join(root, 'new3')], [to1, to1]], log: m => logged.push(m) });
    assert.equal(fs.readFileSync(path.join(to1, 'a.json'), 'utf8'), 'new-a', 'an existing file is never overwritten');
    assert.equal(fs.readFileSync(path.join(from1, 'a.json'), 'utf8'), 'old-a', 'and the old one stays where it was');
    assert.equal(fs.readFileSync(path.join(to1, 'b.json'), 'utf8'), 'old-b');
    assert.equal(fs.existsSync(path.join(from1, 'b.json')), false);
    assert.equal(fs.readFileSync(path.join(to2, 'c.json'), 'utf8'), 'old-c');
    assert.equal(fs.existsSync(path.join(root, 'new3')), false, 'no old folder, nothing made');
    assert.equal(logged.length, 2);
    // It runs once per process: a second call changes nothing.
    fs.writeFileSync(path.join(from2, 'd.json'), 'late');
    migrateLegacy({ moves: [[from2, to2]] });
    assert.equal(fs.existsSync(path.join(to2, 'd.json')), false);
  } finally {
    for (const [k, v] of Object.entries(keep)) if (v !== undefined) process.env[k] = v;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
