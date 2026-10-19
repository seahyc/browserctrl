// The address parameters this page uses, read from the page itself: its own query, forms
// that submit by GET, and links to the same path with a query (sort, filter, page links).
// A filter the page keeps in its address can then be set with one nav step.
() => {
  const here = new URL(location.href), seen = new Map();
  const add = (k, v, src) => {
    if (!k || k.length > 40 || /^(utm_|fbclid|gclid|_)/i.test(k)) return;
    const e = seen.get(k) || { values: new Set(), src: new Set() };
    if (v != null && v !== '' && String(v).length < 40) e.values.add(String(v));
    e.src.add(src); seen.set(k, e);
  };
  for (const [k, v] of here.searchParams) add(k, v, 'url');
  for (const f of document.querySelectorAll('form')) {
    if ((f.getAttribute('method') || 'get').toLowerCase() !== 'get') continue;
    for (const el of f.querySelectorAll('input[name],select[name]')) if (!/^(hidden|submit|button|password)$/i.test(el.type)) add(el.name, el.value, 'form');
  }
  let links = 0;
  for (const a of document.querySelectorAll('a[href*="?"]')) {
    if (links > 400) break;
    let u; try { u = new URL(a.href); } catch { continue; }
    const trim = (p) => p.replace(/\/+$/, '');
    if (u.origin !== here.origin || trim(u.pathname) !== trim(here.pathname)) continue;
    links++;
    for (const [k, v] of u.searchParams) add(k, v, 'link');
  }
  return [...seen].map(([k, e]) => ({ name: k, values: [...e.values].slice(0, 4), from: [...e.src] }))
    .sort((x, y) => y.from.length - x.from.length || y.values.length - x.values.length).slice(0, 10);
}
