({ capture = false }) => {
  const visible = el => el.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  if (capture) {
    window.__bcDirtyDialogs = Array.from(document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')).filter(visible).filter(dialog =>
      Array.from(dialog.querySelectorAll('input, textarea, select')).some(field => {
        if (field.matches('input[type="checkbox"], input[type="radio"]')) return field.checked !== field.defaultChecked;
        if (field.tagName === 'SELECT') {
          const options = Array.from(field.options);
          const hasDefault = options.some(option => option.defaultSelected);
          return options.some((option, index) => option.selected !== (option.defaultSelected || (!field.multiple && !hasDefault && index === 0)));
        }
        return field.value !== field.defaultValue;
      })
    ).map(el => ({ el, name: accName(el) || el.querySelector('h1,h2,h3')?.textContent?.trim() || 'unnamed dialog' }));
    return null;
  }
  const closed = (window.__bcDirtyDialogs || []).filter(({ el }) => !visible(el) || (el.tagName === 'DIALOG' && !el.open)).map(({ name }) => name);
  delete window.__bcDirtyDialogs;
  return closed;
}
