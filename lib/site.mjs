// What browserctrl knows about a site, in one lookup: recipes first (the site's own API
// calls, faster than any UI), then flow notes (facts about how its UI works). Both stay
// separate artifacts in separate stores; this only finds and shows them together, for
// `browserctrl site`, MCP browser_site, and the hint block on open, nav, read and do.
import { findRecipes, listRecipes, loadRecipe } from './recipes.mjs';
import * as notes from './notes.mjs';

const RECIPES_IN_HINT = 3;

const isUrl = (s) => /^https?:\/\//.test(String(s || ''));

// Recipes for a page, or for every page of a site given a bare host.
export function recipesFor(siteOrUrl, rows) {
  let all;
  try { all = rows ?? listRecipes(); } catch { return []; }
  const ok = all.filter(r => !r.error);
  if (isUrl(siteOrUrl)) return findRecipes(siteOrUrl, ok);
  const site = notes.siteFrom(siteOrUrl);
  const byHost = findRecipes(`https://${siteOrUrl}/`, ok);
  const bySite = ok.filter(r => r.name.split('/')[0] === siteOrUrl || notes.siteFrom(r.name.split('/')[0]) === site);
  return [...new Map([...byHost, ...bySite].map(r => [r.name, r])).values()];
}

// How to run one: its parameters with their defaults, from the recipe file.
export function runUsage(name) {
  let params = {};
  try { params = loadRecipe(name).params || {}; } catch {}
  const args = Object.entries(params).map(([k, v]) => `${k}=${v === '' || v == null ? '…' : typeof v === 'object' ? (v.default ?? '…') : v}`);
  return `browserctrl recipe run ${name}${args.length ? ` ${args.join(' ')}` : ''}`;
}

export function lookup(siteOrUrl, { rows } = {}) {
  const site = notes.siteFrom(siteOrUrl);
  const recipes = recipesFor(siteOrUrl, rows).map(r => ({
    name: r.name, kind: r.kind, description: r.description, tab: r.tab, source: r.source, run: runUsage(r.name),
  }));
  const hidden = !notes.hinting();
  const facts = hidden ? [] : notes.show(siteOrUrl).facts;
  return {
    site, ...(isUrl(siteOrUrl) ? { url: siteOrUrl } : {}), recipes,
    notes: facts.map(({ id, kind, text, path, recipe, count, fails, last, verified, author }) =>
      ({ id, kind, text, ...(path ? { path } : {}), ...(recipe ? { recipe } : {}), count, fails, last, author: author || 'rule', ...(verified === false ? { verified } : {}) })),
    ...(hidden ? { notes_hidden: 'BROWSERCTRL_NOTES is quiet or off' } : {}),
    candidates: facts.filter(f => f.kind === 'api').length,
  };
}

export function format(info) {
  const out = [`${info.site}${info.url ? `  (${info.url})` : ''}`];
  if (info.recipes.length) {
    out.push(`\nRecipes (the site's own API, faster than the UI):`);
    for (const r of info.recipes) {
      out.push(`  ${r.name}  ${r.kind}${r.tab && r.tab !== 'owned' ? `, ${r.tab} tab` : ''}  ${r.description || ''}`.trimEnd());
      out.push(`    ${r.run}`);
    }
  } else out.push('\nRecipes: none (browserctrl recipe endpoints <host> lists the API calls seen on this site)');
  if (info.notes_hidden) out.push(`\nNotes: hidden (${info.notes_hidden})`);
  else if (info.notes.length) {
    out.push(`\nNotes (${info.notes.length}${info.url ? ', this page first' : ''}; notes confirm <id> when one held, notes drop <id> --why "…" when wrong):`);
    for (const f of info.notes) out.push(`  ${notes.line(f)}`);
    // recipe endpoints takes a host: the page's own when there is one.
    const host = info.url ? new URL(info.url).host : info.site;
    if (info.candidates) out.push(`\n${info.candidates} api note${info.candidates > 1 ? 's are recipe candidates' : ' is a recipe candidate'}: browserctrl recipe endpoints ${host}`);
  } else out.push('\nNotes: none yet. After a task here, add what would have saved time: browserctrl notes add <site> "<fact>"');
  return out.join('\n');
}

// One hint block for a page: a header with counts, recipes, then notes. [] when there is
// nothing to say.
export function hintBlock(url, { notes: withNotes = true, rows } = {}) {
  if (!isUrl(url)) return [];
  const site = notes.siteFrom(url);
  const recipes = recipesFor(url, rows);
  const lines = withNotes ? notes.hintLines(url) : [];
  if (!recipes.length && !lines.length) return [];
  const all = withNotes && notes.hinting() ? notes.total(url) : 0;
  const counts = [recipes.length ? `${recipes.length} recipe${recipes.length > 1 ? 's' : ''} (faster than the UI)` : null,
    lines.length ? `${lines.length} of ${all} notes` : null].filter(Boolean).join(', ');
  return [`${counts} for ${site} (all: browserctrl site ${site})`,
    ...recipes.slice(0, RECIPES_IN_HINT).map(r => `  recipe ${r.name}${r.description ? `: ${r.description.split(/[.(]/)[0].trim()}` : ''} → ${runUsage(r.name)}`),
    ...lines];
}
