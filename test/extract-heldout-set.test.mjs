import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const runnerUrl = new URL('../bench/extract-eval/run.mjs', import.meta.url);
const source = fs.readFileSync(runnerUrl, 'utf8');
const readCases = name => JSON.parse(fs.readFileSync(new URL(`../bench/extract-eval/${name}.json`, import.meta.url), 'utf8'));
const dev = readCases('cases');
const heldout = readCases('heldout');

// Exercise the runner's selection block without importing its browser modules.
function select(args) {
  const start = source.indexOf('const setName =');
  const end = source.indexOf('const browserName =', start);
  assert.ok(start >= 0 && end > start, 'runner must declare its case selection before browser setup');
  const reads = [];
  const context = {
    process: { argv: ['node', 'run.mjs', ...args] },
    URL,
    fs: { readFileSync(url) { reads.push(url.href); return fs.readFileSync(url); } },
  };
  const script = source.slice(start, end).replaceAll('import.meta.url', JSON.stringify(runnerUrl.href));
  const selected = vm.runInNewContext(`${script}\nJSON.stringify(cases)`, context);
  return { cases: JSON.parse(selected), reads };
}

for (const [args, expected, files] of [
  [[], dev, ['cases']],
  [['--set', 'dev'], dev, ['cases']],
  [['--set', 'heldout'], heldout, ['heldout']],
  [['--set', 'all'], [...dev, ...heldout], ['cases', 'heldout']],
]) {
  test(`runner selects ${args.join(' ') || 'dev by default'}`, () => {
    const selected = select(args);
    assert.deepEqual(selected.cases, expected);
    assert.deepEqual(selected.reads, files.map(name => new URL(`../bench/extract-eval/${name}.json`, import.meta.url).href));
  });
}

test('invalid or missing --set fails before reading case files', () => {
  for (const args of [['--set', 'unknown'], ['--set']]) {
    assert.throws(() => select(args), /Expected --set.*dev.*all|Expected --set.*heldout.*dev.*all/);
  }
});

test('invalid --set exits before browser initialization', () => {
  const validation = source.indexOf("if (!['dev', 'heldout', 'all'].includes(setName))");
  assert.ok(validation >= 0, 'runner must validate the requested set');
  for (const marker of ['createDiaAdapter(browserName', 'fs.mkdtempSync(', 'startHeadlessBrowser(port)']) {
    assert.ok(validation < source.indexOf(marker), `set validation must precede ${marker}`);
  }
  const result = spawnSync(process.execPath, [runnerUrl.pathname, '--set', 'unknown'], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, EXTRACT_EVAL_BROWSER: 'headless' },
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected --set.*(?:dev|heldout).*all/);
  assert.doesNotMatch(result.stdout, /Browser:/);
});

test('heldout contains 24 unique cases with no development IDs or URLs', () => {
  assert.equal(heldout.length, 24);
  assert.equal(new Set(heldout.map(c => c.id)).size, 24);
  const devIds = new Set(dev.map(c => c.id));
  const devUrls = new Set(dev.map(c => new URL(c.url).href));
  for (const c of heldout) {
    assert.ok(!devIds.has(c.id), `${c.id} reuses a development ID`);
    assert.ok(!devUrls.has(new URL(c.url).href), `${c.id} reuses a development URL`);
    assert.match(c.step, /^extract ".+"(?: as (?:number|date))? as \$\w+$/);
    assert.ok(c.expect === 'stop' || (c.expect && typeof c.expect === 'object'), `${c.id} needs an oracle`);
  }
});

test('heldout preserves each extraction family and three absent cases', () => {
  const counts = Object.fromEntries(['stars', 'forks', 'date', 'price', 'release', 'license', 'absent'].map(family => [family, heldout.filter(c => c.family === family).length]));
  assert.deepEqual(counts, { stars: 4, forks: 4, date: 6, price: 3, release: 2, license: 2, absent: 3 });
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), heldout.length);
  assert.deepEqual(heldout.filter(c => c.expect === 'stop').map(c => c.id).sort(), ['absent-httpbin', 'absent-iana', 'absent-rfc']);
  for (const c of heldout) assert.equal(c.expect === 'stop', c.family === 'absent', c.id);
});
