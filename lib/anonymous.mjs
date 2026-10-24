// Temporary browser contexts created by browserctrl.
//
// This registry is deliberately separate from CDP's browserContextId field:
// a user may have opened their own incognito window, and browserctrl must never
// dispose a context it did not create.
import fs from 'fs';
import path from 'node:path';
import { ANONYMOUS_CONTEXTS_FILE } from './env.mjs';

const keyFor = (port, targetId) => `${port}:${targetId}`;

function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(ANONYMOUS_CONTEXTS_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(contexts) {
  fs.mkdirSync(path.dirname(ANONYMOUS_CONTEXTS_FILE), {recursive:true, mode:0o700});
  const tmp = `${ANONYMOUS_CONTEXTS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(contexts, null, 2));
  fs.renameSync(tmp, ANONYMOUS_CONTEXTS_FILE);
}

export function list(port = null) {
  return Object.entries(readAll())
    .map(([key, value]) => {
      const split = key.indexOf(':');
      return { port: Number(key.slice(0, split)), targetId: key.slice(split + 1), ...value };
    })
    .filter(row => port === null || row.port === port);
}

export function get(port, targetId) {
  return readAll()[keyFor(port, targetId)] ?? null;
}

export function record(port, targetId, browserContextId) {
  const contexts = readAll();
  contexts[keyFor(port, targetId)] = { browserContextId, createdAt: Date.now() };
  writeAll(contexts);
}

export function release(port, targetId) {
  const contexts = readAll();
  delete contexts[keyFor(port, targetId)];
  writeAll(contexts);
}

// The tab's page target was replaced: its temporary context still belongs to browserctrl.
export function retarget(port, from, to) {
  const contexts = readAll();
  if (!contexts[keyFor(port, from)]) return false;
  contexts[keyFor(port, to)] = contexts[keyFor(port, from)];
  delete contexts[keyFor(port, from)];
  writeAll(contexts);
  return true;
}
