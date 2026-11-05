// The test runner behind npm test. Three tiers:
//   core (npm test)          every file except test/tiers.json's `extended` list: the files that
//                            add the most covered lines per second (test/select.mjs), about a minute
//   full (npm run test:full) every file: before merging, and in CI
//   quick (npm run test:quick) only the files that need no browser, in seconds
// --shard=i/n runs one of n time-balanced parts of the tier (CI splits the full suite this way).
// Files run several at once, longest first (timings in test/tiers.json), so a slow file never
// starts last. Arguments after the tier are passed to node --test (a file list replaces the tier).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const args = process.argv.slice(2);
const tier = ['core', 'full', 'quick'].includes(args[0]) ? args.shift() : 'core';
let tiers = { extended: [], timings: {} };
try { tiers = { ...tiers, ...JSON.parse(fs.readFileSync(path.join(HERE, 'tiers.json'), 'utf8')) }; } catch {}

// A file that starts a browser itself or through a shared rig (test/*-rig.mjs).
const BROWSER = /startHeadlessBrowser|chromeBinary|startBrowser|launchSeparate|bidi-browser|-rig\.mjs/;
const all = fs.readdirSync(HERE).filter(f => f.endsWith('.test.mjs')).sort();
const given = args.filter(a => a.endsWith('.test.mjs'));
// --shard=i/n: this machine's share of the files, balanced by their timings (CI runs n at once).
const shardArg = args.find(a => a.startsWith('--shard='));
const flags = args.filter(a => !a.endsWith('.test.mjs') && a !== shardArg);
let files = given.length ? given.map(f => path.basename(f))
  : tier === 'full' ? all
  : tier === 'quick' ? all.filter(f => !BROWSER.test(fs.readFileSync(path.join(HERE, f), 'utf8')))
  : all.filter(f => !tiers.extended.includes(f));
// Longest first; a file with no timing yet (new) goes first too, since it may be slow.
files.sort((a, b) => (tiers.timings[b] ?? 1e9) - (tiers.timings[a] ?? 1e9));
let shardNote = '';
if (shardArg) {
  const [i, n] = shardArg.slice('--shard='.length).split('/').map(Number);
  if (!(n >= 1 && i >= 1 && i <= n)) { console.error(`--shard wants i/n with 1 <= i <= n, not ${shardArg}`); process.exit(2); }
  // Longest first, each file to the lightest shard; a file with no timing counts as a minute.
  const load = Array(n).fill(0), mine = [];
  for (const f of files) {
    const k = load.indexOf(Math.min(...load));
    load[k] += tiers.timings[f] ?? 60;
    if (k === i - 1) mine.push(f);
  }
  files = mine;
  shardNote = `, shard ${i} of ${n} (about ${Math.round(load[i - 1])} s of file time)`;
}

// Our own parallel files raise the load average, and test/load.mjs stretches every wait with it,
// so a parallel run would slow itself down. Leave out what our files add (about a node process
// and a Chrome each), so waits still stretch for other work on the machine, as it comes and goes.
const env = { ...process.env };
const cpus = os.cpus().length;
const given_c = flags.find(f => f.startsWith('--test-concurrency'));
const workers = given_c ? Number(given_c.split('=')[1]) || 1 : tier === 'quick' ? cpus : Math.min(8, cpus);
const concurrency = given_c ? [] : [`--test-concurrency=${workers}`];
env.BROWSERCTRL_TEST_OWN_LOAD ??= String(tier === 'quick' ? workers : workers * 2);
const coverage = tier === 'core' && tiers.coverage ? `, ${tiers.coverage} of the full suite's covered lines` : '';
console.log(`# ${tier}: ${files.length} of ${all.length} test files${coverage}${shardNote}, ${workers} at a time`);
// The usual report, then each file's wall time (test/file-times.mjs), unless reporters were given.
const reporters = flags.some(f => f.startsWith('--test-reporter')) ? []
  : ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=./test/file-times.mjs', '--test-reporter-destination=stdout'];
const child = spawn(process.execPath, ['--import', './test/helpers.mjs', '--test', ...concurrency, '--test-timeout=300000', ...reporters, ...flags, ...files.map(f => path.join('test', f))],
  { cwd: ROOT, stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
