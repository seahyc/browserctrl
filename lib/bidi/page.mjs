// Functions run inside the page through WebDriver BiDi script.callFunction, in a sandbox
// realm so page scripts cannot tamper with them. Each takes JSON-serializable arguments and
// returns a JSON string. Refs are data-bc-ref attributes on the elements a read listed, so a
// later command finds the same element (the DOM is shared between realms).

export const SANDBOX = 'browserctrl';
export const REF_ATTR = 'data-bc-ref';

const INTERACTIVE = [
  'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary', 'details > summary',
  '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]', '[role=menuitem]',
  '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]', '[role=searchbox]', '[role=slider]',
  '[contenteditable=""]', '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
].join(',');

// read: list visible interactive elements as ref_N and the page text.
export const SNAPSHOT = `function (argsJson) {
  const { maxText, all } = JSON.parse(argsJson);
  const ATTR = ${JSON.stringify(REF_ATTR)};
  for (const el of document.querySelectorAll('[' + ATTR + ']')) el.removeAttribute(ATTR);
  const vh = window.innerHeight, vw = window.innerWidth;
  const clean = s => String(s || '').replace(/\\s+/g, ' ').trim();
  const visible = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
  };
  const roleOf = el => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.localName;
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'range') return 'slider';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };
  const nameOf = el => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\\s+/).map(id => document.getElementById(id)?.innerText || '').join(' '); if (clean(t)) return clean(t); }
    if (el.labels && el.labels.length) { const t = [...el.labels].map(l => l.innerText).join(' '); if (clean(t)) return clean(t); }
    const text = clean(el.innerText || el.textContent);
    if (text) return text.slice(0, 80);
    return clean(el.value || el.placeholder || el.title || el.getAttribute('alt') || el.name || '').slice(0, 80);
  };
  const stateOf = el => {
    const s = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (el.checked || el.getAttribute('aria-checked') === 'true') s.push('checked');
    if (el.localName === 'select') s.push('= "' + clean(el.options[el.selectedIndex]?.text) + '"');
    else if (['input', 'textarea'].includes(el.localName) && !['checkbox', 'radio', 'button', 'submit'].includes((el.type || '').toLowerCase()) && el.value) s.push('= "' + clean(el.value).slice(0, 60) + '"');
    return s;
  };
  const refs = [];
  let n = 0;
  for (const el of document.querySelectorAll(${JSON.stringify(INTERACTIVE)})) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const where = r.bottom < 0 ? 'above' : r.top > vh ? 'below' : r.right < 0 || r.left > vw ? 'beside' : '';
    if (!all && where && refs.length >= 400) continue;
    n += 1;
    const ref = 'ref_' + n;
    el.setAttribute(ATTR, ref);
    refs.push({ ref, role: roleOf(el), name: nameOf(el), state: stateOf(el), where });
  }
  const text = clean(document.body ? document.body.innerText : '').slice(0, maxText);
  const full = document.body ? document.body.innerText || '' : '';
  return JSON.stringify({
    title: document.title, url: location.href, refs, text: full.length > maxText ? text + ' …' : (document.body ? document.body.innerText.trim().slice(0, maxText) : ''),
    scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, viewport: vh,
  });
}`;

// Find the target (ref, CSS selector or nothing), scroll it into view, report its centre.
export const LOCATE = `function (argsJson) {
  const { ref, selector } = JSON.parse(argsJson);
  const el = ref ? document.querySelector('[' + ${JSON.stringify(REF_ATTR)} + '="' + ref + '"]') : selector ? document.querySelector(selector) : null;
  if (!el) return JSON.stringify({ found: false });
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(x, y);
  return JSON.stringify({
    found: true, x, y, width: r.width, height: r.height, tag: el.localName, type: (el.type || '').toLowerCase(),
    disabled: Boolean(el.disabled), covered: Boolean(top && top !== el && !el.contains(top) && !top.contains(el)),
    editable: el.isContentEditable || ['input', 'textarea'].includes(el.localName),
  });
}`;

// Select all text in the target so typing replaces it.
export const SELECT_CONTENT = `function (argsJson) {
  const { ref, selector } = JSON.parse(argsJson);
  const el = ref ? document.querySelector('[' + ${JSON.stringify(REF_ATTR)} + '="' + ref + '"]') : document.querySelector(selector);
  if (!el) return JSON.stringify({ found: false });
  el.focus();
  if (typeof el.select === 'function') el.select();
  else if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(range); }
  return JSON.stringify({ found: true, value: el.value ?? el.textContent ?? '' });
}`;

// Choose an <option> by visible text or value.
export const CHOOSE_OPTION = `function (argsJson) {
  const { ref, selector, option } = JSON.parse(argsJson);
  const el = ref ? document.querySelector('[' + ${JSON.stringify(REF_ATTR)} + '="' + ref + '"]') : document.querySelector(selector);
  if (!el) return JSON.stringify({ found: false });
  if (el.localName !== 'select') return JSON.stringify({ found: true, error: 'not a <select>' });
  const want = String(option).trim().toLowerCase();
  const opts = [...el.options];
  const hit = opts.find(o => o.text.trim().toLowerCase() === want) || opts.find(o => o.value.toLowerCase() === want) || opts.find(o => o.text.trim().toLowerCase().includes(want));
  if (!hit) return JSON.stringify({ found: true, error: 'no option', options: opts.map(o => o.text.trim()).slice(0, 30) });
  el.value = hit.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ found: true, chosen: hit.text.trim(), value: hit.value });
}`;

// One check for wait: text, url, selector; also reports readiness.
export const PROBE = `function (argsJson) {
  const { text, url, selector, gone } = JSON.parse(argsJson);
  const body = document.body ? document.body.innerText : '';
  const res = { url: location.href, ready: document.readyState };
  if (text !== undefined) res.text = body.includes(text);
  if (url !== undefined) res.urlMatch = location.href.includes(url);
  if (selector !== undefined) { const el = document.querySelector(selector); res.selector = gone ? !el : Boolean(el); }
  return JSON.stringify(res);
}`;

export const PAGE_TEXT = `function () { return JSON.stringify(document.body ? document.body.innerText : ''); }`;
export const PAGE_HTML = `function () { return JSON.stringify(document.documentElement.outerHTML); }`;
export const PAGE_TITLE = `function () { return JSON.stringify({ title: document.title, url: location.href }); }`;
export const SCROLL = `function (argsJson) {
  const { to, dy } = JSON.parse(argsJson);
  if (to === 'top') scrollTo(0, 0);
  else if (to === 'end' || to === 'bottom') scrollTo(0, document.documentElement.scrollHeight);
  else scrollBy(0, dy);
  return JSON.stringify({ scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight });
}`;
