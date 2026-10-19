// What browserctrl keeps on disk, and whether it's on without being asked:
// - trace (on by default): a line per `do` step and run, which `browserctrl trace <tab>` reads
//   back; capped at 2 MB per tab and 50 MB in all (caps.mjs);
// - capture (off by default): the fetch/XHR traffic of attached tabs, including bodies,
//   headers and tokens, which `recipe endpoints` reads to build recipes; capped at 200 MB.
// `browserctrl trace off` / `capture on` write recording.json in the data folder;
// BROWSERCTRL_TRACE / BROWSERCTRL_CAPTURE in the environment ("1" or "0") always win.
import fs from 'node:fs';
import path from 'node:path';
import { setting, dataPath } from './config.mjs';

export const file = () => setting('RECORDING') || dataPath('recording.json');
const DEFAULTS = { trace: true, capture: false };
let cache = { at: 0, value: {} };
function settings() {
  if (Date.now() - cache.at < 2000) return cache.value;
  let value = {};
  try { value = JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch {}
  cache = { at: Date.now(), value };
  return value;
}
const envSays = (v) => (v === undefined || v === '' ? null : !/^(0|off|false|no)$/i.test(v));

export function enabled(kind) {
  const env = envSays(setting(kind === 'capture' ? 'CAPTURE' : 'TRACE'));
  if (env !== null) return env;
  const saved = settings()[kind];
  return typeof saved === 'boolean' ? saved : DEFAULTS[kind];
}

export function set(kind, on) {
  const value = { ...settings(), [kind]: Boolean(on) };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(value, null, 1) + '\n');
  cache = { at: Date.now(), value };
  return value;
}
