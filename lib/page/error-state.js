// Signs that the page refused what the step sent: an "Error" title, an alert with error
// words, or a field marked invalid.
() => {
  // A message a field points to (aria-errormessage, aria-describedby) is that field's error in
  // any language; other alerts count when they read as one.
  const pointed = new Set();
  for (const f of document.querySelectorAll('input,select,textarea,[role=textbox],[role=combobox],[role=spinbutton]')) for (const a of ['aria-errormessage', 'aria-describedby']) for (const id of (f.getAttribute(a) || '').split(/\s+/)) if (id) pointed.add(id);
  const alerts = [...document.querySelectorAll('[role=alert],.error-summary,[class*=error-summary i],[aria-live=assertive]')]
    .filter(el => isShown(el) && !el.closest('[data-cdp]')).map(el => [el, (el.innerText || '').replace(/\s+/g, ' ').trim()])
    .filter(([el, t]) => t && t.length < 400 && ((el.id && pointed.has(el.id)) || /error|invalid|required|must|problem|please (enter|select|choose|provide)|try again|went wrong|cannot|can't be/i.test(t))).map(([, t]) => t);
  const invalid = [...document.querySelectorAll('[aria-invalid=true]')].filter(isShown).map(el => (el.getAttribute('aria-label') || el.name || el.id || el.tagName).toString().slice(0, 40));
  return { title: document.title, alerts: alerts.slice(0, 3), invalid: invalid.slice(0, 5) };
}
