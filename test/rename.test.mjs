import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('public metadata, package and CLI use browserctrl',()=>{
  assert.match(fs.readFileSync(path.join(root,'SKILL.md'),'utf8'),/^name: browserctrl$/m);
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  assert.equal(pkg.name,'browserctrl');
  assert.equal(pkg.bin.browserctrl,'bin/browserctrl.mjs');
  assert.equal(pkg.bin.cdp,'bin/cdp.mjs');
});
test('canonical and compatibility entry points return identical command help',()=>{
  const entries=['bin/browserctrl.mjs','bin/cdp.mjs','scripts/browserctrl.mjs','scripts/cdp.mjs'];
  const siblingLegacyEntry = path.join(root, '../chrome-cdp/scripts/cdp.mjs');
  if (fs.existsSync(path.join(root, '../chrome-cdp')) && fs.existsSync(siblingLegacyEntry)) {
    entries.push('../chrome-cdp/scripts/cdp.mjs');
  }
  const outputs=entries.map(entry=>execFileSync(process.execPath,[path.join(root,entry),'help'],{encoding:'utf8'}));
  assert.match(outputs[0],/^browserctrl —/);
  assert.ok(outputs.every(output=>output===outputs[0]));
});
test('legacy runtime path is not discoverable as a duplicate skill when present', {skip: !fs.existsSync(path.join(root, '../chrome-cdp'))}, ()=>{
  assert.equal(fs.existsSync(path.join(root,'../chrome-cdp/SKILL.md')),false);
  assert.ok(fs.existsSync(path.join(root,'../chrome-cdp/mcp/server.mjs')));
});
