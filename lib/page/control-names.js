() => {
  const names = new Set(), kit = findKit();
  const walk = root => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.tagName === 'IFRAME' && el.contentDocument) walk(el.contentDocument);
      if (!el.matches('button,input,select,textarea,a[href],[role]') || kit.hiddenWhy(el)) continue;
      const name = accName(el).replace(/\s+/g, ' ').trim();
      if (name) names.add(name);
    }
  };
  walk(document);
  return [...names];
}
