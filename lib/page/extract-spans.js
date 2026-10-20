({ limit = 100000 }) => {
  const spans = [], seen = new Set();
  let heading = '', size = 0;
  const visible = el => {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && !!el.getClientRects().length;
  };
  const add = (text, source_attribute, structured = false) => {
    text = text?.replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text) || size + text.length > limit) return;
    seen.add(text);
    size += text.length;
    spans.push({ text, ...(structured ? { structured: true } : {}), ...(heading ? { heading } : {}), ...(source_attribute ? { source_attribute } : {}) });
  };
  const textOf = el => [...el.childNodes].map(node => node.nodeType === Node.TEXT_NODE ? node.textContent :
    node.nodeType === Node.ELEMENT_NODE && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg)$/.test(node.tagName) && visible(node) ? textOf(node) : '').join(' ').replace(/\s+/g, ' ').trim();
  const walk = el => {
    if (!visible(el) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) return;
    if (/^H[1-6]$/.test(el.tagName)) {
      const title = el.innerText.replace(/\s+/g, ' ').trim();
      heading = heading && /^[\d$€£₹¥]/.test(title) ? `${heading}: ${title}` : title;
    }
    if (el.tagName === 'A') {
      const tag = el.getAttribute('href')?.split(/[?#]/)[0].split('/').pop();
      if (/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(tag || '') &&
          (textOf(el).match(/v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g) || []).some(value => value.replace(/^v/, '') === tag.replace(/^v/, ''))) add(tag, 'href');
    }
    const role = el.getAttribute('role');
    if (['progressbar', 'meter', 'img', 'status'].includes(role) || el.tagName === 'METER') {
      for (const attr of ['aria-label', 'aria-valuetext']) add(el.getAttribute(attr), attr);
    }
    if (el.tagName === 'IMG') add(el.getAttribute('alt'), 'alt');
    if (['ABBR', 'TIME'].includes(el.tagName)) add(el.getAttribute('title'), 'title');
    if (el.tagName === 'TIME') add(el.getAttribute('datetime'), 'datetime');
    const children = [...el.children].filter(visible);
    if (el.tagName === 'TR') {
      const cells = children.filter(child => /^(TH|TD)$/.test(child.tagName));
      if (cells.length === 1 && cells[0].tagName === 'TH') heading = textOf(cells[0]);
      if (cells.length > 1) {
        const label = textOf(cells[0]);
        const value = cells.slice(1).map(textOf).join(' ');
        if (label && value && label.length + value.length <= 220) add(`${label}: ${value}`, undefined, true);
      }
    }
    if (el.tagName === 'DT') {
      const values = [];
      for (let sibling = el.nextElementSibling; sibling?.tagName === 'DD'; sibling = sibling.nextElementSibling) {
        if (visible(sibling)) values.push(textOf(sibling));
      }
      const label = textOf(el), value = values.join(' ');
      if (label && value && label.length + value.length <= 220) add(`${label}: ${value}`, undefined, true);
    }
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
    if (pieces && text.length <= 220 && el !== document.body) add(text);
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) add(node.textContent);
      else if (node.nodeType === Node.ELEMENT_NODE) walk(node);
    }
  };
  if (document.body) walk(document.body);
  return spans;
}
