({ limit = 100000 }) => {
  const spans = [];
  let heading = '', size = 0;
  const visible = el => {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && !!el.getClientRects().length;
  };
  const add = (text, source_attribute) => {
    if (!text || !text.trim() || size >= limit) return;
    size += text.length;
    spans.push({ text, ...(heading ? { heading } : {}), ...(source_attribute ? { source_attribute } : {}) });
  };
  const textOf = el => [...el.childNodes].map(node => node.nodeType === Node.TEXT_NODE ? node.textContent :
    node.nodeType === Node.ELEMENT_NODE && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg)$/.test(node.tagName) && visible(node) ? textOf(node) : '').join(' ').replace(/\s+/g, ' ').trim();
  const walk = el => {
    if (!visible(el) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) return;
    if (/^H[1-6]$/.test(el.tagName)) heading = el.innerText.trim();
    const role = el.getAttribute('role');
    if (['progressbar', 'meter', 'img', 'status'].includes(role) || el.tagName === 'METER') {
      for (const attr of ['aria-label', 'aria-valuetext']) add(el.getAttribute(attr), attr);
    }
    if (el.tagName === 'IMG') add(el.getAttribute('alt'), 'alt');
    if (['ABBR', 'TIME'].includes(el.tagName)) add(el.getAttribute('title'), 'title');
    if (el.tagName === 'TIME') add(el.getAttribute('datetime'), 'datetime');
    const children = [...el.children].filter(visible);
    // Join short facts at element boundaries, where innerText may omit spaces.
    const inline = child => {
      const style = getComputedStyle(child);
      return /^(SPAN|A|B|STRONG|EM|I|SMALL|ABBR|TIME|IMG|svg)$/.test(child.tagName) ||
        /^(inline|inline-block|inline-flex)$/.test(style.display) ||
        style.display === 'flex' && style.flexDirection === 'row';
    };
    const style = getComputedStyle(el);
    const row = /^(flex|inline-flex)$/.test(style.display) && style.flexDirection === 'row';
    const pieces = children.every(inline) || row && !children.some(child => /^H[1-6]$/.test(child.tagName));
    const text = pieces && el !== document.body ? textOf(el) : '';
    if (pieces && text.length <= 220 && el !== document.body) {
      add(text);
      for (const child of children) walkAttributes(child);
    } else {
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) add(node.textContent.trim());
        else if (node.nodeType === Node.ELEMENT_NODE) walk(node);
      }
    }
  };
  const walkAttributes = el => {
    // Descendants may carry accessible evidence even inside a joined block.
    if (!visible(el)) return;
    const role = el.getAttribute('role');
    const attrs = [
      ...(['progressbar', 'meter', 'img', 'status'].includes(role) ? ['aria-label', 'aria-valuetext'] : []),
      ...(el.tagName === 'IMG' ? ['alt'] : []),
      ...(['ABBR', 'TIME'].includes(el.tagName) ? ['title'] : []),
      ...(el.tagName === 'TIME' ? ['datetime'] : []),
    ];
    for (const attr of attrs) add(el.getAttribute(attr), attr);
    for (const child of el.children) walkAttributes(child);
  };
  if (document.body) walk(document.body);
  return spans;
}
