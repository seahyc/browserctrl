// The text of the option a combobox highlights (its aria-activedescendant), or null when it
// says none: the keyboard's way through a list can then be read step by step.
({ selector }) => {
  const el = findDeep(selector);
  const own = el && ((el.shadowRoot && el.shadowRoot.querySelector('[role=combobox]')) || el);
  const id = own && own.getAttribute('aria-activedescendant');
  const r = own && own.getRootNode();
  const a = id && r && (r.getElementById ? r.getElementById(id) : null);
  return a ? (a.innerText || a.textContent || '').trim() : null;
}
