// What browserctrl keeps on disk without being asked: nothing. Two logs can be switched on:
// - capture: the fetch/XHR traffic of attached tabs (bodies, headers, tokens), which
//   `recipe endpoints` and websocket recipes read to build recipes from a site's own API;
// - trace: a line per `do` step and run, which `browserctrl trace <tab>` reads back.
// Each is on when its environment variable says so (BROWSERCTRL_CAPTURE=1,
// BROWSERCTRL_TRACE=1), or after `browserctrl capture on` / `browserctrl trace on`, which
// write ~/.local/share/browserctrl/recording.json. "=0" in the environment always wins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const file = () => process.env.BROWSERCTRL_RECORDING || path.join(os.homedir(), '.local/share/browserctrl/recording.json');
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
  const env = envSays(process.env[kind === 'capture' ? 'BROWSERCTRL_CAPTURE' : 'BROWSERCTRL_TRACE']);
  if (env !== null) return env;
  return settings()[kind] === true;
}

export function set(kind, on) {
  const value = { ...settings(), [kind]: Boolean(on) };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(value, null, 1) + '\n');
  cache = { at: Date.now(), value };
  return value;
}
