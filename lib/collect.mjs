// What `do --repeat … --collect text|items|rows` keeps from each page it visits.
//
// Without a sink (no --out) the pages go into the report, bounded as before: text 6000
// characters a page and 20000 in all, items 200 a page, rows 500 in all. With a sink (--out
// FILE or -) each page is handed over as soon as it is read, as one JSON record
// ({page, url, ...}), with no total cap; only a per-page safety cap (--page-cap, PAGE_CAP below).
// Items and rows already seen on an earlier page are dropped and counted (dedupe: false keeps them).
import * as ops from './ops.mjs';
import { itemsExpression, mainGroup } from './items.mjs';
import { deepTextExpression } from './refs.mjs';
import { page } from './page/index.mjs';

export const COLLECT_MODES = ['text', 'items', 'rows'];
// Per page, when streaming: characters of text, items, table rows.
export const PAGE_CAP = { text: 1000000, items: 5000, rows: 5000 };
const REPORT_CAP = { textPage: 6000, text: 20000, items: 200, rows: 500 };

// The page's identity for "did the click change anything": its address and all its text.
export const PAGE_SIGNATURE = `(() => { const t = document.body ? document.body.innerText : ''; let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return location.href + '|' + t.length + '|' + h; })()`;

export function collector(mode, { conn, tab, sink = null, pageCap, dedupe = true } = {}) {
  if (!COLLECT_MODES.includes(mode)) throw new Error(`--collect must be one of: ${COLLECT_MODES.join(', ')}`);
  const cap = Number(pageCap) > 0 ? Number(pageCap) : sink || mode !== 'items' ? PAGE_CAP[mode] : REPORT_CAP.items;
  const seen = new Set();
  const acc = { pages: 0, records: 0, duplicates: 0, chars: 0, truncatedPages: 0, groups: [], texts: [], rows: [], columns: null };
  const fresh = (key) => {
    if (!dedupe) return true;
    if (seen.has(key)) { acc.duplicates++; return false; }
    seen.add(key);
    return true;
  };

  async function readPage(view, pageNo) {
    acc.pages = pageNo;
    const url = view?.url;
    if (mode === 'text') {
      const full = sink ? String(await ops.evaluate(conn, tab, deepTextExpression(), { retry: true }) || '') : String(view?.view || '');
      const limit = sink ? cap : REPORT_CAP.textPage;
      const text = full.slice(0, limit);
      if (full.length > limit) acc.truncatedPages++;
      acc.chars += text.length;
      acc.records++;
      if (sink) return sink({ page: pageNo, url, chars: full.length, text, ...(full.length > limit ? { truncated: true } : {}) });
      acc.texts.push(`--- page ${pageNo}: ${url}\n${text}`);
      return;
    }
    if (mode === 'items') {
      const r = await ops.evaluate(conn, tab, itemsExpression({ all: true, maxItems: cap, maxGroups: 12 }));
      const g = mainGroup(r);
      const items = [];
      for (const it of g?.items || []) if (fresh(`${(it.link || '').split('?')[0]}|${it.text}`)) items.push({ ...it, page: pageNo });
      acc.records += items.length;
      if (sink) return sink({ page: pageNo, url, ...(g ? { region: g.region, heading: g.heading } : {}), items, duplicates: (g?.items.length || 0) - items.length });
      if (!g) return;
      let into = acc.groups[0];
      if (!into) acc.groups.push(into = { id: 'g1', region: g.region, heading: g.heading, label: g.label, items: [] });
      into.items.push(...items);
      return;
    }
    const t = await ops.evaluate(conn, tab, page('table-rows', { max: cap }));
    if (t.truncated) acc.truncatedPages++;
    acc.columns ||= t.columns.length ? t.columns : null;
    const rows = t.rows.filter(row => fresh(JSON.stringify(Object.values(row))));
    acc.records += rows.length;
    if (sink) return sink({ page: pageNo, url, columns: t.columns, rows, duplicates: t.rows.length - rows.length, ...(t.truncated ? { truncated: true, total: t.total } : {}) });
    for (const row of rows) acc.rows.push({ ...row, _page: pageNo });
  }

  // What goes into the report once the loop ends.
  function summary(out) {
    if (sink) return { pages: acc.pages, mode, records: acc.records, duplicates: acc.duplicates, out, ...(mode === 'text' ? { chars: acc.chars } : {}), ...(acc.truncatedPages ? { truncated_pages: acc.truncatedPages, page_cap: cap } : {}) };
    if (mode === 'items') return { pages: acc.pages, duplicates: acc.duplicates, groups: acc.groups.map(g => ({ ...g, count: g.items.length })) };
    if (mode === 'text') {
      const all = acc.texts.join('\n\n');
      return { pages: acc.pages, text: all.slice(0, REPORT_CAP.text), ...(all.length > REPORT_CAP.text || acc.truncatedPages ? { truncated: true } : {}) };
    }
    return { pages: acc.pages, duplicates: acc.duplicates, columns: acc.columns || [], rows: acc.rows.slice(0, REPORT_CAP.rows), count: acc.rows.length, ...(acc.rows.length > REPORT_CAP.rows ? { truncated: true } : {}) };
  }

  return { readPage, summary, get records() { return acc.records; } };
}
