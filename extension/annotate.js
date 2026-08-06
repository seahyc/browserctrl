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
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">' +
      '<button data-cdp="cancel" style="font:13px ui-sans-serif,system-ui;padding:4px 10px">Cancel</button>' +
      '<button data-cdp="save" style="font:13px ui-sans-serif,system-ui;padding:4px 10px;background:#2f6feb;color:#fff;border:0;border-radius:6px">Save (⌘⏎)</button>' +
      '</div>';

    [els.box, els.label, els.badge, els.noteWrap].forEach(function (n) {
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

  els.noteWrap.addEventListener('click', function (e) {
    var what = e.target.getAttribute && e.target.getAttribute('data-cdp');
    if (what === 'save') save();
    if (what === 'cancel') closeNote();
  });

  // Programmatic surface, used by the extension and by the tests.
  window.__cdpOverlay = {
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
