// Labels and descriptions that can support a non-exact name, without borrowing unrelated page text.
({ ref, selector }) => {
  const el = selector ? findDeep(selector) : window.__cdp?.els?.[Number(ref.replace('ref_', '')) - 1];
  if (!el) return '';
  const ids = (node, attr) => (node.getAttribute(attr) || '').split(/\s+/).map(id => node.getRootNode().getElementById?.(id)?.textContent || '').join(' ');
  const labels = [el.getAttribute('aria-description'), ids(el, 'aria-describedby')];
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement || n.getRootNode()?.host) {
    if (n.matches('fieldset,section,[role=group],[role=region],[role=listbox],[role=dialog]')) {
      labels.push(n.getAttribute('aria-label'), ids(n, 'aria-labelledby'));
      const heading = n.querySelector(':scope > legend,:scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > [role=heading]');
      if (heading) labels.push(heading.textContent);
    }
  }
  return labels.filter(Boolean).join(' ').slice(0, 1000);
}
