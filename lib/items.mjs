// Repeated items on a page: search results, cards, inbox rows, chat messages.
// An item is one of three or more same-tag siblings of similar size; their parent is
// a group. No site rules: banners, grids and threads all have this shape, and a page
// region (nav, main, a heading) labels each group.

import { page } from './page/index.mjs';

// The page code is lib/page/items.js.
export function itemsExpression(opts = {}) {
  return page('items', opts);
}

// Fits an item's text in max characters by trimming its longest pieces first, so a long
// title gives way before a price, date or status beside it. Links are never shortened:
// they identify the item.
export function shorten(text, max) {
  if (!text || text.length <= max) return text || '';
  const parts = text.split(' · ');
  const total = () => parts.reduce((n, p) => n + p.length, 0) + 3 * (parts.length - 1);
  while (total() > max) {
    let i = 0;
    parts.forEach((p, k) => { if (p.length > parts[i].length) i = k; });
    if (parts[i].length <= 41) break;
    parts[i] = `${parts[i].slice(0, Math.max(40, parts[i].length - (total() - max) - 1))}…`;
  }
  const out = parts.join(' · ');
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

// The page's main list: the content group covering the most area, with lists in an
// aside or complementary region (sidebars, "related") only when nothing else is left.
// Item count alone picks sidebars of many small links over a list of a few big cards.
export function mainGroup(r) {
  const groups = (r.groups || []).filter(g => !g.chrome && g.items?.length);
  const side = (g) => /\b(aside|complementary)\b/i.test(g.region || '');
  const area = (g) => (g.box?.w || 0) * (g.box?.h || 0) || g.count;
  const pool = groups.filter(g => !side(g)).length ? groups.filter(g => !side(g)) : groups;
  return pool.sort((a, b) => area(b) - area(a))[0] || null;
}

// main: the largest content group in full, the others as one line each (what a
// do --then items caller usually needs). grep: keep only items whose text matches.
export function formatItems(r, { maxText = 160, full = false, main = false, grep = null } = {}) {
  const re = grep ? new RegExp(grep, 'i') : null;
  const biggest = main ? mainGroup(r) : null;
  const lines = [`${r.title}\n${r.url}\nscroll ${r.scroll.y}/${r.scroll.h}`];
  for (const g of r.groups) {
    const where = [g.region, g.heading && `"${g.heading}"`, g.label && `[${g.label}]`].filter(Boolean).join(' · ');
    lines.push(`\n${g.id}  ${where || '(no region)'}  · ${g.count} items${g.columns ? `, ${g.columns} per row` : ''}${g.below ? `, ${g.below} below the fold` : ''}${g.revealed === 'expanded' ? '  (in an expanded section)' : g.revealed === 'new' ? '  (appeared since the last items call)' : ''}`);
    if (g.chrome && !full) { lines.push(`  (page chrome: ${g.items.slice(0, 4).map(i => i.text.slice(0, 24)).join(' | ')}… — browserctrl items <tab> --group ${g.id})`); continue; }
    if (biggest && g !== biggest && g.revealed !== 'expanded') { lines.push(`  (${g.items.slice(0, 3).map(i => shorten(i.text, 30)).join(' | ')}… — browserctrl items <tab> --group ${g.id})`); continue; }
    for (const it of g.items) {
      if (re && !re.test(`${it.text} ${it.link || ''}`)) continue;
      const tags = [it.new && '*', it.align && `[${it.align}]`, it.hints && `{${it.hints.join(',')}}`].filter(Boolean).join(' ');
      lines.push(`  ${it.id.padEnd(5)} ${tags ? `${tags} ` : ''}${shorten(it.text, maxText) || '(no text)'}${it.link ? `  → ${it.link}` : ''}`);
    }
    if (g.count > g.items.length) lines.push(`  … ${g.count - g.items.length} more (--all)`);
  }
  return lines.join('\n');
}
