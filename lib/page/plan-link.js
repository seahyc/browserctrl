// Plans follow ordinary new-tab links in their own claimed tab.
({ selector }) => {
  const el = findDeep(selector)?.closest('a[href]');
  return el?.target.toLowerCase() === '_blank' && /^https?:$/.test(new URL(el.href).protocol) ? el.href : null;
}
