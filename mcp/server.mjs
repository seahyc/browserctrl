#!/usr/bin/env node
// MCP frontend. Same core as the CLI: this file only maps tool calls to
// lib/ops and shapes results. Uses the low-level Server API with plain JSON
// Schema so the server carries no zod version coupling.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import { connect } from '../lib/daemon.mjs';
import { listBrowsers, resolveBrowserArg } from '../lib/discovery.mjs';
import { BROWSERS, agentId, withAgentIdentity } from '../lib/env.mjs';
import * as ops from '../lib/ops.mjs';
import * as ext from '../lib/ext.mjs';
import * as claims from '../lib/claims.mjs';
import * as state from '../lib/state.mjs';
import * as annotations from '../lib/annotations.mjs';
import { ensureRunning, BRIDGE_PORT } from '../lib/bridge.mjs';
import * as sessions from '../lib/sessions.mjs';

const SERVER_NAME = 'browser';
const SERVER_VERSION = '2.1.0';
const TOOL_TIMEOUT_MS = 60000;
// Guard against a tool result that would blow up the client's context.
const MAX_TEXT_BYTES = 100000;

// Clients known to render inline image content. Everything else gets the file
// path, which it can read with its own file tool.
const IMAGE_CLIENTS = [/claude/i, /cursor/i, /vscode/i, /zed/i];

const BROWSER_ENUM = Object.keys(BROWSERS);
const browserProp = {
  agentId: { type: 'string', description: 'Stable unique identity for this agent. Required when multiple agents share one MCP server; reuse it on every call.' },
  browser: {
    type: 'string',
    enum: BROWSER_ENUM,
    description: 'Which browser to drive. Required: there is no default, and guessing drives the wrong window. Call browser_list first if unsure.',
  },
  port: { type: 'number', description: 'Debug port, as an alternative to browser.' },
};
const tabProp = {
  tab: {
    type: 'string',
    description: 'Tab id from browser_tabs (8-char prefix), or a substring of the tab URL or title.',
  },
};
const targetProps = {
  ref: { type: 'string', description: 'Element ref from browser_read, e.g. "ref_3". Preferred over selectors.' },
  selector: { type: 'string', description: 'CSS selector, when no ref is available.' },
  x: { type: 'number', description: 'CSS pixel x, last resort.' },
  y: { type: 'number', description: 'CSS pixel y, last resort.' },
};

