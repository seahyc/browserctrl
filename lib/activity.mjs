import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runtimePath } from './platform.mjs';
import { setting } from './config.mjs';
import { withFileLock } from './file-lock.mjs';

const navigation = new Set(['Page.navigate', 'Page.reload', 'navigate_to_url']);
const activation = new Set(['Target.activateTarget', 'Page.bringToFront', 'native-focus', 'dia-focus', 'switch_tab']);
function ownerValue(owner) {
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 256) throw new Error('Activity owner must be a nonblank string of at most 256 characters');
  return owner;
}
function validateControl(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.paused !== 'boolean') throw new Error('Invalid activity control');
  const allowed = new Set(['owner', 'paused', 'label', 'intent', 'completed', 'total']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('Unknown activity control field');
  for (const [key, limit] of [['label', 256], ['intent', 240]]) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > limit)) throw new Error(`Invalid activity ${key}`);
  }
  for (const key of ['completed', 'total']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) throw new Error(`Invalid activity ${key}`);
  }
  if (value.completed !== undefined && value.total !== undefined && value.completed > value.total) throw new Error('Activity completed must not exceed total');
}

export function createActivityMonitor(port, { file = setting('ACTIVITY_FILE') || runtimePath(`activity-${port}.json`), clock = Date.now, windowMs = 15000, threshold = 5 } = {}) {
  const observations = new Map();
  function read() {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid activity state file');
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!state || state.version !== 1 || !Array.isArray(state.agents) || state.agents.length > 256) throw new Error('Invalid activity state');
      const controls = new Map();
      for (const row of state.agents) {
        const owner = ownerValue(row.owner);
        validateControl(row);
        if (controls.has(owner)) throw new Error('Duplicate activity owner');
        controls.set(owner, row);
      }
      return controls;
    } catch (error) {
      if (error.code === 'ENOENT') return new Map();
      throw new Error(`Cannot read activity state: ${error.message}`);
    }
  }
  function write(controls) {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, agents: [...controls.values()] }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  function counts(record, now) {
    if (!record) return { navigationCount: 0, activationCount: 0 };
    record.events = record.events.filter(event => now - event.at < windowMs);
    return {
      navigationCount: record.events.filter(event => event.kind === 'navigation').length,
      activationCount: record.events.filter(event => event.kind === 'activation').length,
    };
  }
  function warnings(owner, count) {
    const result = [];
    for (const [kind, number] of [['navigation', count.navigationCount], ['activation', count.activationCount]]) {
      if (number >= threshold) result.push(`Agent ${owner}: ${number} ${kind} actions in the last ${windowMs / 1000} seconds`);
    }
    return result;
  }
  function snapshot(claimRows = []) {
    const controls = read();
    const now = clock();
    const owners = new Set([...controls.keys(), ...observations.keys(), ...claimRows.filter(row => row.port === undefined || row.port === port).map(row => row.owner)]);
    return { port, agents: [...owners].map(owner => {
      const observed = observations.get(owner);
      const control = controls.get(owner);
      const claims = claimRows.filter(row => row.owner === owner && (row.port === undefined || row.port === port));
      const count = counts(observed, now);
      return {
        owner, label: control?.label ?? observed?.label ?? claims[0]?.label ?? owner,
        intent: control?.intent ?? '', completed: control?.completed ?? null, total: control?.total ?? null,
        paused: control?.paused ?? false, lastActivityAt: observed?.lastActivityAt ?? null,
        lastMethod: observed?.lastMethod ?? null, tabIds: [...new Set(claims.map(row => row.targetId))],
        ...count, warnings: warnings(owner, count),
      };
    }) };
  }
  function control(action, options = {}) {
    if (action === 'list') return snapshot();
    if (!['describe', 'pause', 'resume'].includes(action)) throw new Error(`Unknown activity action: ${action}`);
    const owner = ownerValue(options.owner);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    withFileLock(`${file}.lock`, () => {
      const controls = read();
      if (!controls.has(owner) && controls.size >= 256) throw new Error('Activity control limit reached');
      const row = { ...(controls.get(owner) ?? { owner, paused: false }) };
      if (action === 'describe') {
        for (const key of ['label', 'intent', 'completed', 'total']) if (options[key] !== undefined) row[key] = options[key];
      } else row.paused = action === 'pause';
      validateControl(row);
      controls.set(owner, row);
      write(controls);
    });
    return snapshot();
  }
  function assertRunning(owner) {
    ownerValue(owner);
    if (read().get(owner)?.paused) {
      const error = new Error(`Browser activity paused for agent ${owner}`);
      error.code = 'AGENT_PAUSED';
      throw error;
    }
  }
  function observe({ owner, label, method }) {
    ownerValue(owner);
    const now = clock();
    if (!observations.has(owner)) {
      if (observations.size >= 128) {
        const oldest = [...observations].sort((a, b) => a[1].lastActivityAt - b[1].lastActivityAt)[0][0];
        observations.delete(oldest);
      }
      observations.set(owner, { events: [], lastWarningAt: null });
    }
    const record = observations.get(owner);
    record.label = typeof label === 'string' ? label.slice(0, 256) : owner;
    record.lastActivityAt = now;
    // Store only known protocol method names, never caller-provided page data.
    record.lastMethod = typeof method === 'string' && /^[A-Za-z_-]+(?:\.[A-Za-z_]+)?$/.test(method) && method.length <= 80 ? method : null;
    counts(record, now);
    const kind = navigation.has(method) ? 'navigation' : activation.has(method) ? 'activation' : null;
    if (kind) record.events.push({ at: now, kind });
    // Cap sampling memory independently of caller frequency.
    if (record.events.length > 1024) record.events.splice(0, record.events.length - 1024);
    const active = warnings(owner, counts(record, now));
    if (!active.length || (record.lastWarningAt !== null && now - record.lastWarningAt < windowMs)) return [];
    record.lastWarningAt = now;
    return active;
  }
  return { control, assertRunning, observe, snapshot };
}
