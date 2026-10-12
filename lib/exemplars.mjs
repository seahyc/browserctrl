// Endpoint exemplars: what a site's own frontend calls, captured from tabs the
// daemon is attached to, so an agent can replace a slow UI flow with a recipe.
//
// One gzipped JSON file per host. Requests are grouped by endpoint template
// (method + path with ids normalized + sorted query keys) and only the last few
// complete exemplars are kept, so size grows with distinct endpoints, not usage.
// Exemplars keep real headers and tokens: they are local, mode 0600 and never
// part of a recipe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const KEEP = 3;
const MAX_ENDPOINTS = 500;
const MAX_BODY = 256 * 1024;
const FLUSH_MS = 2000;
const CAPTURED_TYPES = new Set(['XHR', 'Fetch']);
const TEXTUAL = /json|text|javascript|xml|x-www-form-urlencoded/i;

export const exemplarDir = () => process.env.BROWSERCTRL_EXEMPLARS || path.join(os.homedir(), '.local/share/browserctrl/exemplars');
export const captureEnabled = () => process.env.BROWSERCTRL_CAPTURE !== '0';

// Ids vary per call; names do not. Normalizing them is what turns thousands of
// requests into a short endpoint catalog.
function segment(s) {
  if (/^\d+$/.test(s)) return '{n}';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return '{uuid}';
  if (/^[0-9a-f]{16,}$/i.test(s)) return '{hex}';
  if (s.length >= 20 && /\d/.test(s) && /[a-z]/i.test(s) && !/[-_.]/.test(s)) return '{id}';
  return s;
}

export function endpointOf(method, rawUrl) {
  const url = new URL(rawUrl);
  const keys = [...new Set(url.searchParams.keys())].sort();
  const template = `${method} ${url.pathname.split('/').map(segment).join('/')}${keys.length ? `?${keys.join('&')}` : ''}`;
  return { host: url.host, template };
}

const clip = s => (typeof s === 'string' && s.length > MAX_BODY ? s.slice(0, MAX_BODY) : s);

export function createStore(dir = exemplarDir()) {
  const hosts = new Map();
  const dirty = new Set();
  let timer = null;
  const file = host => path.join(dir, `${host.replace(/[^a-z0-9.-]/gi, '_')}.json.gz`);

  function load(host) {
    if (!hosts.has(host)) {
      let data = { host, endpoints: {} };
      try { data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file(host))).toString()); } catch {}
      hosts.set(host, data);
    }
    return hosts.get(host);
  }

  function flush() {
    timer = null;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const host of dirty) {
      const tmp = `${file(host)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(hosts.get(host))), { mode: 0o600 });
      fs.renameSync(tmp, file(host));
    }
    dirty.clear();
  }

  function record(entry) {
    const { host, template } = endpointOf(entry.method, entry.url);
    const data = load(host);
    const now = new Date().toISOString();
    const ep = data.endpoints[template] ||= { count: 0, firstSeen: now, exemplars: [] };
    ep.count++;
    ep.lastSeen = now;
    ep.exemplars.push({ at: now, ...entry, requestBody: clip(entry.requestBody), responseBody: clip(entry.responseBody) });
    if (ep.exemplars.length > KEEP) ep.exemplars.splice(0, ep.exemplars.length - KEEP);
    const names = Object.keys(data.endpoints);
    if (names.length > MAX_ENDPOINTS) {
      names.sort((a, b) => data.endpoints[a].lastSeen.localeCompare(data.endpoints[b].lastSeen));
      for (const old of names.slice(0, names.length - MAX_ENDPOINTS)) delete data.endpoints[old];
    }
    dirty.add(host);
    timer ||= setTimeout(flush, FLUSH_MS);
    timer.unref?.();
  }

  // Endpoint list for a host: what was called, how often, when, and from which page.
  function catalog(host) {
    const data = load(host);
    return Object.entries(data.endpoints)
      .map(([template, ep]) => {
        const last = ep.exemplars.at(-1) || {};
        return { template, count: ep.count, lastSeen: ep.lastSeen, status: last.status, mimeType: last.mimeType, page: last.page };
      })
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  function exemplars(host, match) {
    const data = load(host);
    return Object.entries(data.endpoints)
      .filter(([template]) => !match || template.includes(match))
      .map(([template, ep]) => ({ template, ...ep }));
  }

  function hostsOnDisk() {
    try { return fs.readdirSync(dir).filter(f => f.endsWith('.json.gz')).map(f => f.slice(0, -8)).sort(); } catch { return []; }
  }

  return { record, catalog, exemplars, hosts: hostsOnDisk, flush: () => { if (timer) clearTimeout(timer); flush(); } };
}

// Turns a tab's Network events into exemplars. `getBody` fetches a finished
// response body. Only fetch/XHR traffic with textual bodies is kept; nothing
// here sends requests or reloads pages.
export function createCapture({ store = createStore(), getBody }) {
  const inflight = new Map();
  return {
    store,
    onEvent(method, p, sessionId) {
      if (!captureEnabled()) return;
      if (method === 'Network.requestWillBeSent') {
        if (!CAPTURED_TYPES.has(p.type) || !/^https?:/.test(p.request.url)) return;
        if (inflight.size > 1000) inflight.clear();
        inflight.set(p.requestId, {
          method: p.request.method, url: p.request.url, page: p.documentURL, type: p.type,
          requestHeaders: { ...p.request.headers, ...inflight.get(p.requestId)?.extra },
          requestBody: p.request.postData,
        });
      } else if (method === 'Network.requestWillBeSentExtraInfo') {
        // Carries the cookies and headers the browser added after JS built the request.
        const row = inflight.get(p.requestId);
        if (row) Object.assign(row.requestHeaders, p.headers);
        else inflight.set(p.requestId, { extra: p.headers });
      } else if (method === 'Network.responseReceived') {
        const row = inflight.get(p.requestId);
        if (row?.url) Object.assign(row, { status: p.response.status, mimeType: p.response.mimeType, responseHeaders: p.response.headers });
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const row = inflight.get(p.requestId);
        inflight.delete(p.requestId);
        if (!row?.url || method === 'Network.loadingFailed') return;
        if (!TEXTUAL.test(row.mimeType || '')) return store.record(row);
        getBody(p.requestId, sessionId)
          .then(body => store.record({ ...row, responseBody: body?.base64Encoded ? undefined : body?.body }))
          .catch(() => store.record(row));
      }
    },
  };
}
