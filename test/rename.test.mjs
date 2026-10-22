// The package, skill and commands carry one name: browserctrl.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('public metadata, package and CLI use browserctrl', () => {
  assert.match(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8'), /^name: browserctrl$/m);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.bin, { browserctrl: 'bin/browserctrl.mjs', 'browserctrl-vault': 'bin/browserctrl-vault.mjs' });
  assert.match(execFileSync(process.execPath, [path.join(root, 'bin/browserctrl.mjs'), 'help'], { encoding: 'utf8' }), /^browserctrl —/);
});
