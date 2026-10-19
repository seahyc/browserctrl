// The page's text in reading order, one line per block.
() => {
  // The page's main element, unless it is a fragment (some shops mark a small block as main).
  const all = (document.body.innerText || '').length;
  const main = document.querySelector('main,[role=main],article');
  const root = main && (main.innerText || '').length >= all * 0.5 ? main : document.body;
  const raw = (root.innerText || '').split(/\n+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { title: document.title, url: location.href, lines: raw };
}
