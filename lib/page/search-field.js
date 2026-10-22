({ selector, name }) => {
  const el = findDeep(selector);
  if (!el) return false;
  if (/^(number|date|datetime-local|month|week|time|range)$/.test(el.type)) return false;
  const label = [name, el.getAttribute('aria-label'), el.placeholder, ...Array.from(el.labels || []).map(label => label.textContent)].filter(Boolean).join(' ');
  return el.getAttribute('role') === 'searchbox' || el.type === 'search' || !!el.closest('[role=search]') ||
    /\b(search|query|find|where|destination)\b/i.test(label) ||
    (el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete')) && /\b(address|location|place|city|country|region|origin)\b/i.test(label);
}
