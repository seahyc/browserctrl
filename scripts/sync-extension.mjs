#!/usr/bin/env node
// extension/annotate.js is a copy of lib/overlay/annotate.js: Chrome loads an unpacked
// extension from its own folder, so the file has to sit there. This keeps it in step.
//   node scripts/sync-extension.mjs           copy the overlay into the extension
//   node scripts/sync-extension.mjs --check   exit 1 when they differ (tests, CI)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const source = path.join(root, 'lib', 'overlay', 'annotate.js');
export const copy = path.join(root, 'extension', 'annotate.js');

export const inSync = () => {
  try { return fs.readFileSync(source).equals(fs.readFileSync(copy)); } catch { return false; }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    if (inSync()) console.log('extension/annotate.js is in sync');
    else { console.error('extension/annotate.js is stale: run `npm run sync-extension`'); process.exit(1); }
  } else {
    fs.copyFileSync(source, copy);
    console.log('copied lib/overlay/annotate.js to extension/annotate.js');
  }
}
