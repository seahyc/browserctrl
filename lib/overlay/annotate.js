/* Shared annotation overlay.
 *
 * ONE implementation, two delivery paths:
 *   - injected by the daemon (Page.addScriptToEvaluateOnNewDocument)
 *   - loaded as a content script by the extension
 * Neither path may fork this file.
 *
 * The page posts annotations to the local bridge. It deliberately does not
 * know its own tab id: the bridge resolves that from the live tab list, and
 * enriches the annotation with a cropped screenshot, which a page cannot take
 * of itself.
 */
(function start() {
  if (window.__cdpOverlay) return;
  /* Registered for every new document, so this can run before <html> exists. */
  if (!document.documentElement) { document.addEventListener('DOMContentLoaded', start, { once: true }); return; }
  /* The extension's copy and the daemon's injected copy both run in isolated
   * worlds (different ones), so neither can see the other's globals. Without a shared
   * marker on the DOM they would both bind option+A and you would get two
   * overlays. First one in wins; the other stays dormant. */
  var root = document.documentElement;
  if (root && root.getAttribute('data-cdp-overlay')) return;
  if (root) root.setAttribute('data-cdp-overlay', (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) ? 'extension' : 'injected');

  var state = { on: false, hover: null, pending: 0, for: '', forActive: 0, forQuery: '' };
  var els = {};

  // ------------------------------------------------------------- identity --
  function testid(el) {
    var attrs = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute && el.getAttribute(attrs[i]);
      if (v) return { attr: attrs[i], value: v };
    }
    return null;
  }

  // The daemon prepends the page snapshot's accName and accRole, so recordings, annotations and
  // the snapshot name an element alike. The extension loads this file alone: its own
  // versions below stand in.
  function roleOf(el) {
    if (typeof accRole === 'function') return accRole(el);
    var explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      return ['checkbox', 'radio', 'file', 'submit', 'button'].indexOf(type) === -1 ? 'textbox' : type;
    }
    return tag;
  }

  function nameOf(el) {
    if (typeof accName === 'function') return accName(el).replace(/\s+/g, ' ').trim().slice(0, 120);
    var t = (el.getAttribute && el.getAttribute('aria-label')) || '';
    if (t.trim()) return t.trim();
    var own = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    if (own) return own.slice(0, 120);
    return ((el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt'))) || '').slice(0, 120);
  }

  // Several ways to find this element again, best first, so one going stale is
  // not fatal for the agent.
  function selectorsFor(el) {
    var out = [];
    var tid = testid(el);
    if (tid) out.push('[' + tid.attr + '=' + JSON.stringify(tid.value) + ']');
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) out.push('#' + CSS.escape(el.id));
    var name = nameOf(el);
    if (name && name.length < 60) {
      var role = roleOf(el);
      out.push('role=' + role + '[name="' + name + '"]');
    }
    // Structural path as the last resort.
    var path = [];
    var node = el;
    while (node && node.nodeType === 1 && path.length < 6) {
      var part = node.tagName.toLowerCase();
      if (node.parentElement) {
        var sibs = Array.prototype.filter.call(node.parentElement.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      path.unshift(part);
      node = node.parentElement;
      if (node && node.id) {
        path.unshift('#' + CSS.escape(node.id));
        break;
      }
    }
    out.push(path.join(' > '));
    return out;
  }

  // ----------------------------------------------------------------- chrome --
  function style(el, css) {
    for (var k in css) el.style[k] = css[k];
  }

  function build() {
    els.box = document.createElement('div');
    style(els.box, {
      position: 'fixed', pointerEvents: 'none', zIndex: 2147483646, border: '2px solid #2f6feb',
      background: 'rgba(47,111,235,0.12)', borderRadius: '3px', display: 'none', transition: 'all 40ms linear',
    });

    els.label = document.createElement('div');
    style(els.label, {
      position: 'fixed', pointerEvents: 'none', zIndex: 2147483647, background: '#2f6feb', color: '#fff',
      font: '12px ui-monospace, SFMono-Regular, Menlo, monospace', padding: '2px 6px', borderRadius: '3px',
      display: 'none', maxWidth: '60vw', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    });

    els.badge = document.createElement('div');
    style(els.badge, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647, background: '#111',
      color: '#fff', font: '13px ui-sans-serif, system-ui, sans-serif', padding: '8px 12px',
      borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,0.3)', display: 'none', cursor: 'default',
    });

    els.noteWrap = document.createElement('div');
    style(els.noteWrap, {
      position: 'fixed', zIndex: 2147483647, background: '#fff', border: '1px solid #d0d7de',
      borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: '10px', display: 'none', width: '320px',
    });
    els.noteWrap.innerHTML =
      '<div style="font:12px ui-sans-serif,system-ui;color:#57606a;margin-bottom:6px" data-cdp="target"></div>' +
      '<textarea data-cdp="note" rows="3" placeholder="What should the agent do here?" ' +
      'style="width:100%;box-sizing:border-box;font:13px ui-sans-serif,system-ui;border:1px solid #d0d7de;border-radius:6px;padding:6px"></textarea>' +
      '<div style="margin-top:8px;font:12px ui-sans-serif,system-ui;color:#57606a;position:relative">Send to ' +
      '<span data-cdp="for-btn" tabindex="0" role="combobox" aria-haspopup="listbox" aria-expanded="false" ' +
      'style="display:inline-flex;align-items:center;gap:6px;max-width:236px;padding:3px 8px;border:1px solid #d0d7de;' +
      'border-radius:6px;background:#f6f8fa;color:#111;cursor:pointer;font:12px ui-sans-serif,system-ui;vertical-align:middle">' +
      '<span data-cdp="for-label" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">your most recent task</span>' +
      '<span style="color:#8c959f">▾</span></span>' +
      '</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">' +
      '<button data-cdp="cancel" style="font:13px ui-sans-serif,system-ui;padding:4px 10px">Cancel</button>' +
      '<button data-cdp="save" style="font:13px ui-sans-serif,system-ui;padding:4px 10px;background:#2f6feb;color:#fff;border:0;border-radius:6px">Save (⌘⏎)</button>' +
      '</div>';

    els.pinCard = document.createElement('div');
    style(els.pinCard, {
      position: 'fixed', zIndex: 2147483647, background: '#fff', color: '#111', border: '1px solid #d0d7de',
      borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: '10px', display: 'none', width: '300px',
    });
    els.pinCard.addEventListener('click', function (e) {
      if (!e.isTrusted) return;
      var what = e.target.getAttribute && e.target.getAttribute('data-cdp');
      if (what === 'close') els.pinCard.style.display = 'none';
      if (what === 'resolve') {
        var pin = els.pinCard.__pin;
        els.pinCard.style.display = 'none';
        ask({ kind: 'resolve', id: pin.id, url: location.href }, function () { refreshPins(); });
        pins = pins.filter(function (p) { return p.id !== pin.id; });
        renderPins();
      }
    });

    /* A sibling of the card, not a child of it. Inside the card it shared a
     * stacking context with the Cancel and Save buttons, which come later in
     * the DOM and so painted over the first option in the list. */
    els.forMenu = document.createElement('div');
    els.forMenu.setAttribute('data-cdp', 'for-menu');
    els.forMenu.setAttribute('role', 'listbox');
    style(els.forMenu, {
      display: 'none', position: 'fixed', left: '0', top: '0', width: '300px', maxHeight: '264px',
      overflow: 'auto', background: '#fff', border: '1px solid #d0d7de', borderRadius: '8px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: '4px', zIndex: 2147483647,
    });
    els.forMenu.innerHTML =
      '<input data-cdp="for-search" type="search" placeholder="Search agent or task…" ' +
      'aria-label="Search agents" style="width:100%;box-sizing:border-box;margin:0 0 4px;padding:6px 8px;' +
      'border:1px solid #d0d7de;border-radius:6px;font:12px ui-sans-serif,system-ui">' +
      '<div data-cdp="for-options"></div>';
    els.forMenu.addEventListener('input', function (e) {
      if (!e.target || e.target.getAttribute('data-cdp') !== 'for-search') return;
      state.forQuery = e.target.value;
      state.forActive = 0;
      renderForMenu();
    });

    [els.box, els.label, els.badge, els.noteWrap, els.pinCard, els.forMenu].forEach(function (n) {
      document.documentElement.appendChild(n);
    });

    wireForMenu();
  }

  function setBadge(text, show) {
    els.badge.textContent = text;
    els.badge.style.display = show ? 'block' : 'none';
  }

  // ----------------------------------------------------------------- modes --
  function onMove(e) {
    if (!state.on || els.noteWrap.style.display === 'block') return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === els.box || el === els.label || els.noteWrap.contains(el)) return;
    state.hover = el;
    var r = el.getBoundingClientRect();
    style(els.box, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    els.label.textContent = roleOf(el) + (nameOf(el) ? ' · ' + nameOf(el).slice(0, 60) : '');
    style(els.label, { display: 'block', left: r.left + 'px', top: Math.max(0, r.top - 20) + 'px' });
  }

  function onClick(e) {
    if (!e.isTrusted) return; /* the page shares our DOM and could synthesise clicks; only the human's count */
    if (!state.on || els.noteWrap.style.display === 'block') return;
    e.preventDefault();
    e.stopPropagation();
    openNote(state.hover || e.target, e.clientX, e.clientY);
  }

  function openNote(el, x, y) {
    var r = el.getBoundingClientRect();
    els.noteWrap.querySelector('[data-cdp="target"]').textContent = roleOf(el) + ' · ' + (nameOf(el) || '(no name)').slice(0, 60);
    style(els.noteWrap, {
      display: 'block',
      left: Math.min(x, window.innerWidth - 340) + 'px',
      top: Math.min(y + 8, window.innerHeight - 160) + 'px',
    });
    // Offer the live agent sessions, so a note can be aimed at one rather than
    // going to every agent on the machine.
    refreshPins();
    renderForMenu();

    var ta = els.noteWrap.querySelector('[data-cdp="note"]');
    ta.value = '';
    ta.focus();
    els.noteWrap.__el = el;
    els.noteWrap.__box = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function closeNote() {
    els.noteWrap.style.display = 'none';
    els.noteWrap.__el = null;
    closeForMenu();
  }

  /* --------------------------------------------------------- agent picker --
   * A native <select> renders as the OS menu: it cannot show a session's
   * branch and idleness on a second line, it ignores the card's styling, and
   * on a page this dense it reads as a browser control rather than part of the
   * annotation. This is a listbox with the same keyboard contract.
   */
  function forEls() {
    return {
      btn: els.noteWrap.querySelector('[data-cdp="for-btn"]'),
      label: els.noteWrap.querySelector('[data-cdp="for-label"]'),
      menu: els.forMenu,
      search: els.forMenu.querySelector('[data-cdp="for-search"]'),
      options: els.forMenu.querySelector('[data-cdp="for-options"]'),
    };
  }

  function allForChoices() {
    var out = [];
    (state.sessions || []).forEach(function (sess) {
      out.push({
        id: sess.id,
        name: sess.name,
        meta: (sess.client || '') + (sess.lastChatMs > 120000 ? ' · chatted ' + Math.round(sess.lastChatMs / 60000) + 'm ago' : ' · chatting now'),
      });
    });
    // Broadcast is deliberately last. It remains available without being the
    // accidental default for a note that clearly belongs to one task.
    out.push({ id: '__all__', name: 'All active agents', meta: 'Broadcast — everyone can see this' });
    return out;
  }

  function forChoices() {
    var out = allForChoices();
    var query = String(state.forQuery || '').toLowerCase().trim();
    return query ? out.filter(function (c) { return (c.name + ' ' + c.meta).toLowerCase().indexOf(query) !== -1; }) : out;
  }

  function renderForMenu() {
    var f = forEls();
    var choices = forChoices();
    var all = allForChoices();
    // Default to the most recently chatted task, never the broadcast option.
    // Search only affects what is shown, not the selection already made.
    var stillThere = all.some(function (c) { return c.id === state.for; });
    if (!stillThere) state.for = (state.sessions && state.sessions[0] && state.sessions[0].id) || '__all__';
    var chosen = all.filter(function (c) { return c.id === state.for; })[0] || all[0];
    f.label.textContent = chosen.name;
    f.options.innerHTML = '';
    choices.forEach(function (c, i) {
      var row = document.createElement('div');
      row.setAttribute('role', 'option');
      row.setAttribute('data-cdp', 'for-option');
      row.setAttribute('data-id', c.id);
      row.setAttribute('aria-selected', c.id === state.for ? 'true' : 'false');
      style(row, {
        padding: '6px 8px', borderRadius: '6px', cursor: 'pointer',
        font: '12px ui-sans-serif, system-ui, sans-serif', color: '#111',
        background: i === state.forActive ? '#eef2f8' : 'transparent',
      });
      row.innerHTML =
        '<div style="display:flex;gap:6px;align-items:baseline">' +
        '<span style="color:#2f6feb;width:10px;flex:none">' + (c.id === state.for ? '✓' : '') + '</span>' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(c.name) + '</span></div>' +
        '<div style="margin-left:16px;color:#8c959f">' + escapeHtml(c.meta) + '</div>';
      f.options.appendChild(row);
    });
    if (!choices.length) f.options.innerHTML = '<div style="padding:8px;color:#57606a;font:12px ui-sans-serif,system-ui">No matching agent session</div>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function openForMenu() {
    var f = forEls();
    var choices = forChoices();
    state.forActive = Math.max(0, choices.map(function (c) { return c.id; }).indexOf(state.for));
    renderForMenu();
    f.menu.style.display = 'block';
    f.btn.setAttribute('aria-expanded', 'true');
    placeForMenu();
    var active = f.options.children[state.forActive];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
    f.search.focus();
  }

  /* The note card can sit anywhere the human clicked, including a few pixels
   * from the top of the window, so the menu cannot simply open upwards: it
   * would render off-screen and clipped. Measure, then choose a side. */
  function placeForMenu() {
    var f = forEls();
    var anchor = f.btn.getBoundingClientRect();
    var gap = 6;
    var height = Math.min(f.menu.scrollHeight + 8, 264);
    var below = window.innerHeight - anchor.bottom - gap;
    var above = anchor.top - gap;
    var openDown = below >= height || below >= above;
    var top = openDown ? anchor.bottom + gap : Math.max(4, anchor.top - gap - height);
    var maxH = Math.max(96, Math.min(264, openDown ? below - 4 : above - 4));
    style(f.menu, {
      left: Math.max(4, Math.min(anchor.left, window.innerWidth - 308)) + 'px',
      top: Math.max(4, Math.min(top, window.innerHeight - 40)) + 'px',
      maxHeight: maxH + 'px',
    });
  }

  function closeForMenu() {
    var f = forEls();
    if (!f.menu) return;
    f.menu.style.display = 'none';
    f.btn.setAttribute('aria-expanded', 'false');
  }

  function forMenuOpen() {
    var f = forEls();
    return Boolean(f.menu && f.menu.style.display === 'block');
  }

  function moveForActive(delta) {
    var count = forChoices().length;
    state.forActive = (state.forActive + delta + count) % count;
    renderForMenu();
    var f = forEls();
    var active = f.options.children[state.forActive];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function commitForActive() {
    var choices = forChoices();
    var pick = choices[state.forActive] || choices[0];
    state.for = pick.id;
    closeForMenu();
    renderForMenu();
    forEls().btn.focus();
  }

  function wireForMenu() {
    // The button lives in the card and the list is a sibling of it, so both
    // nodes carry the same handlers.
    [els.noteWrap, els.forMenu].forEach(function (node) {
      node.addEventListener('mousedown', onForMouseDown);
      node.addEventListener('mousemove', onForMouseMove);
      node.addEventListener('keydown', onForKeyDown, true);
    });
  }

  function onForMouseDown(e) {
    if (!e.isTrusted) return;
    var hit = e.target.closest ? e.target.closest('[data-cdp="for-btn"],[data-cdp="for-option"]') : null;
    if (!hit) {
      if (forMenuOpen()) closeForMenu();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (hit.getAttribute('data-cdp') === 'for-btn') {
      if (forMenuOpen()) closeForMenu();
      else openForMenu();
      return;
    }
    state.for = hit.getAttribute('data-id') || '';
    closeForMenu();
    renderForMenu();
  }

  function onForMouseMove(e) {
    if (!forMenuOpen()) return;
    var row = e.target.closest ? e.target.closest('[data-cdp="for-option"]') : null;
    if (!row) return;
    var rows = Array.prototype.slice.call(forEls().options.children);
    var i = rows.indexOf(row);
    if (i !== -1 && i !== state.forActive) {
      state.forActive = i;
      renderForMenu();
    }
  }

  // The picker owns these keys only while it is open, so the note textarea keeps
  // its own arrow keys and ⌘⏎ the rest of the time.
  function onForKeyDown(e) {
    if (!e.isTrusted) return;
    var onBtn = e.target && e.target.getAttribute && e.target.getAttribute('data-cdp') === 'for-btn';
    var onSearch = e.target && e.target.getAttribute && e.target.getAttribute('data-cdp') === 'for-search';
    if (!forMenuOpen()) {
      if (onBtn && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
        e.preventDefault();
        e.stopPropagation();
        openForMenu();
      }
      return;
    }
    if (onSearch && !['ArrowDown', 'ArrowUp', 'Escape', 'Enter'].includes(e.key)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      moveForActive(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      commitForActive();
    } else if (e.key === 'Escape') {
      // Escape closes the picker, not the whole note.
      e.preventDefault();
      e.stopPropagation();
      closeForMenu();
      forEls().btn.focus();
    }
  }

  function save() {
    var el = els.noteWrap.__el;
    if (!el) return;
    var note = els.noteWrap.querySelector('[data-cdp="note"]').value.trim();
    var payload = {
      note: note,
      for: state.for === '__all__' ? null : state.for,
      page: { url: location.href, title: document.title },
      element: {
        role: roleOf(el),
        name: nameOf(el),
        testid: (testid(el) || {}).value || null,
        selectors: selectorsFor(el),
        box: els.noteWrap.__box,
        html: (el.outerHTML || '').slice(0, 600),
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      },
    };
    closeNote();
    post('/annotations', payload).then(function (result) {
      state.pending += 1;
      if (result && result.queued) {
        setBadge('saved safely · waiting for the cdp bridge', true);
      } else {
        setBadge('saved for the agent · send “review my browser handoff” in Codex', true);
        setTimeout(refreshPins, 600);
      }
    });
  }

  /* Transport: the extension's background worker, or __cdpSend, a CDP binding
   * installed by the daemon (instant, and immune to the Local Network Access
   * rules that stop an HTTPS page from reaching loopback). There is no fetch to
   * the bridge from here: the bridge needs a token, and this script runs where
   * the page's own scripts could read one. The daemon and the extension hold
   * the token; the page holds none. */
  /* Ask the other side for something and get an answer back. The extension can
   * reply directly; the injected path answers by calling back into
   * window.__cdpOverlay, because a CDP binding is one-way. */
  function ask(envelope, cb) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage(envelope, function (res) {
          void chrome.runtime.lastError;
          if (cb) cb(res);
        });
        return;
      } catch (e) { /* fall through */ }
    }
    if (typeof window.__cdpSend === 'function') {
      try { window.__cdpSend(JSON.stringify(envelope)); return; } catch (e) { /* fall through */ }
    }
    /* no transport: pins simply do not show */
  }

  function post(path, payload) {
    var envelope = { kind: 'annotation', path: path, payload: payload };
    window.__cdpOutbox = window.__cdpOutbox || [];
    window.__cdpOutbox.push(envelope);
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      // Extension delivery: the background worker owns the loopback call, so
      // the page's CSP and the Local Network Access rules never come into it.
      try {
        return new Promise(function (resolve) {
          chrome.runtime.sendMessage(envelope, function (res) {
            void chrome.runtime.lastError;
            resolve(res || { ok: false, queued: true });
          });
        });
      } catch (e) {
        /* fall through */
      }
    }
    if (typeof window.__cdpSend === 'function') {
      try {
        window.__cdpSend(JSON.stringify(envelope));
        return Promise.resolve();
      } catch (e) {
        /* fall through to fetch */
      }
    }
    // Not fatal: the payload stays in __cdpOutbox.
    setBadge('saved locally, waiting for the agent to collect', true);
    return Promise.resolve();
  }

  function enable() {
    state.on = true;
    state.pending = 0;
    document.documentElement.style.cursor = 'crosshair';
    setBadge('annotate mode · click an element · esc to finish', true);
  }

  function disable() {
    state.on = false;
    document.documentElement.style.cursor = '';
    els.box.style.display = 'none';
    els.label.style.display = 'none';
    closeNote();
    if (state.pending) {
      setBadge(state.pending + ' annotation' + (state.pending === 1 ? '' : 's') + ' handed to the agent', true);
      setTimeout(function () {
        setBadge('', false);
      }, 2500);
    } else setBadge('', false);
  }

  function toggle() {
    if (state.on) disable();
    else enable();
  }

  build();

  var placeQueued = false;
  function queuePlace() {
    if (placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(function () {
      placeQueued = false;
      placePins();
    });
  }
  window.addEventListener('scroll', queuePlace, true);
  window.addEventListener('resize', queuePlace, true);

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', function (e) {
    if (!e.isTrusted) return;
    // Option+A toggles. Chosen because it is free in every app we care about.
    if (e.altKey && (e.key === 'a' || e.key === 'å')) {
      e.preventDefault();
      toggle();
      return;
    }
    if (!state.on) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (els.noteWrap.style.display === 'block') closeNote();
      else disable();
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && els.noteWrap.style.display === 'block') {
      e.preventDefault();
      save();
    }
  }, true);

  // Show what is already on this page as soon as we load.
  setTimeout(refreshPins, 400);

  els.noteWrap.addEventListener('click', function (e) {
    if (!e.isTrusted) return;
    var what = e.target.getAttribute && e.target.getAttribute('data-cdp');
    if (what === 'save') save();
    if (what === 'cancel') closeNote();
  });

  /* ----------------------------------------------------------------- pins --
   * Existing annotations, shown in place. Without these you cannot see what
   * you already said, which is the whole point of leaving a note on a page.
   */
  var pins = [];
  var pinEls = [];

  function anchorFor(pin) {
    var sels = (pin.element && pin.element.selectors) || [];
    var want = pin.element || {};
    for (var i = 0; i < sels.length; i++) {
      var sel = sels[i];
      if (sel.indexOf('role=') === 0) continue; // not a real CSS selector
      var el = null;
      try {
        el = document.querySelector(sel);
      } catch (e) { /* a stored selector may be invalid on this page */ }
      if (!el) continue;
      // A structural path can match a different element after the page
      // changes. Anchoring to the wrong element is worse than admitting the
      // original is gone, so the identity has to agree too.
      var sameRole = !want.role || roleOf(el) === want.role;
      var sameName = !want.name || nameOf(el).slice(0, 60) === String(want.name).slice(0, 60);
      if (sameRole && sameName) return el;
    }
    return null;
  }

  function placePins() {
    for (var i = 0; i < pinEls.length; i++) {
      var node = pinEls[i];
      var el = node.__anchor;
      if (el && el.isConnected) {
        var r = el.getBoundingClientRect();
        node.style.display = r.width || r.height ? 'flex' : 'none';
        node.style.left = Math.max(2, r.left - 10) + 'px';
        node.style.top = Math.max(2, r.top - 10) + 'px';
        node.__moved = false;
      } else {
        // The element is gone. Keep the note reachable rather than dropping it.
        var box = node.__pin.element && node.__pin.element.box;
        var scroll = (node.__pin.element && node.__pin.element.scroll) || { x: 0, y: 0 };
        node.style.display = 'flex';
        node.style.left = Math.max(2, (box ? box.x + scroll.x - window.scrollX : 8)) + 'px';
        node.style.top = Math.max(2, (box ? box.y + scroll.y - window.scrollY : 8)) + 'px';
        node.style.background = '#8250df';
        node.title = 'the element this was attached to is gone';
        node.__moved = true;
      }
    }
  }

  function openPin(node) {
    var pin = node.__pin;
    var r = node.getBoundingClientRect();
    els.pinCard.innerHTML =
      '<div style="font:12px ui-sans-serif,system-ui;color:#57606a" data-cdp="meta"></div>' +
      '<div style="font:14px ui-sans-serif,system-ui;margin:6px 0 10px;white-space:pre-wrap" data-cdp="note"></div>' +
      '<div style="display:flex;gap:8px;justify-content:space-between;align-items:center">' +
      '<span style="font:11px ui-monospace,Menlo,monospace;color:#8250df" data-cdp="warn"></span>' +
      '<span><button data-cdp="close" style="font:12px ui-sans-serif,system-ui;padding:3px 8px">Close</button> ' +
      '<button data-cdp="resolve" style="font:12px ui-sans-serif,system-ui;padding:3px 8px;background:#1a7f37;color:#fff;border:0;border-radius:6px">Resolve</button></span>' +
      '</div>';
    els.pinCard.querySelector('[data-cdp="meta"]').textContent =
      (pin.element ? pin.element.role + ' · ' + (pin.element.name || '').slice(0, 50) : 'page') +
      (pin.for ? '  → ' + pin.for : '  → any agent') +
      (pin.consumed ? '  · seen' : '');
    els.pinCard.querySelector('[data-cdp="note"]').textContent = pin.note || '(no note)';
    els.pinCard.querySelector('[data-cdp="warn"]').textContent = node.__moved ? 'element no longer on the page' : '';
    els.pinCard.__pin = pin;
    style(els.pinCard, {
      display: 'block',
      left: Math.min(r.left, window.innerWidth - 320) + 'px',
      top: Math.min(r.bottom + 6, window.innerHeight - 140) + 'px',
    });
  }

  function renderPins() {
    pinEls.forEach(function (n) { n.remove(); });
    pinEls = [];
    pins.forEach(function (pin, i) {
      var node = document.createElement('div');
      node.textContent = String(i + 1);
      style(node, {
        position: 'fixed', zIndex: 2147483645, width: '20px', height: '20px', borderRadius: '50% 50% 50% 2px',
        background: pin.consumed ? '#6e7781' : '#d1242f', color: '#fff', font: '11px ui-sans-serif, system-ui', display: 'flex',
        alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
      });
      node.__pin = pin;
      node.__anchor = anchorFor(pin);
      node.addEventListener('click', function (e) {
        if (!e.isTrusted) return;
        e.preventDefault();
        e.stopPropagation();
        openPin(node);
      }, true);
      node.addEventListener('mouseenter', function () { node.style.transform = 'scale(1.15)'; });
      node.addEventListener('mouseleave', function () { node.style.transform = ''; });
      document.documentElement.appendChild(node);
      pinEls.push(node);
    });
    placePins();
    var unread = pins.filter(function (p) { return !p.consumed; }).length;
    setBadge(
      pins.length
        ? pins.length + ' annotation' + (pins.length === 1 ? '' : 's') + ' on this page' +
          (unread < pins.length ? ' (' + (pins.length - unread) + ' already read)' : '') + ' · option+A to add'
        : '',
      pins.length > 0 && !state.on,
    );
  }

  function refreshPins() {
    ask({ kind: 'pins-request', url: location.href, route: '/api/annotations' }, function (res) {
      if (res && res.pins) window.__cdpOverlay.setPins(res.pins, res.sessions);
    });
  }

  // The extension's shortcut talks to us by message, not by injecting script:
  // injecting would need host permissions for every site, which this extension
  // deliberately does not ask for.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
      if (!msg || msg.kind !== 'command') return;
      if (msg.command === 'toast') {
        setBadge(msg.text, true);
        setTimeout(function () { setBadge('', false); refreshPins(); }, 2600);
      }
      if (msg.command === 'toggle-annotate') toggle();
      if (msg.command === 'enable') enable();
      if (msg.command === 'disable') disable();
      respond({ on: state.on });
      return true;
    });
  }

  // Programmatic surface, used by the extension and by the tests.
  window.__cdpOverlay = {
    setPins: function (rows, sessions) {
      pins = Array.isArray(rows) ? rows : [];
      if (sessions) state.sessions = sessions;
      if (els.noteWrap.style.display === 'block') renderForMenu();
      renderPins();
      return pins.length;
    },
    refreshPins: refreshPins,
    pins: function () { return pins; },
    toggle: toggle,
    enable: enable,
    disable: disable,
    isOn: function () {
      return state.on;
    },
    // Capture without pointing a mouse: the headless tests drive this.
    capture: function (selector, note) {
      var el = document.querySelector(selector);
      if (!el) return Promise.reject(new Error('no element for ' + selector));
      var r = el.getBoundingClientRect();
      els.noteWrap.__el = el;
      els.noteWrap.__box = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      els.noteWrap.querySelector('[data-cdp="note"]').value = note || '';
      els.noteWrap.style.display = 'block';
      save();
      return Promise.resolve(true);
    },
    identity: function (selector) {
      var el = document.querySelector(selector);
      return el ? { role: roleOf(el), name: nameOf(el), selectors: selectorsFor(el) } : null;
    },
  };
})();
