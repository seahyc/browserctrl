// Open several links at once in background tabs, let each render, and return what the
// caller is looking for on each: matching lines (--grep), the page's items, or its main
// text. One call replaces "open, read, go back" per item when a task drills into a list.
import * as ops from './ops.mjs';
import * as captcha from './captcha.mjs';
import * as cooldown from './cooldown.mjs';
import { settle, waitForContent } from './steps.mjs';
import { itemsExpression, formatItems } from './items.mjs';
import * as show from './show.mjs';
import * as prefetch from './prefetch.mjs';
import * as notes from './notes.mjs';
import { VISIT, sleep } from './timing.mjs';
import { page } from './page/index.mjs';

// Lines matching the pattern with `context` lines on each side: a label and its value
// often sit on neighbouring lines ("Request to merge" / branch / "into").
export function grepLines(lines, pattern, { context = 1, max = 40 } = {}) {
  const re = new RegExp(pattern, 'i');
  const keep = new Set();
  lines.forEach((l, i) => { if (re.test(l)) for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep.add(k); });
  const seen = new Set();
  return [...keep].sort((a, b) => a - b).map(i => lines[i].slice(0, 300)).filter(l => !seen.has(l) && seen.add(l)).slice(0, max);
}

export async function visit(conn, urls, { grep, then = 'text', parallel = 4, maxText = 1500, timeoutMs = VISIT.TIMEOUT, force = false, context = 1, show: showOn = false } = {}) {
  for (const u of urls) cooldown.guard(u, { force, action: 'open' });
  const results = new Array(urls.length);
  let next = 0;
  // Many pages of one shop opened at once look like a crawler and draw a challenge: per
  // site, at most PER_HOST tabs at a time, started at least STAGGER_MS apart.
  const PER_HOST = 3, STAGGER_MS = VISIT.STAGGER;
  const hosts = new Map();
  const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };
  async function slot(host) {
    const h = hosts.get(host) || hosts.set(host, { open: 0, last: 0, wait: [] }).get(host);
    while (h.open >= PER_HOST) await new Promise(r => h.wait.push(r));
    h.open++;
    const gap = h.last + STAGGER_MS - Date.now();
    h.last = Math.max(Date.now(), h.last + STAGGER_MS);
    if (gap > 0) await new Promise(r => setTimeout(r, gap));
    return () => { h.open--; const w = h.wait.shift(); if (w) w(); };
  }
  async function one(i) {
    const url = urls[i], t0 = Date.now();
    let id = null;
    const release = await slot(hostOf(url));
    try {
      // A challenge on an earlier page of this site starts its cool-down: open no more.
      try { cooldown.guard(url, { force, action: 'open' }); }
      catch (e) { results[i] = { url, skipped: 'the site is cooling down after a challenge on an earlier page', ms: 0 }; return; }
      // A page prefetched while the agent was deciding is already loading or loaded.
      id = prefetch.take(url);
      if (id) { try { await conn.browser('Target.getTargetInfo', { targetId: id }); } catch { id = null; } }
      if (!id) ({ targetId: id } = await ops.newTab(conn, url));
      if (showOn) await show.bringToFront(conn, id); // watch it load, not just the result
      await ops.wake(conn, id).catch(() => {});
      await ops.waitForReady(conn, id, { timeoutMs }).catch(() => {});
      await settle(conn, id, 'visit');
      await waitForContent(conn, id, { timeoutMs });
      // --show: bring each page forward as it is read, with what is being pulled from it.
      if (showOn) {
        await show.bringToFront(conn, id);
        await show.panel(conn, id, { title: `browserctrl visit  ${i + 1}/${urls.length}`, lines: [grep ? `grep /${grep}/` : then === 'items' ? 'reading items' : 'reading text', url.slice(0, 90)] }).catch(() => {});
        await sleep(VISIT.SHOW);
      }
      const found = await captcha.observe(conn, id);
      if (found) {
        // Drawn while other pages of the site were loading: worth knowing next time.
        const h = hosts.get(hostOf(url));
        if (h.open > 1) notes.record([{ site: cooldown.siteOf(url), key: 'challenge parallel', kind: 'challenge', ok: true,
          text: `opening ${h.open} pages at once drew a ${found.kind}; open its pages one at a time` }]);
        results[i] = { url, challenge: found.kind, ms: Date.now() - t0 };
        return;
      }
      const r = { url };
      if (then === 'items') {
        const it = await ops.evaluate(conn, id, itemsExpression({ maxGroups: 4, maxItems: 20 }));
        r.title = it.title; r.final_url = it.url;
        r.items = formatItems(it).split('\n').slice(3).join('\n').trim();
      } else {
        const p = await ops.evaluate(conn, id, page('page-lines'));
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
      release();
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
    // A page title usually ends with the site's name after a separator; the URL says that.
    const title = r.title ? r.title.split(/\s+[·|–—-]\s+/)[0].slice(0, 70) : '';
    const head = `[${i + 1}] ${title ? `${title}  ` : ''}${r.final_url || r.url}  (${(r.ms / 1000).toFixed(1)} s)`;
    if (r.error) return `${head}\n  error: ${r.error}`;
    if (r.skipped) return `${head}\n  skipped: ${r.skipped}`;
    if (r.challenge) return `${head}\n  blocked by a ${r.challenge} challenge; the site is cooling down`;
    const body = r.lines ? (r.lines.length ? r.lines.map(l => `  ${l}`).join('\n') : '  (no line matched)') : (r.items ?? r.text ?? '').split('\n').map(l => `  ${l}`).join('\n');
    return `${head}\n${body}`;
  }).join('\n\n');
}
