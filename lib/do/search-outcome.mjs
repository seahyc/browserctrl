import * as ops from '../ops.mjs';
import * as captcha from '../captcha.mjs';
import { sleep } from '../timing.mjs';
import { deepQuery } from '../refs.mjs';
import { itemsExpression, mainGroup } from '../items.mjs';

const words = value => String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
export function searchMismatch(value, before, after) {
  if (!before || !after || (before.url === after.url && before.results === after.results)) return null;
  const typed = words(value);
  if (!typed.length || typed.some(w => words(after.url + ' ' + after.title + ' ' + after.headings + ' ' + after.results).includes(w))) return null;
  const shows = (after.headings || after.results || after.title || after.url).slice(0, 180);
  return `the page shows ${JSON.stringify(shows)}, not the typed ${JSON.stringify(value)}`;
}
export async function searchState(ctx) {
  const state = await ops.evaluate(ctx.conn, ctx.tab, `(() => {
  const main=document.querySelector('main,[role=main]');
  const content=main?.cloneNode(true);
  content?.querySelectorAll('form,input,textarea,select,nav,aside,[role=listbox],[role=dialog],dialog,script,style').forEach(e=>e.remove());
  return {url:location.href,title:document.title,headings:[...document.querySelectorAll('h1,h2,[role=heading]')].filter(e=>e.getBoundingClientRect().height).map(e=>e.innerText).join(' ').slice(0,3000),results:(content?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,16000)};
})()`);
  const listing = await ops.evaluate(ctx.conn, ctx.tab, itemsExpression({ all: true, transient: true }));
  const list = mainGroup(listing);
  state.hasResults = Boolean(list) || /\b(?:results?|showing\s+\d)\b/i.test(state.headings);
  if (list) state.results = list.items.map(item => item.text).join(' ');
  return state;
}

// Suggestions often arrive after the typing quiet window. Wait only for fields that
// advertise autocomplete, or have a visible listbox tied to/under the field.
export async function waitSuggestions(ctx, filled) {
  if (!filled?.selector) return;
  const limit = Math.min(Date.now() + 1400, ctx.deadline);
  while (Date.now() < limit) {
    const state = await ops.evaluate(ctx.conn, ctx.tab, `(() => {
      const el=${deepQuery(filled.selector)}; if(!el) return null;
      const r=el.getBoundingClientRect(), ids=((el.getAttribute('aria-controls')||'')+' '+(el.getAttribute('aria-owns')||'')).split(/\\s+/);
      const lists=[...document.querySelectorAll('[role=listbox]')].filter(n=>{const b=n.getBoundingClientRect();return b.width&&b.height&&(ids.includes(n.id)||(b.top>=r.bottom-8&&b.top-r.bottom<300&&b.right>r.left&&b.left<r.right))});
      return {auto:el.getAttribute('role')==='combobox'||el.hasAttribute('aria-autocomplete')||lists.length>0,text:lists.map(n=>n.innerText).join(' ')};
    })()`, { timeoutMs: Math.max(1, Math.min(200, limit - Date.now())) }).catch(() => null);
    if (!state?.auto || words(filled.value).some(w => words(state.text).includes(w))) return;
    await sleep(Math.min(100, Math.max(0, limit-Date.now())));
  }
}

// Terminal denials need a denial message or HTTP status. A cleared captcha can
// retain its security-check title, so the title alone does not prove a block.
export async function detectSiteBlock(ctx) {
  const denied = await ops.evaluate(ctx.conn, ctx.tab, `(() => {
    const text=(document.body?.innerText||'').replace(/\\s+/g,' ').trim();
    const headings=[document.title,...[...document.querySelectorAll('h1,h2,[role=heading]')].map(e=>e.innerText)];
    const heading=headings.join(' ');
    const hard=/\\b(?:you (?:have been|are) blocked|access denied|request (?:was )?(?:blocked|denied)|access (?:has been |is )?restricted|permission denied)\\b/i;
    const match=heading.match(hard)||(text.length<3500&&text.match(hard))||headings.find(h=>/^(?:403\\s*(?:[-:–]\\s*)?)?forbidden[.!]?$/i.test(h.trim()));
    if(match)return {message:typeof match==='string'?match:match[0]};
    const status=performance.getEntriesByType('navigation')[0]?.responseStatus;
    if(status===403)return {message:'HTTP 403'};
    return null;
  })()`).catch(() => null);
  if (!denied) return null;
  const challenge = await captcha.detect(ctx.conn, ctx.tab).catch(() => null);
  if (challenge && !['interstitial', 'unknown-challenge'].includes(challenge.kind)) return null;
  return { code: 'site_blocked', noResume: true, reason: `the site blocked this browser (${denied.message})` };
}

export const modalDialogs = ctx => ops.evaluate(ctx.conn, ctx.tab, `(() => [...document.querySelectorAll('dialog:modal,[aria-modal=true]')].filter(e=>e.getBoundingClientRect().height).map(e=>{if(!e.dataset.browserctrlDialogKey)e.dataset.browserctrlDialogKey=Math.random().toString(36).slice(2);return e.dataset.browserctrlDialogKey}))()`).catch(() => []);
