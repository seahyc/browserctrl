// npm run test:quick: the test files that need no browser, several at once. About a minute,
// for the edit-test loop; npm test (every file) before merging.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROWSER = /startHeadlessBrowser|chromeBinary|startBrowser|launchSeparate|bidi-browser/;
const files = fs.readdirSync(HERE).filter(f => f.endsWith('.test.mjs'))
  .filter(f => !BROWSER.test(fs.readFileSync(path.join(HERE, f), 'utf8')))
  .map(f => path.join('test', f));
console.log(`# ${files.length} test files that need no browser`);
const r = spawnSync(process.execPath, ['--import', './test/helpers.mjs', '--test', '--test-concurrency=8', '--test-timeout=120000', ...files],
  { cwd: path.join(HERE, '..'), stdio: 'inherit' });
process.exit(r.status ?? 1);
