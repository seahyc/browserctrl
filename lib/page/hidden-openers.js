// Diagnostic suggestions only: ambiguous local disclosures are never auto-clicked.
({ pattern }) => {
  const kit = findKit(), re = new RegExp(pattern, 'i'), names = new Set();
  for (const el of kit.all(document)) {
    if (!el.matches('input,textarea,select,[role=combobox]') || !kit.hiddenWhy(el) || !re.test(accName(el) || el.getAttribute('placeholder') || '')) continue;
    for (let region = kit.up(el); region && region !== document.body; region = kit.up(region)) {
      if (!region.matches('header,form,[role=search],[role=group]')) continue;
      for (const control of region.querySelectorAll('summary,button,[role=button],[aria-expanded],[aria-controls]')) {
        if (control.contains(el) || kit.hiddenWhy(control)) continue;
        const name = kit.clip(accName(control) || control.innerText || control.textContent, 60);
        if (name) names.add(name);
      }
      if (names.size) break;
    }
  }
  return [...names].slice(0, 4);
}
