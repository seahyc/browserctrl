#!/usr/bin/env node
// Jev benchmark harness. See bench/README.md for the protocol.
//   node bench/run.mjs start <task> <A|B> <n> [--tab ID]   prepare a run, print the agent prompt
//   node bench/run.mjs finish <run> <answer.json> --ms N --tokens N --tools N
//   node bench/run.mjs report
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runsDir = path.join(here, 'runs');
const resultsFile = path.join(here, 'results.jsonl');
const tasks = JSON.parse(fs.readFileSync(path.join(here, 'tasks.json'), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(path.join(here, 'fixtures.json'), 'utf8'));
const JEV_DIR = path.join(os.homedir(), 'Code/jev-ultrafast');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const bc = (...args) => sh('browserctrl', [...args, '--browser', 'dia']);
const bcJson = (...args) => JSON.parse(bc(...args));
const recipe = (...args) => { try { return JSON.parse(bc('recipe', 'run', ...args)); } catch { return JSON.parse(bc('recipe', 'run', ...args)); } };
const gitlab = (p) => JSON.parse(sh('glab', ['api', p], { env: { ...process.env, GITLAB_HOST: 'gitlab.glints.com' } }));
const gh = (...args) => JSON.parse(sh('gh', args));

const fill = (s) => s.replace(/FIXTURE:(\w+)/g, (_, k) => fixtures[k]);
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const tabIds = () => bcJson('tabs', '--json').map((t) => (t.targetId || t.id).slice(0, 8));

async function pageText(url, waitMs = 6000) {
  const { id } = bcJson('open', url);
  try {
    await sleep(1500);
    try { bc('wake', id); } catch {} // Shopee leaves hidden tabs as skeletons
    await sleep(waitMs);
    return bc('text', id, '--max-text', '60000');
  } finally {
    try { bc('close', id); } catch {}
  }
}

// Hand over a tab only once it has rendered: Shopee's purchase page stays blank for seconds.
async function readyTab(url) {
  const { id } = bcJson('open', url);
  for (let i = 0; i < 20; i++) {
    if (i === 1) try { bc('wake', id); } catch {}
    await sleep(1000);
    try { if (Number(bc('eval', id, 'document.readyState === "complete" ? document.body.innerText.length : 0')) > 300) break; } catch {}
  }
  await sleep(1000);
  return id;
}

// GitLab truth from the web UI when glab cannot authenticate: MR pages opened directly
// by IID (not the agent's path), read by stable selectors.
const GL = 'https://gitlab.glints.com/glints/glints-dashboard/-/merge_requests';
async function glListIids(query) {
  const id = await readyTab(`${GL}?${query}`);
  try { return JSON.parse(bc('eval', id, `JSON.stringify([...new Set([...document.querySelectorAll('a[href*="/-/merge_requests/"]')].map(a => (a.getAttribute('href').match(/merge_requests\\/(\\d+)$/) || [])[1]).filter(Boolean).map(Number))])`)); }
  finally { try { bc('close', id); } catch {} }
}
async function glMRs(iids) {
  const id = await readyTab(`${GL}/${iids[0]}`);
  const out = new Map();
  try {
    for (const iid of iids) {
      bc('nav', id, `${GL}/${iid}`);
      for (let i = 0; i < 20; i++) { await sleep(500); try { if (bc('eval', id, `!!document.querySelector('.ref-container')`).trim() === 'true') break; } catch {} }
      const r = JSON.parse(bc('eval', id, `JSON.stringify({ author: document.querySelector('a.author-link')?.dataset.username, refs: [...document.querySelectorAll('.ref-container')].map(e => e.textContent.trim()), commits: Number(([...document.querySelectorAll('a, li')].map(e => e.textContent.replace(/\\s+/g, ' ').trim()).find(t => /^Commits \\d+$/.test(t)) || '').replace(/\\D/g, '')) })`));
      out.set(iid, { iid, author: { username: r.author }, source_branch: r.refs[0], target_branch: r.refs[1], commits: r.commits });
    }
  } finally { try { bc('close', id); } catch {} }
  return out;
}
// Visit pages for truth, re-reading any that came back nearly empty (a slow app shell).
function visitTexts(urls, extra = []) {
  const pages = bcJson('visit', ...urls, '--max-text', '60000', ...extra, '--json');
  for (let i = 0; i < pages.length; i++) {
    if ((pages[i].text || '').length < 300) { try { pages[i] = bcJson('visit', urls[i], '--max-text', '60000', '--json')[0]; } catch {} }
  }
  return pages;
}
const glabOk = () => { try { gitlab('user'); return true; } catch { return false; } };

// Each check returns [{name, ok, detail}]. Truth is read live, before and after the run when it can drift.
const CARDS = `JSON.stringify([...document.querySelectorAll('a[href*="/products/"]')].map(x => { const c = x.closest('[data-qa-locator=product-item]') || x.parentElement.parentElement; return { href: x.href.split('?')[0], text: (c || x).innerText }; }))`;

const checks = {
  async 'carousell-search'(a) {
    const out = [{ name: 'five listings', ok: a.listings?.length === 5 }];
    for (const l of a.listings ?? []) {
      const text = await pageText(l.url);
      const price = Number(l.price_sgd);
      out.push({ name: `listing ${l.url}`, ok: /carousell\.sg\/p\//.test(l.url) && /aeron/i.test(text) && price <= 600 && text.includes(`S$${price.toLocaleString('en-US')}`) && norm(text).includes(norm(l.seller)), detail: { price, seller: l.seller } });
    }
    return out;
  },
  async 'shopee-compare'(a, run) {
    const urls = new Set((a.listings ?? []).map((l) => l.url));
    const out = [{ name: 'three distinct listings', ok: a.listings?.length === 3 && urls.size === 3 }];
    // Read each card from the run's own results tab: opening product pages in fresh tabs
    // is what raises Shopee's crawler captcha.
    let cards = {};
    try {
      cards = JSON.parse(bc('eval', run.tab, `JSON.stringify([...document.querySelectorAll('a[href*="-i."]')].reduce((m, a) => { const k = a.href.match(/i\\.(\\d+\\.\\d+)/)?.[1]; const t = (a.closest('li,[data-sqe=item]') || a).innerText; if (k && t.length > (m[k] || '').length) m[k] = t; return m; }, {}))`));
    } catch {}
    if (!Object.keys(cards).length) {
      // The run's tab moved on: one search page beats a product page per listing.
      const id = await readyTab('https://shopee.sg/search?keyword=anker%2030w%20charger&sortBy=sales');
      try { bc('wake', id); await sleep(4000); cards = JSON.parse(bc('eval', id, `JSON.stringify([...document.querySelectorAll('a[href*="-i."]')].reduce((m, a) => { const k = a.href.match(/i\\.(\\d+\\.\\d+)/)?.[1]; const t = (a.closest('li,[data-sqe=item]') || a).innerText; if (k && t.length > (m[k] || '').length) m[k] = t; return m; }, {}))`)); } catch {}
      try { bc('close', id); } catch {}
    }
    for (const l of a.listings ?? []) {
      const key = String(l.url).match(/i\.(\d+\.\d+)/)?.[1];
      const text = (key && cards[key]) || await pageText(l.url, 8000);
      const flat = text.replace(/\s+/g, ''); // Shopee splits "$" and the amount into separate elements
      out.push({ name: `listing ${l.url}`, ok: /anker/i.test(l.title) && /anker/i.test(text) && flat.includes(`$${Number(l.price_sgd).toFixed(2)}`), detail: { price: l.price_sgd } });
    }
    return out;
  },
  async 'shopee-cart'(a, run) {
    const rows = await cartRows();
    const hit = rows.some((r) => r.includes(norm(fixtures.shopee_cart_title)) && r.includes(norm(fixtures.shopee_cart_variation_text)));
    return [
      { name: 'fixture not in cart before', ok: !run.pre.inCart },
      { name: 'fixture variation in cart', ok: hit },
      { name: 'agent reports added', ok: a.added === true },
    ];
  },
  async 'carousell-chat'(a) {
    // "me" is a fair answer for the user's own messages; anything else must name the other party.
    const other = norm(fixtures.carousell_chat_user);
    const sameSender = (got, truth) => (norm(truth) === other ? norm(got) === other : norm(got) !== other && norm(got) !== '');
    const msgs = fixtures.carousell_last_messages; // the chat is closed (sold), so its tail is fixed
    const got = a.messages ?? [];
    return [
      { name: 'offer price', ok: Number(a.price_sgd) === fixtures.carousell_offer_price },
      { name: 'last 3 messages', ok: got.length === 3 && got.every((m, i) => norm(m.text) === norm(msgs[i]?.text) && sameSender(m.from, msgs[i]?.from)), detail: msgs.slice(0, 3).map((m) => [m.from, m.text]) },
    ];
  },
  async 'shopee-refund'(a) {
    const orders = recipe('shopee.sg/orders', 'limit=20', '--max-pages', '1');
    const done = orders.find((o) => /completed/i.test(o.status));
    // The order number the UI shows was confirmed once on the order page; reloading that
    // page for every run is what makes Shopee raise its crawler captcha.
    return [
      { name: 'order id', ok: String(a.order_id) === fixtures.shopee_latest_completed_sn, detail: { truth: fixtures.shopee_latest_completed_sn, got: a.order_id } },
      { name: 'shop', ok: norm(a.shop) === norm(done?.shop) },
      { name: 'total', ok: Math.abs(Number(a.total_sgd) * 100000 - Number(done?.total_cents)) < 1000, detail: { truth: done?.total_cents } },
      { name: 'refund fields present', ok: typeof a.refund_available === 'boolean', detail: { refund_available: a.refund_available, deadline: a.refund_deadline, review: 'manual' } },
    ];
  },
  async 'github-prs'(a) {
    const prs = gh('pr', 'list', '-R', 'ModelMonkeys/modelmonkey', '--state', 'merged', '--limit', '500', '--json', 'number,mergedAt');
    const inDec = (iso) => iso.startsWith('2025-12');
    const truth = new Set(prs.filter((p) => inDec(p.mergedAt)).map((p) => p.number));
    const got = new Set((a.prs ?? []).map((p) => Number(p.number)));
    const missing = [...truth].filter((n) => !got.has(n));
    const extra = [...got].filter((n) => !truth.has(n));
    return [{ name: 'exact PR set', ok: !missing.length && !extra.length, detail: { missing, extra } }];
  },
  async 'gitlab-mrs'(a) {
    const truth = gitlab('projects/19/merge_requests?state=closed&per_page=100');
    const byIid = new Map(truth.map((m) => [m.iid, m]));
    const got = (a.mrs ?? []).map((m) => Number(m.iid));
    const missing = [...byIid.keys()].filter((n) => !got.includes(n));
    const extra = got.filter((n) => !byIid.has(n));
    const top = truth.reduce((x, y) => (y.iid > x.iid ? y : x));
    return [
      { name: 'exact closed MR set', ok: !missing.length && !extra.length, detail: { missing, extra } },
      { name: 'authors', ok: (a.mrs ?? []).every((m) => norm(m.author) === norm(byIid.get(Number(m.iid))?.author.username)) },
      { name: 'highest IID source branch', ok: a.highest_iid_source_branch === top.source_branch, detail: top.source_branch },
    ];
  },
  async 'gitlab-author'(a) {
    const all = [1, 2].flatMap(pg => gitlab(`projects/19/merge_requests?state=merged&author_username=yjwong&per_page=100&page=${pg}`));
    const truth = new Set(all.map(m => m.iid));
    const got = new Set((a.mrs ?? []).map(m => Number(m.iid)));
    return [{ name: 'exact merged MR set', ok: truth.size > 0 && [...truth].every(n => got.has(n)) && [...got].every(n => truth.has(n)), detail: { truth: truth.size, got: got.size, missing: [...truth].filter(n => !got.has(n)).slice(0, 10), extra: [...got].filter(n => !truth.has(n)).slice(0, 10) } }];
  },
  async 'lazada-cheapest'(a, run) {
    // Judge against the run's own results tab: the same page the agent saw.
    // If the agent left its tab on a product page, reload the sorted search there.
    // A regrade after the run's tab was closed opens a fresh tab.
    const search = 'https://www.lazada.sg/catalog/?q=27+inch+4k+monitor&sort=priceasc';
    let tab = run.tab;
    const read = () => { try { return JSON.parse(bc('eval', tab, CARDS)); } catch { return []; } };
    let cards = read();
    if (!cards.length) {
      try { bc('nav', tab, search); } catch { tab = await readyTab(search); }
      try { bc('wake', tab); } catch {}
      await sleep(6000);
      cards = read();
    }
    const price = (t) => Number((String(t).match(/\$\s*([\d,]+(?:\.\d+)?)/) || [])[1]?.replace(/,/g, ''));
    const fourK = cards.filter(c => /4k/i.test(c.text) && price(c.text) > 0).map(c => ({ ...c, p: price(c.text) })).sort((x, y) => x.p - y.p);
    const got = a.listings ?? [];
    const out = [{ name: 'five listings, ascending', ok: got.length === 5 && got.every((l, i) => i === 0 || Number(l.price_sgd) >= Number(got[i - 1].price_sgd)) }];
    out.push({ name: 'each is a 4K listing on the page at that price', ok: got.every(l => /4k/i.test(l.title) && cards.some(c => c.href === String(l.url).split('?')[0] && c.text.replace(/\s+/g, '').includes(Number(l.price_sgd).toFixed(2)))), detail: { cards: cards.length } });
    const fifth = Number(got[4]?.price_sgd);
    out.push({ name: 'no cheaper 4K listing was skipped', ok: fourK.filter(c => c.p < fifth).every(c => got.some(l => String(l.url).split('?')[0] === c.href)), detail: fourK.slice(0, 6).map(c => c.p) });
    return out;
  },
  async 'gitlab-closed-branches'(a) {
    const byIid = glabOk()
      ? new Map(gitlab('projects/19/merge_requests?state=closed&per_page=100').map((m) => [m.iid, m]))
      : await glMRs(await glListIids('state=closed'));
    const got = a.mrs ?? [];
    const ids = got.map((m) => Number(m.iid));
    const wrong = got.filter((m) => {
      const t = byIid.get(Number(m.iid));
      return !t || norm(m.author) !== norm(t.author.username) || m.source_branch !== t.source_branch || m.target_branch !== t.target_branch;
    }).map((m) => m.iid);
    return [
      { name: 'exact closed MR set', ok: ids.length === byIid.size && [...byIid.keys()].every((n) => ids.includes(n)), detail: { got: ids.length, want: byIid.size } },
      { name: 'author, source and target branch per MR', ok: !wrong.length, detail: wrong },
    ];
  },
  async 'gitlab-author-commits'(a) {
    const api = glabOk();
    const iids = api
      ? gitlab('projects/19/merge_requests?state=merged&author_username=yjwong&per_page=100').map((m) => m.iid)
      : await glListIids('state=merged&author_username=yjwong&sort=created_date');
    const top = iids.sort((x, y) => y - x).slice(0, 5);
    const got = a.mrs ?? [];
    const wrong = [];
    const ui = api ? null : await glMRs(got.map((m) => Number(m.iid)));
    for (const m of got) {
      const commits = api ? gitlab(`projects/19/merge_requests/${Number(m.iid)}/commits?per_page=100`).length : ui.get(Number(m.iid))?.commits;
      if (Number(m.commits) !== commits) wrong.push({ iid: m.iid, got: m.commits, want: commits });
    }
    return [
      { name: 'the 5 highest IIDs, in order', ok: JSON.stringify(got.map((m) => Number(m.iid))) === JSON.stringify(top), detail: top },
      { name: 'commit counts', ok: !wrong.length, detail: wrong },
    ];
  },
  async 'lazada-brand-stores'(a) {
    const got = a.listings ?? [];
    const pages = got.length ? visitTexts(got.map((l) => l.url), ['--parallel', '1']) : [];
    const out = [{ name: 'three listings', ok: got.length === 3 }]; // product-page prices need not follow the list's order
    got.forEach((l, i) => {
      const text = pages[i]?.text || '';
      out.push({ name: `listing ${i + 1}: LG, 4K, store and price on its page`, ok: /lazada\.sg\/products\//.test(l.url) && /\bLG\b/i.test(l.title) && /4k|uhd|3840/i.test(l.title) && norm(text).includes(norm(l.store)) && text.replace(/[\s,]/g, '').includes(Number(l.price_sgd).toFixed(2)), detail: { store: l.store, price: l.price_sgd, chars: text.length } });
    });
    return out;
  },
  async 'carousell-aeron-sellers'(a) {
    const got = a.listings ?? [];
    const pages = got.length ? visitTexts(got.map((l) => l.url), ['--parallel', '1']) : [];
    const out = [{ name: 'three listings', ok: got.length === 3 }];
    got.forEach((l, i) => {
      const text = pages[i]?.text || '', price = Number(l.price_sgd);
      out.push({ name: `listing ${i + 1}: aeron, price <= 800, condition and seller on its page`, ok: /carousell\.sg\/p\//.test(l.url) && /aeron/i.test(text) && price <= 800 && text.includes(`S$${price.toLocaleString('en-US')}`) && norm(text).includes(norm(l.condition)) && norm(text).includes(norm(l.seller)), detail: { price, condition: l.condition, seller: l.seller, chars: text.length } });
    });
    return out;
  },
  async 'stripe-failed-details'(a) {
    // A reason counts when its phrase or its decline code is on the page (codes use underscores).
    const flat = (x) => norm(String(x).replace(/_/g, ' '));
    const reasonShown = (text, reason) => String(reason).split(/[()]/).map(flat).filter((r) => r.length > 3).some((r) => flat(text).includes(r));
    // The failed list's own links are the truth for ids; each payment page for the rest.
    const id = await readyTab('https://dashboard.stripe.com/payments');
    let links = [];
    try {
      bc('wake', id); await sleep(5000);
      // Click Failed until the URL shows the filter (a click on a page still loading is lost).
      for (let i = 0; i < 3 && !/status\[0\]=failed|status%5B0%5D=failed/.test(bc('eval', id, 'location.href')); i++) { try { bc('do', id, 'click Failed'); } catch {} await sleep(3000); }
      links = JSON.parse(bc('eval', id, `JSON.stringify([...new Set([...document.querySelectorAll('a[href*="/payments/pi_"]')].map(a => a.href.match(/pi_[A-Za-z0-9]+/)[0]))])`));
    } catch {}
    try { bc('close', id); } catch {}
    const got = a.payments ?? [];
    const pages = got.length ? visitTexts(got.map((p) => `https://dashboard.stripe.com/payments/${p.id}`)) : [];
    const out = [{ name: 'the 3 newest failed payment ids, in order', ok: JSON.stringify(got.map((p) => p.id)) === JSON.stringify(links.slice(0, 3)), detail: links.slice(0, 3) }];
    got.forEach((p, i) => {
      const text = pages[i]?.text || '';
      out.push({ name: `payment ${i + 1}: last 4 and reason on its page`, ok: text.includes(String(p.last4)) && reasonShown(text, p.reason), detail: { last4: p.last4, reason: p.reason, chars: text.length } });
    });
    return out;
  },
  async 'cna-top-bylines'(a) {
    // A byline may list several people; each name must be on the article.
    const names = (s) => String(s || '').replace(/^.*\bby\b/i, '').replace(/['"()]/g, '').split(/,|\band\b|&/).map(norm).filter(Boolean);
    const got = a.articles ?? [];
    const section = await pageText('https://www.channelnewsasia.com/singapore', 6000);
    const pages = got.length ? visitTexts(got.map((x) => x.url)) : [];
    // "At the top" means in the first quarter of the section page's text.
    const top = norm(section).slice(0, Math.max(3000, norm(section).length / 4));
    const out = [{ name: 'three articles from the top of the Singapore section', ok: got.length === 3 && got.every((x) => top.includes(norm(x.headline).slice(0, 40))), detail: got.map((x) => norm(section).indexOf(norm(x.headline).slice(0, 40))) }];
    got.forEach((x, i) => {
      const text = pages[i]?.text || '';
      out.push({ name: `article ${i + 1}: headline, author and date on its page`, ok: /channelnewsasia\.com\//.test(x.url) && norm(text).includes(norm(x.headline).slice(0, 40)) && names(x.author).every((n) => norm(text).includes(n)) && norm(text).includes(norm(x.published).slice(0, 10)), detail: { author: x.author, published: x.published, chars: text.length } });
    });
    return out;
  },
  async 'hn-top-comments'(a) {
    // Truth from the official API: front page = the first 30 top stories; points drift, so
    // a story counts when it is in the top 5 now and its numbers are within 15%.
    const api = (p) => fetch(`https://hacker-news.firebaseio.com/v0/${p}.json`).then((r) => r.json());
    const ids = (await api('topstories')).slice(0, 30);
    const items = await Promise.all(ids.map((id) => api(`item/${id}`)));
    const top5 = items.filter(Boolean).sort((x, y) => y.score - x.score).slice(0, 5);
    const got = a.stories ?? [];
    const near = (x, y) => Math.abs(Number(x) - Number(y)) <= Math.max(5, 0.15 * Number(y));
    const out = [{ name: 'three stories among the 5 highest-scored on the front page', ok: got.length === 3 && got.every((g) => top5.some((t) => t.id === Number(g.item_id))), detail: top5.map((t) => t.id) }];
    for (const g of got) {
      const t = items.find((x) => x && x.id === Number(g.item_id)) || await api(`item/${Number(g.item_id)}`);
      // Comment ranking moves minute to minute: the reported commenter must be among the top 3.
      const tops = t?.kids?.length ? await Promise.all(t.kids.slice(0, 3).map((k) => api(`item/${k}`))) : [];
      const bys = tops.filter((c) => c && !c.deleted).map((c) => norm(c.by));
      out.push({ name: `story ${g.item_id}: points, comments, top commenter`, ok: !!t && near(g.points, t.score) && near(g.comments, t.descendants) && (!bys.length || bys.includes(norm(g.top_commenter))), detail: { score: t?.score, comments: t?.descendants, top: bys } });
    }
    return out;
  },
  async 'wiki-tallest'(a) {
    // The list's first ranking table names the tallest; each article's infobox has the facts.
    const id = await readyTab('https://en.wikipedia.org/wiki/List_of_tallest_buildings_in_Singapore');
    let top = [];
    try { top = JSON.parse(bc('eval', id, `JSON.stringify([...document.querySelectorAll('table.wikitable')[0].querySelectorAll('tbody tr')].map(tr => { const a = [...tr.querySelectorAll('td a, th a')].find(x => x.closest('td,th') && !/^\\[|^\\d/.test(x.textContent.trim())); return a ? { name: a.textContent.trim(), href: decodeURIComponent(a.pathname) } : null; }).filter(Boolean).slice(0, 5))`)); } catch {}
    try { bc('close', id); } catch {}
    const got = a.buildings ?? [];
    const pages = got.length ? visitTexts(got.map((b) => b.url)) : [];
    // Matched by article link (names differ from titles: "UOB Plaza" / "United Overseas Bank
    // Plaza One"); the first 5 rows count: four buildings tie at 280 m for second place.
    const path = (u) => { try { return decodeURIComponent(new URL(u).pathname); } catch { return ''; } };
    const final = (i) => path(pages[i]?.final_url || got[i]?.url);
    const out = [{ name: 'the 3 tallest in the list', ok: got.length === 3 && got.every((b, i) => top.slice(0, 5).some((t) => t.href === path(b.url) || t.href === final(i) || norm(t.name) === norm(b.name))), detail: top.map((t) => t.href) }];
    got.forEach((b, i) => {
      const text = pages[i]?.text || '';
      out.push({ name: `${b.name}: height and year on its article`, ok: /wikipedia\.org\/wiki\//.test(b.url) && text.includes(String(Math.round(Number(b.height_m)))) && text.includes(String(b.completed)), detail: { height: b.height_m, completed: b.completed, chars: text.length } });
    });
    return out;
  },
  async 'so-top-puppeteer'(a) {
    const se = (p) => fetch(`https://api.stackexchange.com/2.3/${p}${p.includes('?') ? '&' : '?'}site=stackoverflow`).then((r) => r.json());
    const qs = (await se('questions?order=desc&sort=votes&tagged=puppeteer&pagesize=3')).items || [];
    const acc = qs.map((q) => q.accepted_answer_id).filter(Boolean);
    const answers = acc.length ? ((await se(`answers/${acc.join(';')}`)).items || []) : [];
    const got = a.questions ?? [];
    const out = [{ name: 'the 3 highest-scored puppeteer questions, in order', ok: JSON.stringify(got.map((q) => Number(q.id))) === JSON.stringify(qs.map((q) => q.question_id)), detail: qs.map((q) => q.question_id) }];
    got.forEach((g, i) => {
      const q = qs[i] || {}, ans = answers.find((x) => x.answer_id === q.accepted_answer_id);
      const he = (s) => String(s || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      out.push({ name: `question ${g.id}: score and accepted answer author`, ok: Math.abs(Number(g.score) - q.score) <= Math.max(3, q.score * 0.02) && norm(g.accepted_answer_author) === norm(he(ans?.owner?.display_name || '')), detail: { score: q.score, author: he(ans?.owner?.display_name || '') } });
    });
    return out;
  },
  async 'npm-headless'(a) {
    // The site's search order is its own; the registry gives version and license, the
    // downloads API the weekly count (windows differ, so within 25%).
    const got = a.packages ?? [];
    const search = await fetch('https://registry.npmjs.org/-/v1/search?text=headless%20browser&size=20').then((r) => r.json());
    const names = (search.objects || []).map((o) => o.package.name);
    const out = [{ name: 'three packages from the search results', ok: got.length === 3 && got.every((g) => names.includes(g.name)), detail: names.slice(0, 6) }];
    for (const g of got) {
      const meta = await fetch(`https://registry.npmjs.org/${encodeURIComponent(g.name).replace('%40', '@')}/latest`).then((r) => r.json()).catch(() => ({}));
      const dl = await fetch(`https://api.npmjs.org/downloads/point/last-week/${g.name}`).then((r) => r.json()).catch(() => ({}));
      const lic = typeof meta.license === 'string' ? meta.license : meta.license?.type;
      out.push({ name: `${g.name}: version, license, weekly downloads`, ok: g.version === meta.version && norm(g.license) === norm(lic) && Math.abs(Number(g.weekly_downloads) - dl.downloads) <= dl.downloads * 0.25 + 50, detail: { version: meta.version, license: lic, downloads: dl.downloads } });
    }
    return out;
  },
  async 'pypi-headless'(a) {
    // The search order is read from the site's own results page; facts from the JSON API.
    const id = await readyTab('https://pypi.org/search/?q=headless+browser');
    let names = [];
    try { names = JSON.parse(bc('eval', id, `JSON.stringify([...document.querySelectorAll('a.package-snippet')].map(a => a.querySelector('.package-snippet__name')?.textContent.trim()).filter(Boolean).slice(0, 5))`)); } catch {}
    try { bc('close', id); } catch {}
    const got = a.packages ?? [];
    const out = [{ name: 'the first 3 search results, in order', ok: got.length === 3 && names.length >= 3 && got.every((g, i) => norm(g.name) === norm(names[i])), detail: names }];
    for (const g of got) {
      const info = (await fetch(`https://pypi.org/pypi/${encodeURIComponent(g.name)}/json`).then((r) => r.json()).catch(() => ({}))).info || {};
      const lic = info.license_expression || info.license || (info.classifiers || []).find((c) => c.startsWith('License ::'))?.split('::').pop().trim() || '';
      const licOk = !lic ? !g.license || /none|not specified|unknown/i.test(g.license) : norm(lic).includes(norm(g.license)) || norm(g.license).includes(norm(lic).slice(0, 12));
      out.push({ name: `${g.name}: version, license, requires python`, ok: g.version === info.version && licOk && (info.requires_python ? norm(g.requires_python || '').replace(/\s/g, '') === norm(info.requires_python).replace(/\s/g, '') : !g.requires_python || /not shown|none|not specified|n\/a/i.test(g.requires_python)), detail: { version: info.version, license: lic.slice(0, 40), requires_python: info.requires_python } });
    }
    return out;
  },
  async 'youtube-popular'(a) {
    const id = await readyTab('https://www.youtube.com/@veritasium/videos');
    let text = '';
    try {
      bc('wake', id);
      // The grid renders only while the tab is kept rendering: read it through do's items.
      for (let i = 0; i < 2 && !/views/i.test(text); i++) { try { text = bc('do', id, 'click Popular', '--then', 'items', '--no-prefetch'); } catch (e) { text = String(e.stdout || ''); } }
    } catch {}
    try { bc('close', id); } catch {}
    const got = a.videos ?? [];
    const head = norm(text).slice(0, Math.max(4000, norm(text).length / 3));
    const out = [{ name: 'five videos from the top of the Popular view', ok: got.length === 5 && got.every((v) => head.includes(norm(v.title).slice(0, 30))), detail: { chars: text.length } }];
    const pages = got.length >= 2 ? visitTexts(got.slice(0, 2).map((v) => v.url)) : [];
    (a.top2_upload_dates || []).forEach((d, i) => {
      const t = norm(pages[i]?.text || ''), year = (String(d).match(/\d{4}/) || [''])[0];
      out.push({ name: `video ${i + 1}: upload date on its page`, ok: /youtube\.com\/watch|youtu\.be\//.test(got[i]?.url || '') && ((!!year && t.includes(year)) || t.includes(norm(d))), detail: { date: d, chars: t.length } });
    });
    return out;
  },
  async 'imdb-top3'(a) {
    const id = await readyTab('https://www.imdb.com/chart/top/');
    let top = [];
    try { bc('wake', id); await sleep(5000); } catch {}
    try { top = JSON.parse(bc('eval', id, `JSON.stringify([...new Set([...document.querySelectorAll('a[href*="/title/tt"]')].map(a => a.textContent.replace(/^\\d+\\.\\s*/, '').trim()).filter(Boolean))].slice(0, 5))`)); } catch {}
    try { bc('close', id); } catch {}
    const got = a.movies ?? [];
    const pages = got.length ? visitTexts(got.map((m) => m.url), ['--parallel', '1']) : [];
    const out = [{ name: 'the top 3 of the chart, in order', ok: got.length === 3 && top.length >= 3 && got.every((m, i) => norm(top[i] || '').includes(norm(m.title).slice(0, 15)) || norm(m.title).includes(norm(top[i] || '').slice(0, 15))), detail: top.slice(0, 3) }];
    got.forEach((m, i) => {
      const t = norm(pages[i]?.text || '');
      out.push({ name: `${m.title}: year, director, runtime on its page`, ok: /imdb\.com\/title\/tt/.test(m.url) && t.includes(String(m.year)) && t.includes(norm(m.director)) && t.includes(norm(m.runtime).replace(/\s+/g, ' ')), detail: { director: m.director, runtime: m.runtime, chars: t.length } });
    });
    return out;
  },
  async 'cna-singapore'(a) {
    const text = await pageText('https://www.channelnewsasia.com/singapore', 7000);
    const got = a.articles ?? [];
    return [
      { name: 'five articles', ok: got.length === 5 },
      { name: 'each headline is on the Singapore section and links to CNA', ok: got.every(x => /channelnewsasia\.com\//.test(x.url) && norm(text).includes(norm(x.headline).slice(0, 40))) },
    ];
  },
  async 'stripe-failed'(a) {
    // Filter the way the UI does; Stripe's filter URLs are not stable.
    const id = await readyTab('https://dashboard.stripe.com/payments');
    let text = '';
    try { bc('wake', id); await sleep(6000); bc('do', id, 'click Failed'); await sleep(5000); text = bc('text', id, '--max-text', '60000'); } catch {}
    try { bc('close', id); } catch {}
    const got = a.payments ?? [];
    return [
      { name: 'three payments', ok: got.length === 3 },
      { name: 'each customer and amount appear among failed payments', ok: got.every(x => norm(text).includes(norm(x.customer)) && text.replace(/\s+/g, '').includes(String(x.amount).replace(/\s+/g, '').replace(/USD$/i, ''))), detail: got.map(x => x.customer) },
    ];
  },
};

async function cartRows() {
  const text = await pageText('https://shopee.sg/cart', 8000);
  return norm(text).split(/delete/).map((r) => r);
}

// Run before the agent, so checks and undo have a baseline.
const prepare = {
  async 'shopee-cart'() { const rows = await cartRows(); return { inCart: rows.some((r) => r.includes(norm(fixtures.shopee_cart_title)) && r.includes(norm(fixtures.shopee_cart_variation_text))) }; },
};

const undo = {
  async 'shopee-cart'(run) {
    if (run.pre.inCart) return 'skipped: was in cart before';
    const id = await readyTab('https://shopee.sg/cart');
    try {
      for (let i = 0; i < 3; i++) {
        const snap = bc('read', id);
        const lines = snap.split('\n');
        const at = lines.findIndex((l) => /button\s+Variations:/.test(l) && norm(l).includes(norm(fixtures.shopee_cart_variation_text)));
        if (at < 0) return i ? 'removed' : 'not in cart';
        const del = lines.slice(at).find((l) => /button\s+Delete/.test(l));
        bc('click', id, '--ref', del.trim().split(/\s+/)[0]);
        await sleep(3000);
      }
      return 'still in cart after 3 deletes';
    } finally { try { bc('close', id); } catch {} }
  },
};

function agentPrompt(task, arm, tab) {
  const allow = task.jev_allow_controls.map((c) => ` --allow-control '${JSON.stringify(c)}'`).join('');
  const common = `You are one run of a timed browser benchmark. Work quickly and stop as soon as you have a verified answer.

Task: ${fill(task.goal)}

Browser: the user's Dia, always with --browser dia. Your start tab is ${tab}, already open on the task's start page. Leave it open when you finish.
Use the website's UI only. Do not use browserctrl recipes, gh, glab, curl, or fetch() calls to the site's APIs. Reading the page (browserctrl read/text/html/eval of DOM) is fine. Do not touch other tabs.

Your final message must be only a JSON object of this shape: ${task.answer}
Add "notes": a one-line string on anything that went wrong.`;
  // H: the D method, run by a fast model (the arm only differs in the model that runs it).
  if (arm === 'D' || arm === 'H') return `${common}

Method: plan with browserctrl (skill: ~/.agents/skills/browserctrl/SKILL.md, sections "Plan several steps in one call with do" and "Read lists, cards and messages with items"). If the site keeps filters in its URL, nav to that URL instead of driving the filter controls. Otherwise send the steps you can foresee in ONE call instead of reading the page before each click:
  browserctrl do ${tab} 'fill "<field, in words>" = "<value>"' 'key Enter' 'click "<element, in words>"' ... --then items --browser dia
It finds each element (exact name, else Jev), waits for results, and stops at the first uncertain or committing step (exit 3). Its report lists Jev's candidates, elements that exist but are hidden, and the controls on screen: re-plan from that report with another do call instead of probing the page with eval. Use \`browserctrl items ${tab}\` to read lists and \`browserctrl text\` only for other facts. For lists that span pages, add --repeat 'click "Next"' --until "<when to stop>" --collect items to the do call. To open several items from a list, add --open N --grep "<what to find>" to the do call (it opens the first N items of the main list in parallel and returns matching lines), or pass links to \`browserctrl visit <link>... --from ${tab} --grep "<what to find>" --browser dia\`, instead of clicking into each. The report's url params line shows filters you can set with a nav step. Trust a report whose steps all show ✓. Do not use jev-tool.`;
  if (arm === 'C') return `${common}

Method: drive the page yourself with browserctrl (skill: ~/.agents/skills/browserctrl/SKILL.md), using its Jev intent commands instead of reading the page to find refs:
  browserctrl click ${tab} --intent "<the element, in words>" [--expect "<what the page should show after>"] --browser dia
  (also fill/select with --intent; exit 3 means Jev was unsure or the control can commit something, and it prints candidate refs to act on by ref)
  browserctrl check ${tab} --expect "<state>" --browser dia   to confirm the page state cheaply
Read the page (text/eval) only for the facts you must report. Do not use jev-tool.`;
  if (arm === 'A') return `${common}

Method: drive the page yourself with browserctrl (skill: ~/.agents/skills/browserctrl/SKILL.md). Do not use Jev.`;
  return `${common}

Method: use Jev for the navigation (skill: ~/.agents/skills/jev-browser/SKILL.md). Start with one bounded run:
  cd ${JEV_DIR} && uv run jev-tool --browser dia --tab ${tab} --goal '<the task, in your words>' --run --max-steps 15 --max-seconds 180${allow}
Then read the page with browserctrl to extract and verify the answer. If Jev paused, failed or stopped early, finish the task with browserctrl or a persistent Jev session, as the skill describes. Do not relaunch the same failing goal.
Add to your JSON "jev": {"runs": n, "predictions": n, "exit_codes": [..], "finished_by": "jev" | "agent"}.`;
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i < 0 ? undefined : rest[i + 1]; };

if (cmd === 'start') {
  const [taskId, arm, n] = rest;
  const task = tasks.find((t) => t.id === taskId);
  if (!task || !['A', 'B', 'C', 'D', 'H'].includes(arm)) throw new Error('usage: start <task> <A|B|C|D|H> <n> [--tab ID]');
  const runId = `${taskId}-${arm}-${n}`;
  const pre = (await prepare[taskId]?.()) ?? {};
  let tab = flag('--tab');
  if (!tab) {
    if (task.start_url.startsWith('HANDOFF:')) throw new Error('this task needs --tab <a tab the user opened>');
    tab = await readyTab(fill(task.start_url));
    bc('release', tab); // the run's agent claims it, not the harness
  }
  const run = { runId, task: taskId, arm, n: Number(n), tab, tabsBefore: tabIds(), pre, startedAt: new Date().toISOString(), load: os.loadavg()[0] };
  fs.mkdirSync(path.join(runsDir, runId), { recursive: true });
  fs.writeFileSync(path.join(runsDir, runId, 'run.json'), JSON.stringify(run, null, 2));
  process.stdout.write(agentPrompt(task, arm, tab) + '\n');
} else if (cmd === 'finish') {
  const [runId, answerFile] = rest;
  const run = JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'run.json'), 'utf8'));
  const raw = fs.readFileSync(answerFile, 'utf8');
  fs.writeFileSync(path.join(runsDir, runId, 'answer.txt'), raw);
  let answer;
  try { answer = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { answer = null; }
  const results = answer ? await checks[run.task](answer, run) : [{ name: 'answer is JSON', ok: false }];
  const undone = undo[run.task] ? await undo[run.task](run) : null;
  // Close only this run's tabs: runs overlap, so "new since start" would include other runs' tabs.
  const handoff = tasks.find((t) => t.id === run.task).start_url.startsWith('HANDOFF:');
  const mine = new Set([...(handoff ? [] : [run.tab]), ...(answer?.tab && answer.tab !== run.tab ? [answer.tab] : [])].map((t) => t.slice(0, 8)));
  const closed = [];
  for (const id of tabIds()) {
    // The run's agent still holds a claim on its tab, so take it over to close it.
    if (mine.has(id)) { try { bc('close', id, '--steal'); closed.push(id); } catch (e) { console.error(`could not close ${id}: ${String(e.stderr || e).trim()}`); } }
  }
  const row = {
    run: runId, task: run.task, arm: run.arm, n: run.n, at: run.startedAt, load: run.load,
    pass: results.every((r) => r.ok), checks: results,
    agent_ms: Number(flag('--ms')), agent_tokens: Number(flag('--tokens')), tool_uses: Number(flag('--tools')),
    jev: answer?.jev ?? null, notes: answer?.notes ?? null, undo: undone, closed_tabs: closed.length,
  };
  fs.appendFileSync(resultsFile, JSON.stringify(row) + '\n');
  console.log(JSON.stringify({ run: runId, pass: row.pass, failed: results.filter((r) => !r.ok), undo: undone }, null, 2));
} else if (cmd === 'report') {
  const rows = fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return !s.length ? NaN : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // Rounds are run-number ranges: 1-3 compared A with B, 11-13 compare A with C.
  const from = Number(flag('--from') || 1), to = Number(flag('--to') || from + 9);
  const lines = ['| task | arm | runs | pass | median s (passing) | median tokens | median tools | verdict |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const t of tasks) {
    const stat = {};
    for (const arm of ['A', 'B', 'C', 'D']) {
      const rs = rows.filter((r) => r.task === t.id && r.arm === arm && r.n >= from && r.n <= to);
      const ok = rs.filter((r) => r.pass);
      stat[arm] = { n: rs.length, pass: ok.length, ms: median(ok.map((r) => r.agent_ms)), tokens: median(rs.map((r) => r.agent_tokens)), tools: median(rs.map((r) => r.tool_uses)) };
    }
    const A = stat.A;
    // Pre-registered rule: an arm wins a task if it is >=30% faster to a verified answer and no less successful than A.
    const verdict = (X) => A.n < 3 || X.n < 3 ? 'incomplete' : X.pass >= A.pass && X.pass > 0 && X.ms <= 0.7 * A.ms ? 'Jev wins' : 'agent';
    for (const arm of ['A', 'B', 'C', 'D']) {
      const s = stat[arm];
      if (!s.n) continue;
      lines.push(`| ${t.id} | ${arm} | ${s.n} | ${s.pass}/${s.n} | ${(s.ms / 1000).toFixed(0)} | ${s.tokens} | ${s.tools} | ${arm === 'A' ? '' : verdict(s)} |`);
    }
  }
  console.log(lines.join('\n'));
} else {
  console.error('usage: run.mjs start|finish|report');
  process.exit(1);
}
