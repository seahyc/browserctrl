// Open several links at once in background tabs, let each render, and return what the
// caller is looking for on each: matching lines (--grep), the page's items, or its main
// text. One call replaces "open, read, go back" per item when a task drills into a list.
import * as ops from './ops.mjs';
import * as captcha from './captcha.mjs';
import * as cooldown from './cooldown.mjs';
import { settle } from './steps.mjs';
import { itemsExpression, formatItems } from './items.mjs';

// The page's text in reading order, one line per block, skipping page chrome when the
// page marks its main content.
const PAGE_LINES = `(() => {
  const root = document.querySelector('main,[role=main],article') || document.body;
  const raw = (root.innerText || '').split(/\\n+/).map(s => s.replace(/\\s+/g, ' ').trim()).filter(Boolean);
  return { title: document.title, url: location.href, lines: raw };
})()`;

// Lines matching the pattern with `context` lines on each side: a label and its value
// often sit on neighbouring lines ("Request to merge" / branch / "into").
export function grepLines(lines, pattern, { context = 1, max = 40 } = {}) {
  const re = new RegExp(pattern, 'i');
  const keep = new Set();
  lines.forEach((l, i) => { if (re.test(l)) for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep.add(k); });
  return [...keep].sort((a, b) => a - b).slice(0, max).map(i => lines[i].slice(0, 300));
}

export async function visit(conn, urls, { grep, then = 'text', parallel = 4, maxText = 1500, timeoutMs = 20000, force = false, context = 1 } = {}) {
  for (const u of urls) cooldown.guard(u, { force, action: 'open' });
  const results = new Array(urls.length);
  let next = 0;
  async function one(i) {
    const url = urls[i], t0 = Date.now();
    let id = null;
    try {
      ({ targetId: id } = await ops.newTab(conn, url));
      await ops.wake(conn, id).catch(() => {});
      await ops.waitForReady(conn, id, { timeoutMs }).catch(() => {});
      await settle(conn, id, { maxMs: 5000 });
      const found = await captcha.observe(conn, id);
      if (found) { results[i] = { url, challenge: found.kind, ms: Date.now() - t0 }; return; }
      const r = { url };
      if (then === 'items') {
        const it = await ops.evaluate(conn, id, itemsExpression({ maxGroups: 4, maxItems: 20 }));
        r.title = it.title; r.final_url = it.url;
        r.items = formatItems(it).split('\n').slice(3).join('\n').trim();
      } else {
        const p = await ops.evaluate(conn, id, PAGE_LINES);
        r.title = p.title; r.final_url = p.url;
        if (grep) r.lines = grepLines(p.lines, grep, { context });
        else r.text = p.lines.join('\n').slice(0, maxText);
      }
      r.ms = Date.now() - t0;
      results[i] = r;
    } catch (e) {
      results[i] = { url, error: e.message, ms: Date.now() - t0 };
    } finally {
      if (id) await ops.closeTab(conn, id).catch(() => {});
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(parallel, urls.length)) }, async () => {
    while (next < urls.length) await one(next++);
  });
  await Promise.all(workers);
  return results;
}

export function formatVisits(results) {
  return results.map((r, i) => {
    const head = `[${i + 1}] ${r.title ? `${r.title}  ` : ''}${r.final_url || r.url}  (${(r.ms / 1000).toFixed(1)} s)`;
    if (r.error) return `${head}\n  error: ${r.error}`;
    if (r.challenge) return `${head}\n  blocked by a ${r.challenge} challenge; the site is cooling down`;
    const body = r.lines ? (r.lines.length ? r.lines.map(l => `  ${l}`).join('\n') : '  (no line matched)') : (r.items ?? r.text ?? '').split('\n').map(l => `  ${l}`).join('\n');
    return `${head}\n${body}`;
  }).join('\n\n');
}
