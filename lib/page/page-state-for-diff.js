// What a person would notice changed after a plan: controls by role and name with their
// state, headings, alerts and status lines, and result counts. Taken before and after a do
// plan; find.mjs diffPage compares the two.
() => {
  var kit = findKit(), all = kit.all, ours = kit.ours, clip = kit.clip, hiddenWhy = kit.hiddenWhy, opener = kit.opener, handle = kit.handle;
  var CTL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=slider],[role=dialog],[role=alertdialog],dialog[open]';
  var out = [], texts = [], n = 0;
  var COUNT = /\b\d[\d,.]*\+?\s+(results?|items?|jobs?|matches|products?|listings?|homes?|properties|places|stays|hotels?|flights?|cars?|vehicles|reviews?|found|events?|courses?|companies)\b|\b(of|showing)\s+\d[\d,.]*\b|\bno (results|matches)\b/i;
  all(document).forEach(function (el) {
    if (n > 2500 || ours(el)) return;
    var tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
    var isCtl = el.matches(CTL), isHead = /^H[1-3]$/.test(tag) || el.getAttribute('role') === 'heading';
    var live = el.matches('[role=alert],[role=status],[aria-live=assertive],[aria-live=polite]');
    if (!isCtl && !isHead && !live && !(el.children.length === 0 && el.textContent.length < 120 && COUNT.test(el.textContent))) return;
    if (el.matches('input[type=hidden]') || hiddenWhy(el)) return;
    n++;
    var role = accRole(el);
    if (tag === 'DIALOG') role = 'dialog';
    var name = clip(isCtl ? (accName(el) || el.innerText || el.textContent) : (el.innerText || el.textContent), 80);
    if (!isCtl) { if (name) texts.push({ kind: isHead ? 'heading' : live ? 'notice' : 'count', text: name }); return; }
    var st = {};
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (/^(checkbox|radio)$/.test(type)) st.checked = el.checked;
    else if (el.hasAttribute('aria-checked')) st.checked = el.getAttribute('aria-checked') === 'true';
    if (el.hasAttribute('aria-pressed')) st.pressed = el.getAttribute('aria-pressed') === 'true';
    if (el.hasAttribute('aria-expanded')) st.open = el.getAttribute('aria-expanded') === 'true';
    if (tag === 'SUMMARY' && el.parentElement) st.open = !!el.parentElement.open;
    if (el.hasAttribute('aria-selected')) st.selected = el.getAttribute('aria-selected') === 'true';
    if (tag === 'SELECT') st.value = clip(el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : '', 60);
    else if ((tag === 'INPUT' && !/^(checkbox|radio|button|submit|reset|image)$/.test(type)) || tag === 'TEXTAREA') st.value = clip(el.value, 60);
    else if (role === 'slider') st.value = el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow') || '';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') st.disabled = true;
    out.push({ role: role, name: name, st: st });
  });
  return { url: location.href, doc: performance.timeOrigin, title: document.title, controls: out, texts: texts.slice(0, 200) };
}