const TOOLS = [
  {
    name: 'browser_list',
    description:
      'List every Chromium-family browser on this machine: which are running, which are debuggable right now, tab counts, and which tabs other agents have claimed. Call this first; no other tool has a default browser.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_tabs',
    description: 'List open tabs in one browser, with their ids and any claims held by other agents.',
    inputSchema: { type: 'object', properties: { ...browserProp } },
  },
  {
    name: 'browser_open',
    description: 'Open a new tab at a URL and wait for it to load. Optionally use a clean temporary session with no profile cookies or storage. Returns the new tab id.',
    inputSchema: {
      type: 'object',
      properties: {
        ...browserProp,
        url: { type: 'string' },
        until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'none'] },
        anonymous: { type: 'boolean', description: 'Use a temporary isolated browser context with no profile cookies or storage. Closing the tab disposes the entire context.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_close',
    description: 'Close a tab.',
    inputSchema: { type: 'object', properties: { ...browserProp, ...tabProp }, required: ['tab'] },
  },
  {
    name: 'browser_group',
    description: 'Group all tabs whose URLs contain any supplied pattern. Requires the cdp handoff extension; returns the group id and count.',
    inputSchema: {
      type: 'object',
      properties: {
        ...browserProp,
        urlPatterns: { type: 'array', items: { type: 'string' }, description: 'URL substrings; all matching tabs are included.' },
        title: { type: 'string' },
        color: { type: 'string' },
        collapsed: { type: 'boolean' },
      },
      required: ['urlPatterns'],
    },
  },
  {
    name: 'browser_ungroup',
    description: 'Remove matching tabs from their current tab groups without closing them.',
    inputSchema: {
      type: 'object',
      properties: { ...browserProp, urlPatterns: { type: 'array', items: { type: 'string' } } },
      required: ['urlPatterns'],
    },
  },
  {
    name: 'browser_read',
    description:
      'Snapshot a page: every interactive element as ref_1..ref_N with role, accessible name and test id, plus the visible text. Read before acting, then pass refs to browser_act. Refs are invalidated by navigation and the tools say so rather than clicking the wrong element.',
    inputSchema: {
      type: 'object',
      properties: {
        ...browserProp,
        ...tabProp,
        maxText: { type: 'number', description: 'Cap on returned page text, default 20000 characters.' },
        includeHidden: { type: 'boolean', description: 'Include off-screen and hidden elements. Default false.' },
      },
      required: ['tab'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a tab and wait for real readiness (load, domcontentloaded, or networkidle). No fixed sleeps.',
    inputSchema: {
      type: 'object',
      properties: { ...browserProp, ...tabProp, url: { type: 'string' }, until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'none'] } },
      required: ['tab', 'url'],
    },
  },
  {
    name: 'browser_wait',
    description:
      'Wait for a condition instead of sleeping: a selector appearing, a selector disappearing, text on the page, a URL fragment, network idle, or a JS predicate. Use this after any action that triggers loading.',
    inputSchema: {
      type: 'object',
      properties: {
        ...browserProp,
        ...tabProp,
        selector: { type: 'string' },
        gone: { type: 'string', description: 'Selector that must disappear, e.g. a spinner.' },
        text: { type: 'string' },
        url: { type: 'string' },
        fn: { type: 'string', description: 'JS expression that must become truthy.' },
        networkIdle: { type: 'boolean' },
        present: { type: 'boolean', description: 'Match mere presence in the DOM instead of visibility. Default false: selector waits require a visible element, so a display:none placeholder does not satisfy them.' },
        timeoutMs: { type: 'number' },
      },
      required: ['tab'],
    },
  },
  {
    name: 'browser_act',
    description:
      'Do something on the page. One action, or a batch that runs in order and stops at the first failure. Actions: click, double_click, right_click, hover, type, key, fill, select, scroll, scroll_to, drag, upload. Target elements by ref from browser_read where possible.',
    inputSchema: {
      type: 'object',
      properties: {
        ...browserProp,
        ...tabProp,
        action: {
          type: 'string',
          enum: ['click', 'double_click', 'right_click', 'hover', 'type', 'key', 'fill', 'select', 'scroll', 'scroll_to', 'drag', 'upload'],
        },
        ...targetProps,
        text: { type: 'string', description: 'For type: literal text to insert.' },
        key: { type: 'string', description: 'For key: "Enter", "Tab", "cmd+a", "shift+Tab".' },
        value: { type: 'string', description: 'For fill and select.' },
        label: { type: 'string', description: 'For select: match the option by visible label.' },
        dy: { type: 'number', description: 'For scroll: vertical delta, default 400.' },
        from: { type: 'string', description: 'For drag: source ref.' },
        to: { type: 'string', description: 'For drag: destination ref.' },
        files: { type: 'array', items: { type: 'string' }, description: 'For upload: absolute file paths.' },
        modifiers: { type: 'array', items: { type: 'string' }, description: 'cmd, ctrl, alt, shift.' },
        steal: { type: 'boolean', description: 'Take the tab even if another agent holds a claim on it.' },
        steps: {
          type: 'array',
          description: 'Batch: each item takes the same fields as a single action. Runs sequentially, stops on first error.',
          items: { type: 'object' },
        },
      },
      required: ['tab'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the viewport, the full page, or one element by ref or selector. Always writes a PNG and returns its path; inline image data is returned to clients that render it.',
    inputSchema: {
      type: 'object',
      properties: { ...browserProp, ...tabProp, full: { type: 'boolean' }, ref: { type: 'string' }, selector: { type: 'string' }, path: { type: 'string' } },
      required: ['tab'],
    },
  },
  {
    name: 'browser_diagnostics',
    description: 'Console output, uncaught JS errors, and the network log for a tab, buffered since the daemon attached. Use failedOnly for 4xx/5xx and failed requests.',
    inputSchema: {
      type: 'object',
      properties: { ...browserProp, ...tabProp, limit: { type: 'number' }, failedOnly: { type: 'boolean' }, clear: { type: 'boolean' } },
      required: ['tab'],
    },
  },
  {
    name: 'browser_annotations',
    description:
      'Read what the human marked on a page for you: their note plus the element they pointed at (role, accessible name, test id, selectors, cropped screenshot) and which tab it was. Call this when a result mentions pending annotations, when the human refers to something they marked, or at the start of browser work.',
    inputSchema: {
      type: 'object',
      properties: {
        consume: { type: 'boolean', description: 'Mark them handled so they stop being reported. Do this once you have acted on them.' },
        clear: { type: 'boolean', description: 'Throw them away without acting.' },
        all: { type: 'boolean', description: 'Include annotations the human aimed at a different agent session.' },
      },
    },
  },
  {
    name: 'browser_marks',
    description: 'Tabs the human handed over, with their notes. Resolve one by passing tab="marked" to any other tool.',
    inputSchema: { type: 'object', properties: { ...browserProp } },
  },
  {
    name: 'browser_annotate_mode',
    description:
      'Arm annotation on a tab so the human can point at elements: installs the overlay, which they toggle with option+A. Use when you want the human to show you which elements they mean.',
    inputSchema: { type: 'object', properties: { ...browserProp, ...tabProp, on: { type: 'boolean', description: 'Also switch annotate mode on immediately.' } }, required: ['tab'] },
  },
  {
    name: 'browser_record',
    description:
      'Record a play: every click, input and navigation across the browser with element identity, optionally with screen video and a frontmost-app timeline. action=start begins, action=stop ends and writes readable steps, action=list shows recordings.',
    inputSchema: {
      type: 'object',
      properties: {
        ...browserProp,
        action: { type: 'string', enum: ['start', 'stop', 'list'] },
        id: { type: 'string', description: 'Which recording to stop. Defaults to the one running.' },
        video: { type: 'boolean', description: 'Also capture the screen, so moments outside the browser are visible.' },
        label: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_recording',
    description:
      'Read a recording: its steps, and any moments the human marked on the video resolved to the nearest real event, so a mark comes back as "click on button Confirm and apply", not a frame number.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, steps: { type: 'boolean', description: 'Return the full step list rather than just the marks.' } },
      required: ['id'],
    },
  },
  {
    name: 'browser_eval',
    description: 'Evaluate JavaScript in the page and return the value. Use when reading or acting needs logic the other tools do not cover.',
    inputSchema: {
      type: 'object',
      properties: { ...browserProp, ...tabProp, js: { type: 'string' } },
      required: ['tab', 'js'],
    },
  },
];

let clientRendersImages = false;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function text(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const clipped = s.length > MAX_TEXT_BYTES ? `${s.slice(0, MAX_TEXT_BYTES)}\n\n[truncated ${s.length - MAX_TEXT_BYTES} more characters]` : s;
  return { content: [{ type: 'text', text: clipped }] };
}

function fail(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

async function withConn(args, fn) {
  const port = resolveBrowserArg(args);
  if (!port) {
    const live = (await listBrowsers()).filter(b => b.debuggable);
    throw new Error(
      live.length
        ? `No browser specified. Debuggable now: ${live.map(b => `${b.key} (:${b.port}, ${b.tabs ?? '?'} tabs)`).join(', ')}. Pass browser=<name>.`
        : 'No browser specified and none is debuggable. Call browser_list to see how to enable one.',
    );
  }
  const conn = await connect(port);
  try {
    return await fn(conn, port);
  } finally {
    conn.close();
  }
}

async function actOnce(conn, targetId, a) {
  const target = { ref: a.ref, selector: a.selector, x: a.x, y: a.y };
  switch (a.action) {
    case 'click':
      return ops.click(conn, targetId, { ...target, modifiers: a.modifiers || [] });
    case 'double_click':
      return ops.click(conn, targetId, { ...target, clickCount: 2, modifiers: a.modifiers || [] });
    case 'right_click':
      return ops.click(conn, targetId, { ...target, button: 'right', modifiers: a.modifiers || [] });
    case 'hover':
      return ops.hover(conn, targetId, target);
    case 'type':
      return ops.type(conn, targetId, a.text ?? '');
    case 'key':
      return ops.key(conn, targetId, a.key);
    case 'fill':
      return ops.fill(conn, targetId, { ...target, value: a.value });
    case 'select':
      return ops.selectOption(conn, targetId, { ...target, value: a.value, label: a.label });
    case 'scroll':
      return ops.scroll(conn, targetId, { deltaY: a.dy ?? 400 });
    case 'scroll_to':
      return ops.scrollTo(conn, targetId, target);
    case 'drag':
      return ops.drag(conn, targetId, { from: { ref: a.from }, to: { ref: a.to } });
    case 'upload':
      return ops.upload(conn, targetId, { ...target, files: a.files });
    default:
      throw new Error(`Unknown action "${a.action}"`);
  }
}

const handlers = {
  browser_list: async () => {
    const rows = await listBrowsers();
    return text(
      rows.map(b => ({
        browser: b.key,
        name: b.label,
        port: b.port,
        running: b.running,
        debuggable: b.debuggable,
        tabs: b.tabs,
        profiles: b.profiles,
        ...(b.debuggable ? {} : { howToEnable: b.enable }),
      })),
    );
  },

  browser_tabs: args => withConn(args, async conn => text(await ops.tabs(conn))),

  browser_open: args =>
    withConn(args, async conn => {
      const res = await ops.newTab(conn, args.url, { anonymous: Boolean(args.anonymous) });
      if (args.until !== 'none') await ops.waitForReady(conn, res.targetId, { waitUntil: args.until || 'load' }).catch(() => {});
      return text(res);
    }),

  browser_close: args =>
    withConn(args, async conn => {
      const tab = await ops.resolveTab(conn, args.tab);
      return text(await ops.closeTab(conn, tab.targetId));
    }),

  browser_group: args => {
    const patterns = Array.isArray(args.urlPatterns) ? args.urlPatterns.filter(Boolean) : [];
    if (!patterns.length) return fail('urlPatterns must contain at least one URL substring');
    return withConn(args, async (_conn, port) => text(await ext.evaluate(port, `__cdpAgent.groupByUrl(${JSON.stringify(patterns)}, ${JSON.stringify({
      title: args.title || 'agent', color: args.color || 'blue', collapsed: Boolean(args.collapsed),
    })})`)));
  },

  browser_ungroup: args => {
    const patterns = Array.isArray(args.urlPatterns) ? args.urlPatterns.filter(Boolean) : [];
    if (!patterns.length) return fail('urlPatterns must contain at least one URL substring');
    return withConn(args, async (_conn, port) => text(await ext.evaluate(port, `__cdpAgent.ungroupByUrl(${JSON.stringify(patterns)})`)));
  },

  browser_read: args =>
    withConn(args, async conn => {
      const tab = await ops.resolveTab(conn, args.tab);
      const snap = await ops.readPage(conn, tab.targetId, {
        maxText: args.maxText ?? 20000,
        includeHidden: Boolean(args.includeHidden),
      });
      const elements = snap.elements.map(e => {
        const bits = [e.ref, e.role, e.name];
        if (e.testid) bits.push(`testid=${e.testid}`);
        if (e.disabled) bits.push('disabled');
        if (e.checked) bits.push('checked');
        if (e.value) bits.push(`value=${e.value}`);
        return bits.join('  ');
      });
      return text(
        `${snap.title}\n${snap.url}\nscroll ${snap.scroll.y}/${snap.scroll.h}\n\n` +
          `ELEMENTS (${elements.length})\n${elements.join('\n')}\n\n` +
          `TEXT${snap.textTruncated ? ` (truncated from ${snap.textLength} chars)` : ''}\n${snap.text}`,
      );
    }),

  browser_navigate: args =>
    withConn(args, async (conn, port) => {
      const tab = await ops.resolveTab(conn, args.tab);
      claims.claim(port, tab.targetId, { steal: Boolean(args.steal) });
      return text(await ops.navigate(conn, tab.targetId, args.url, { waitUntil: args.until || 'load' }));
    }),

  browser_wait: args =>
    withConn(args, async conn => {
      const tab = await ops.resolveTab(conn, args.tab);
      return text(
        await ops.waitFor(conn, tab.targetId, {
          selector: args.selector, gone: args.gone, text: args.text, url: args.url,
          fn: args.fn, networkIdle: args.networkIdle, present: Boolean(args.present), timeoutMs: args.timeoutMs ?? 15000,
        }),
      );
    }),

  browser_act: args =>
    withConn(args, async (conn, port) => {
      const tab = await ops.resolveTab(conn, args.tab);
      claims.claim(port, tab.targetId, { steal: Boolean(args.steal) });
      const steps = args.steps?.length ? args.steps : [args];
      const results = [];
      for (const [i, step] of steps.entries()) {
        try {
          results.push({ step: i + 1, action: step.action, result: await actOnce(conn, tab.targetId, step) });
        } catch (e) {
          results.push({ step: i + 1, action: step.action, error: e.message });
          return text({ results, stoppedAt: i + 1, note: 'Batch stopped at the first failure.' });
        }
      }
      return text(results.length === 1 ? results[0].result : { results });
    }),

  browser_screenshot: args =>
    withConn(args, async conn => {
      const tab = await ops.resolveTab(conn, args.tab);
      const shot = await ops.screenshot(conn, tab.targetId, {
        path: args.path || `/tmp/cdp-shot-${tab.id}.png`,
        fullPage: Boolean(args.full),
        ref: args.ref,
        selector: args.selector,
      });
      const summary = `Saved ${shot.path} (${Math.round(shot.bytes / 1024)} KB, DPR=${shot.dpr}; CSS px = image px / DPR)`;
      if (!clientRendersImages) return text(summary);
      return {
        content: [
          { type: 'text', text: summary },
          { type: 'image', data: shot.base64, mimeType: 'image/png' },
        ],
      };
    }),

  browser_diagnostics: args =>
    withConn(args, async conn => {
      const tab = await ops.resolveTab(conn, args.tab);
      if (args.failedOnly) return text(await ops.failedRequests(conn, tab.targetId, { limit: args.limit ?? 50 }));
      return text(await ops.diagnostics(conn, tab.targetId, { limit: args.limit ?? 50, clear: Boolean(args.clear) }));
    }),

  browser_annotations: async args => {
    if (args.clear) return text({ cleared: annotations.clear() });
    const sessionId = args.all ? null : SESSION_ID;
    const rows = args.consume ? annotations.consume({ sessionId }) : annotations.pending({ sessionId });
    const others = args.all ? [] : annotations.pending().filter(r => r.for && r.for !== SESSION_ID);
    const note = others.length
      ? `\n\n(${others.length} more annotation${others.length === 1 ? '' : 's'} are aimed at another agent session; pass all=true to see them.)`
      : '';
    return text(annotations.render(rows) + note);
  },

  browser_marks: async args => {
    const port = resolveBrowserArg(args);
    const rows = state.marks(port);
    return text(
      rows.length
        ? rows.map(m => ({
            targetId: m.targetId,
            id: m.targetId.slice(0, 8),
            port: m.port,
            note: m.note,
            title: m.title,
            url: m.url,
            minutesAgo: Math.round(m.ageMs / 60000),
          }))
        : 'No tabs are marked. Ask the human to run `cdp tray` or `cdp mark <url-substring>`.',
    );
  },

  browser_annotate_mode: args =>
    withConn(args, async conn => {
      await ensureRunning();
      const tab = await ops.resolveTab(conn, args.tab);
      const res = await ops.installOverlay(conn, tab.targetId, { bridgePort: BRIDGE_PORT, force: Boolean(args.force) });
      if (args.on) await ops.toggleOverlay(conn, tab.targetId);
      return text({ ...res, tab: tab.id, hotkey: 'option+A toggles annotate mode in that page', state: await ops.overlayState(conn, tab.targetId) });
    }),

  browser_record: async args => {
    await ensureRunning();
    const base = `http://127.0.0.1:${BRIDGE_PORT}/api/recordings`;
    if (args.action === 'list') return text(await (await fetch(base)).json());
    if (args.action === 'start') {
      const port = resolveBrowserArg(args);
      if (!port) throw new Error('Which browser should be recorded? Pass browser=<name>.');
      const meta = await (
        await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port, video: Boolean(args.video), apps: true, label: args.label ?? null }),
        })
      ).json();
      return text({ ...meta, next: 'The human drives the browser now. Stop with browser_record action=stop.' });
    }
    const id = args.id || (await (await fetch(base)).json()).find(r => !r.stoppedAt)?.id;
    if (!id) throw new Error('No recording is running.');
    return text(await (await fetch(`${base}/${id}/stop`, { method: 'POST' })).json());
  },

  browser_recording: async args => {
    await ensureRunning();
    const base = `http://127.0.0.1:${BRIDGE_PORT}/api/recordings/${args.id}`;
    if (args.steps) return text(await (await fetch(`${base}/steps`)).text());
    const marks = await (await fetch(`${base}/marks`)).json();
    const summary = await (await fetch(base)).json();
    return text({ summary, marks });
  },

  browser_eval: args =>
    withConn(args, async conn => {
      const tab = await ops.resolveTab(conn, args.tab);
      return text(await ops.evaluate(conn, tab.targetId, args.js));
    }),
};

// Announce this session so the human can aim an annotation at it by name.
const SESSION_ID =
  process.env.CODEX_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || `pid:${process.ppid}`;

const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params;
  const handler = handlers[name];
  if (!handler) return fail(`Unknown tool ${name}`);
  sessions.touch(SESSION_ID);
  try {
    const result = await withTimeout(withAgentIdentity(args.agentId ?? agentId(), () => handler(args)), TOOL_TIMEOUT_MS, name);
    // The only handoff path that needs nothing from the harness: if the human
    // has left annotations or marked tabs, say so on the way out.
    if (name !== 'browser_annotations' && name !== 'browser_marks' && !result.isError) {
      const note = annotations.piggyback(state.marks().length);
      const last = result.content?.filter(c => c.type === 'text').pop();
      if (note && last) last.text += note;
    }
    return result;
  } catch (e) {
    return fail(e.message);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Decide once, after the handshake, whether this client renders inline images.
const info = server.getClientVersion?.();
// Not `info?.name || 'unknown'`: Codex sends no client name in the handshake,
// so every Codex session used to land in the annotation picker as "unknown ·
// <dir>", indistinguishable from any other client that omits one.
// Codex's compatible hook/MCP envelope may report itself as Claude Code. Its
// session environment is authoritative and must win for the human picker.
const client = process.env.CODEX_SESSION_ID ? 'codex' : sessions.inferClient(info?.name);
sessions.register({
  id: SESSION_ID,
  client,
  cwd: process.env.CDP_SESSION_CWD || process.cwd(),
});
clientRendersImages = IMAGE_CLIENTS.some(rx => rx.test(client));
if (process.env.CDP_MCP_IMAGES === '1') clientRendersImages = true;
if (process.env.CDP_MCP_IMAGES === '0') clientRendersImages = false;
void fs;
