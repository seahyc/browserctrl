// The annotation queue: what the human marked, waiting for an agent.
//
// The daemon owns it, not the page, so annotations survive navigation, tab
// close and browser restart, and an agent that was not running at the time can
// still pick them up.
import fs from 'fs';
import path from 'path';
import { CDP_HOME } from './state.mjs';

const DIR = path.join(CDP_HOME, 'annotations');
const QUEUE = path.join(DIR, 'queue.jsonl');

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
}

export function shotPath(id) {
  return path.join(DIR, `${id}.png`);
}

export function add(annotation) {
  ensure();
  const id = `an_${Math.random().toString(36).slice(2, 6)}${Date.now().toString(36).slice(-3)}`;
  const row = { id, createdAt: new Date().toISOString(), consumed: false, ...annotation };
  fs.appendFileSync(QUEUE, `${JSON.stringify(row)}\n`);
  return row;
}

function readAll() {
  try {
    return fs
      .readFileSync(QUEUE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeAll(rows) {
  ensure();
  const tmp = `${QUEUE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  fs.renameSync(tmp, QUEUE);
}

export function update(id, patch) {
  const rows = readAll();
  const next = rows.map(r => (r.id === id ? { ...r, ...patch } : r));
  writeAll(next);
  return next.find(r => r.id === id) ?? null;
}

export function pending({ sessionId = null, url = null } = {}) {
  return readAll()
    .filter(r => !r.consumed)
    .filter(r => (url ? r.page?.url === url : true))
    .filter(r => (sessionId ? !r.for || r.for === sessionId : true));
}

// What to show as pins on a page: everything still on the record for that
// URL, read or not. An annotation disappears when the human resolves it, not
// when an agent happens to read it.
export function forPage(url) {
  return readAll().filter(r => r.page?.url === url);
}

export function remove(id) {
  const rows = readAll();
  const gone = rows.find(r => r.id === id);
  writeAll(rows.filter(r => r.id !== id));
  if (gone?.screenshot) {
    try {
      fs.rmSync(gone.screenshot, { force: true });
    } catch {}
  }
  return Boolean(gone);
}

export function count() {
  return pending().length;
}

// Reading is not consuming: an agent can peek, decide the annotations are for
// a different task, and leave them for the next one.
export function consume({ sessionId = null } = {}) {
  const rows = readAll();
  const taken = rows.filter(r => !r.consumed && (sessionId ? !r.for || r.for === sessionId : true));
  const takenIds = new Set(taken.map(r => r.id));
  writeAll(rows.map(r => (takenIds.has(r.id) ? { ...r, consumed: true } : r)));
  return taken;
}

export function clear() {
  const n = pending().length;
  writeAll([]);
  for (const f of fs.existsSync(DIR) ? fs.readdirSync(DIR) : []) {
    if (f.endsWith('.png')) fs.rmSync(path.join(DIR, f), { force: true });
  }
  return n;
}

// One line, cheap to compute, appended to every browser_* result so an agent
// that is already touching the browser cannot miss a waiting annotation. This
// is the only handoff path that needs nothing from the harness.
export function piggyback(markCount = 0) {
  const n = count();
  const bits = [];
  if (n) bits.push(`${n} pending annotation${n === 1 ? '' : 's'} (call browser_annotations)`);
  if (markCount) bits.push(`${markCount} marked tab${markCount === 1 ? '' : 's'} (call browser_marks)`);
  return bits.length ? `\n\n[${bits.join('; ')}]` : '';
}

// Render for a human or an agent reading plain text.
export function render(rows) {
  if (!rows.length) return '(no pending annotations)';
  return rows
    .map((r, i) => {
      const el = r.element || {};
      const lines = [
        `${i + 1}. ${r.note || '(no note)'}`,
        `   element: ${el.role || '?'} "${el.name || ''}"${el.testid ? ` [${el.testid}]` : ''}`,
        `   selector: ${(el.selectors || [])[0] || '?'}`,
        `   page: ${r.page?.title || ''} ${r.page?.url || ''}`,
        r.tab?.alias ? `   tab: ${r.tab.alias} (${(r.tab.targetId || '').slice(0, 8)})` : r.tab?.targetId ? `   tab: ${r.tab.targetId.slice(0, 8)}` : null,
        r.screenshot ? `   screenshot: ${r.screenshot}` : null,
        `   at: ${r.createdAt}`,
      ].filter(Boolean);
      return lines.join('\n');
    })
    .join('\n\n');
}
