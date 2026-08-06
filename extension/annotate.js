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
(function () {
  if (window.__cdpOverlay) return;
  /* The extension's copy runs in an isolated world and the injected copy in the
   * page world, so neither can see the other's globals. Without a shared
   * marker on the DOM they would both bind option+A and you would get two
   * overlays. First one in wins; the other stays dormant. */
  var root = document.documentElement;
  if (root && root.getAttribute('data-cdp-overlay')) return;
  if (root) root.setAttribute('data-cdp-overlay', (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) ? 'extension' : 'injected');

  var BRIDGE = window.__cdpBridge || 'http://127.0.0.1:17222';
  var state = { on: false, hover: null, pending: 0 };
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

  function roleOf(el) {
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
      '<div style="margin-top:6px;font:12px ui-sans-serif,system-ui;color:#57606a">for ' +
      '<select data-cdp="for" style="font:12px ui-sans-serif,system-ui;max-width:230px"><option value="">any agent</option></select></div>' +
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

    [els.box, els.label, els.badge, els.noteWrap, els.pinCard].forEach(function (n) {
      document.documentElement.appendChild(n);
    });
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
    var sel = els.noteWrap.querySelector('[data-cdp="for"]');
    var chosen = sel.value;
    sel.innerHTML = '<option value="">any agent</option>';
    (state.sessions || []).forEach(function (sess) {
      var opt = document.createElement('option');
      opt.value = sess.id;
      opt.textContent = sess.name + (sess.idleMs > 120000 ? ' (idle)' : '');
      sel.appendChild(opt);
    });
    sel.value = chosen || '';

    var ta = els.noteWrap.querySelector('[data-cdp="note"]');
    ta.value = '';
    ta.focus();
    els.noteWrap.__el = el;
    els.noteWrap.__box = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function closeNote() {
    els.noteWrap.style.display = 'none';
    els.noteWrap.__el = null;
  }

  function save() {
    var el = els.noteWrap.__el;
    if (!el) return;
    var note = els.noteWrap.querySelector('[data-cdp="note"]').value.trim();
    var payload = {
      note: note,
      for: (els.noteWrap.querySelector('[data-cdp="for"]') || {}).value || null,
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
    post('/annotations', payload).then(function () {
      state.pending += 1;
      setBadge('annotate mode · ' + state.pending + ' saved · esc to finish', true);
      setTimeout(refreshPins, 600);
    });
  }

  /* Transport, in order of reliability:
   *   1. __cdpSend, a CDP binding installed by the daemon. Instant, and immune
   *      to the Local Network Access rules that stop an HTTPS page from
   *      reaching loopback in current Chromium.
   *   2. fetch to the bridge, for pages served from loopback itself and for
   *      the extension, which is exempt.
   *   3. an in-page queue the daemon can drain, so nothing is ever lost.
   */
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
    fetch(BRIDGE + (envelope.route || '/api/annotations') + '?url=' + encodeURIComponent(location.href))
      .then(function (r) { return r.json(); })
      .then(function (rows) { if (cb) cb({ pins: rows }); })
      .catch(function () { /* offline: pins simply do not show */ });
  }

  function post(path, payload) {
    var envelope = { kind: 'annotation', path: path, payload: payload };
    window.__cdpOutbox = window.__cdpOutbox || [];
    window.__cdpOutbox.push(envelope);
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      // Extension delivery: the background worker owns the loopback call, so
      // the page's CSP and the Local Network Access rules never come into it.
      try {
        chrome.runtime.sendMessage(envelope);
        return Promise.resolve();
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
    return fetch(BRIDGE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(function () {
      // Not fatal: the payload is in __cdpOutbox and the daemon drains it.
      setBadge('saved locally, waiting for the agent to collect', true);
    });
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
