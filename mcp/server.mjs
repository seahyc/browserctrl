#!/usr/bin/env node
// MCP frontend. Same core as the CLI: this file only maps tool calls to
// lib/ops and shapes results. Uses the low-level Server API with plain JSON
// Schema so the server carries no zod version coupling.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safariMCP } from '../lib/safari-frontend.mjs';
import { connect } from '../lib/daemon.mjs';
import { listBrowsers, resolveBrowserArg } from '../lib/discovery.mjs';
import { BROWSERS, agentId, withAgentIdentity } from '../lib/env.mjs';
import * as ops from '../lib/ops.mjs';
import { listRecipes, loadRecipe, runRecipe, findRecipes } from '../lib/recipes.mjs';
import * as notes from '../lib/notes.mjs';
import * as site from '../lib/site.mjs';
import * as rec from '../lib/rec.mjs';
import { createStore } from '../lib/exemplars.mjs';
import * as captcha from '../lib/captcha.mjs';
import * as cooldown from '../lib/cooldown.mjs';
import { waitForBackgroundReady } from '../lib/readiness.mjs';
import * as ext from '../lib/ext.mjs';
import * as claims from '../lib/claims.mjs';
import * as state from '../lib/state.mjs';
import * as annotations from '../lib/annotations.mjs';
import { ensureRunning, BRIDGE_PORT, bridgeFetch } from '../lib/bridge.mjs';
import * as sessions from '../lib/sessions.mjs';
import * as profiles from '../lib/profiles.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { itemsExpression, formatItems } from '../lib/items.mjs';
import { visit, formatVisits } from '../lib/visit.mjs';
import { setting, flag, migrateLegacy, requireNode } from '../lib/config.mjs';

requireNode();
migrateLegacy();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SERVER_NAME = 'browser';
const SERVER_VERSION = '2.3.0';
const TOOL_TIMEOUT_MS = 60000;
// Guard against a tool result that would blow up the client's context.
const MAX_TEXT_BYTES = 100000;

// Clients known to render inline image content. Everything else gets the file
// path, which it can read with its own file tool.
const IMAGE_CLIENTS = [/claude/i, /cursor/i, /vscode/i, /zed/i];

const BROWSER_ENUM = [...Object.keys(BROWSERS), 'safari'];
const browserProp = {
  agentId: { type: 'string', description: 'Your stable agent id.' },
  browser: { type: 'string', enum: BROWSER_ENUM, description: 'Browser to drive; no default.' },
  port: { type: 'number', description: 'Debug port.' },
};
const tabProp = {
  tab: { type: 'string', description: 'Tab id or prefix from browser_tabs, or title/URL substring. Safari: full handle.' },
};
const targetProps = {
  ref: { type: 'string', description: 'Ref from browser_read (ref_3), or a Safari node UID.' },
  selector: { type: 'string', description: 'CSS selector.' },
  x: { type: 'number', description: 'CSS pixel x, last resort.' },
  y: { type: 'number', description: 'CSS pixel y, last resort.' },
};
const untilProp = { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'none'], description: 'Readiness to wait for; default load.' };
const forceProp = { type: 'boolean', description: 'Load the site although it is cooling down after a challenge. Only when the user wants it now.' };
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });

// The tools an agent needs to drive pages. Every other tool is listed only when
// BROWSERCTRL_MCP_TOOLS is "all" or a comma list of tool names (added to these).
// Calls to any tool work either way; this only decides what tools/list shows.
export const CORE_TOOLS = [
  'browser_list', 'browser_tabs', 'browser_open', 'browser_close', 'browser_navigate',
  'browser_read', 'browser_items', 'browser_act', 'browser_do', 'browser_wait', 'browser_screenshot',
  'browser_eval', 'browser_site', 'browser_recipe', 'browser_visit', 'browser_notes', 'browser_captcha', 'browser_annotations',
];

// Tools merged into one with an action; old names still work when called.
const LEGACY = {
  browser_refresh: ['browser_reload', {}],
  browser_marks: ['browser_annotations', { action: 'marks' }],
  browser_annotate_mode: ['browser_annotations', { action: 'arm' }],
  browser_rec: ['browser_record', null],
  browser_recording: ['browser_record', { action: 'show' }],
};
const TAB_REC = { start: 'tab_start', stop: 'tab_stop', status: 'tab_status' };

const TOOLS = [
  { name: 'browser_safari', description: "Safari 27+ on macOS through Apple's MCP server: action=tools lists its native tools, action=call runs one (tool, arguments, full tab handle).",
    inputSchema: obj({ agentId: browserProp.agentId, action: { type: 'string', enum: ['tools', 'call', 'status', 'stop'] }, tool: { type: 'string' }, arguments: { type: 'object' }, tab: { type: 'string' } }, ['action']) },
  {
    name: 'browser_list',
    description: 'List the Chromium browsers on this machine: running, debuggable, tab counts, tabs claimed by other agents. Call first; no other tool has a default browser.',
    inputSchema: obj({}),
  },
  {
    name: 'browser_tabs',
    description: 'List the open tabs of one browser with ids, profile names and claims by other agents.',
    inputSchema: obj({ ...browserProp, profile: { type: 'string', description: 'Only this profile (see browser_profiles).' } }),
  },
  {
    name: 'browser_profiles',
    description: 'List browser profiles: directory, display name, tab count, which is the default.',
    inputSchema: obj({ ...browserProp }),
  },
  {
    name: 'browser_open',
    description: 'Open a new tab at a URL and wait for it to load. Returns the tab id.',
    inputSchema: obj({
      ...browserProp,
      url: { type: 'string' },
      until: untilProp,
      anonymous: { type: 'boolean', description: 'Temporary context with no cookies or storage; closing the tab disposes it.' },
      profile: { type: 'string', description: 'Open in this profile (see browser_profiles).' },
      force: forceProp,
    }, ['url']),
  },
  {
    name: 'browser_close',
    description: 'Close a tab.',
    inputSchema: obj({ ...browserProp, ...tabProp }, ['tab']),
  },
  {
    name: 'browser_group',
    description: 'Group every tab whose URL contains any of the patterns. Needs the handoff extension.',
    inputSchema: obj({
      ...browserProp,
      urlPatterns: { type: 'array', items: { type: 'string' }, description: 'URL substrings.' },
      title: { type: 'string' },
      color: { type: 'string' },
      collapsed: { type: 'boolean' },
    }, ['urlPatterns']),
  },
  {
    name: 'browser_ungroup',
    description: 'Take matching tabs out of their tab groups without closing them.',
    inputSchema: obj({ ...browserProp, urlPatterns: { type: 'array', items: { type: 'string' }, description: 'URL substrings.' } }, ['urlPatterns']),
  },
  {
    name: 'browser_do',
    description: 'Run a multi-step plan on a tab in one call, the fastest way through a page task. Steps: click <el>, fill <el> = <value>, select <el> = <option>, hover, key Enter, type "<text>", scroll down|up, nav <url>, wait <ms>, expect <state>, date YYYY-MM-DD, set <slider> = <value>, extract "<what>" (copies the answering line into the report), pick "<criterion>" (opens the best-fitting list item), if "<page shows>" then <step>; click "A" | "B" takes the first name present. Write the whole task to its answer in one plan. Name elements as they appear. Append => "<expected>" to check a step; prefix optional to skip a missing element; click! "<exact name>" for a committing control the user authorized. Stops at the first uncertain step and reports candidates. Full grammar: resource browserctrl://guide.',
    inputSchema: obj({
      ...browserProp,
      ...tabProp,
      steps: { type: 'array', items: { type: 'string' }, description: 'Plan lines, e.g. [\'fill "search box" = "aeron"\', "key Enter", \'click "Price: low to high"\'].' },
      then: { type: 'string', enum: ['items', 'text'], description: 'Also return the resulting page as items or text.' },
      dismiss: { type: 'string', description: 'Popup kinds to close when they block a step, e.g. "cookie banner".' },
      repeat: { type: 'string', description: 'Step to repeat after the plan, usually click Next.' },
      until: { type: 'string', description: 'Page condition that ends repeat.' },
      max: { type: 'number', description: 'Most repeats, default 10.' },
      collect: { type: 'string', enum: ['items', 'text'], description: 'Collect and merge each repeated page.' },
      open: { type: 'number', description: 'Open the first N items of the main list in parallel and return what grep finds on each.' },
      grep: { type: 'string', description: 'With open: regex for the lines to return from each page.' },
      steal: { type: 'boolean' },
    }, ['tab']),
  },
  {
    name: 'browser_visit',
    description: 'Open several links in background tabs and return, for each, the lines matching grep, the items or the text. Tabs are closed afterwards. Use it to drill into a list in one call.',
    inputSchema: obj({ ...browserProp, urls: { type: 'array', items: { type: 'string' } }, from: { type: 'string', description: 'Tab that relative paths resolve against.' }, grep: { type: 'string', description: 'Case-insensitive regex for the lines to return.' }, context: { type: 'number', description: 'Lines around each match.' }, then: { type: 'string', enum: ['text', 'items'] }, parallel: { type: 'number', description: 'Tabs at once, default 4.' } }, ['urls']),
  },
  {
    name: 'browser_items',
    description: 'The repeated items on a page (results, listings, rows, messages) grouped by region, each with its text and link. Use it to report what a list shows.',
    inputSchema: obj({ ...browserProp, ...tabProp, all: { type: 'boolean' }, group: { type: 'string', description: 'Show one group in full, e.g. g2.' } }, ['tab']),
  },
  {
    name: 'browser_read',
    description: 'Snapshot a tab: interactive elements near the viewport as ref_1..ref_N with role and name, then the visible text. Read before acting; pass refs to browser_act. Refs die on navigation. Safari returns Apple content with node UIDs.',
    inputSchema: obj({
      ...browserProp,
      ...tabProp,
      maxText: { type: 'number', description: 'Cap on page text, default 20000 characters.' },
      includeHidden: { type: 'boolean', description: 'Include off-screen and hidden elements.' },
      all: { type: 'boolean', description: 'List the whole page, not just near the viewport.' },
    }, ['tab']),
  },
  ...['browser_focus', 'browser_wake'].map(name => ({
    name, description: name === 'browser_wake'
      ? 'Keep a background tab rendering without selecting it. off=true stops it.'
      : 'Select a tab without reloading it.',
    inputSchema: obj({ ...browserProp, ...tabProp, ...(name === 'browser_wake' ? { off: { type: 'boolean' } } : {}) }, ['tab']),
  })),
  {
    name: 'browser_reload',
    description: 'Reload a tab without selecting it and wait for the new document. Never replayed automatically.',
    inputSchema: obj({ ...browserProp, ...tabProp, until: untilProp, timeoutMs: { type: 'number' } }, ['tab']),
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a tab to a URL and wait for real readiness.',
    inputSchema: obj({ ...browserProp, ...tabProp, url: { type: 'string' }, until: untilProp, force: forceProp, steal: { type: 'boolean' } }, ['tab', 'url']),
  },
  {
    name: 'browser_activity',
    description: 'List agent activity and rapid-navigation warnings, describe your task and progress, or pause/resume an owner.',
    inputSchema: obj({
      ...browserProp,
      action: { type: 'string', enum: ['list', 'describe', 'pause', 'resume'] },
      owner: { type: 'string', description: 'Owner to pause or resume; default you.' },
      intent: { type: 'string', maxLength: 240 },
      completed: { type: 'integer', minimum: 0 },
      total: { type: 'integer', minimum: 0 },
    }, ['action']),
  },
  {
    name: 'browser_wait',
    description: 'Wait for a condition instead of sleeping: selector present or gone, text, URL fragment, network idle, or a JS predicate. Use after any action that loads.',
    inputSchema: obj({
      ...browserProp,
      ...tabProp,
      selector: { type: 'string' },
      gone: { type: 'string', description: 'Selector that must disappear, e.g. a spinner.' },
      text: { type: 'string' },
      url: { type: 'string' },
      fn: { type: 'string', description: 'JS expression that must become truthy.' },
      readyState: { type: 'string', enum: ['load', 'domcontentloaded'], description: 'Wait for readiness in the background; combines with selector/text/url.' },
      networkIdle: { type: 'boolean' },
      present: { type: 'boolean', description: 'Match presence in the DOM, not visibility.' },
      timeoutMs: { type: 'number' },
    }, ['tab']),
  },
  {
    name: 'browser_act',
    description: 'One page action, or steps that run in order and stop at the first failure. Actions: click, double_click, right_click, hover, type, key, fill, select, scroll, scroll_to, drag, upload. Target by ref from browser_read.',
    inputSchema: obj({
      ...browserProp,
      ...tabProp,
      action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'hover', 'type', 'key', 'fill', 'select', 'scroll', 'scroll_to', 'drag', 'upload'] },
      ...targetProps,
      text: { type: 'string', description: 'type: literal text.' },
      key: { type: 'string', description: 'key: "Enter", "Tab", "cmd+a".' },
      value: { type: 'string', description: 'fill, select.' },
      label: { type: 'string', description: 'select: option by visible label.' },
      dy: { type: 'number', description: 'scroll: vertical delta, default 400.' },
      from: { type: 'string', description: 'drag: source ref.' },
      to: { type: 'string', description: 'drag: destination ref.' },
      files: { type: 'array', items: { type: 'string' }, description: 'upload: absolute paths.' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'cmd, ctrl, alt, shift.' },
      steal: { type: 'boolean', description: 'Take the tab although another agent claimed it.' },
      steps: { type: 'array', description: 'Batch of objects with these same fields.', items: { type: 'object' } },
    }, ['tab']),
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the viewport, the full page or one element to a PNG and return its path (inline image for clients that render it).',
    inputSchema: obj({ ...browserProp, ...tabProp, full: { type: 'boolean' }, ref: { type: 'string' }, selector: { type: 'string' }, path: { type: 'string' }, emulateFocus: { type: 'boolean', description: 'Chromium: emulate focus to render a background tab.' } }, ['tab']),
  },
  {
    name: 'browser_diagnostics',
    description: 'Chromium: console output, uncaught errors and the network log of a tab since the daemon attached. failedOnly for 4xx/5xx. Safari: use browser_safari.',
    inputSchema: obj({ ...browserProp, ...tabProp, limit: { type: 'number' }, failedOnly: { type: 'boolean' }, clear: { type: 'boolean' } }, ['tab']),
  },
  {
    name: 'browser_captcha',
    description: 'Chromium: clear a captcha or bot check. Tries a plain slider once, otherwise brings the tab to the human and returns when it is gone. The site then cools down: do not reload into it.',
    inputSchema: obj({ ...browserProp, ...tabProp, timeoutMs: { type: 'number', description: 'Wait for the human, default 300000.' }, attempt: { type: 'boolean', description: 'Try the slider first, default true.' }, focus: { type: 'boolean', description: 'Bring the tab to the front, default true.' } }, ['tab']),
  },
  {
    name: 'browser_recipe',
    description: "Chromium: get a site's data through its own API, in seconds. find (query: URL or words) lists matching recipes; run (name like shopee.sg/orders, params) runs one in a tab on that site; list; endpoints (host) lists captured fetch/XHR endpoints; inspect (host, match) returns exemplars to write a recipe from.",
    inputSchema: obj({
      ...browserProp,
      action: { type: 'string', enum: ['find', 'run', 'list', 'endpoints', 'inspect'] },
      query: { type: 'string', description: 'find: a URL or words.' },
      name: { type: 'string', description: 'run: recipe name.' },
      params: { type: 'object', description: 'run: overrides of the recipe params.' },
      raw: { type: 'boolean', description: 'run: unmapped items.' },
      host: { type: 'string', description: 'endpoints, inspect: e.g. shopee.sg.' },
      match: { type: 'string', description: 'inspect: template substring.' },
      force: forceProp,
      handoff: { type: 'boolean', description: 'On a challenge hand the tab to the human and wait; default true.' },
      handoffMs: { type: 'number', description: 'Wait for the human, default 300000.' },
    }, ['action']),
  },
  {
    name: 'browser_annotations',
    description: 'What the human marked for you. action=read (default) returns pending annotations with the element pointed at; consume marks them handled; clear discards; marks lists tabs the human handed over (pass tab="marked" elsewhere); arm installs the overlay on a tab (option+A toggles it).',
    inputSchema: obj({
      ...browserProp,
      action: { type: 'string', enum: ['read', 'consume', 'clear', 'marks', 'arm'] },
      all: { type: 'boolean', description: 'read: include annotations aimed at other agent sessions.' },
      ...tabProp,
      on: { type: 'boolean', description: 'arm: switch annotate mode on now.' },
    }),
  },
  {
    name: 'browser_record',
    description: 'Recordings. start/stop/list: record the human across the browser (video: also the screen). tab_start/tab_stop/tab_status: record one tab for later replay (rrweb events plus a small still per action). show (id): the steps of a recording and the moments the human marked.',
    inputSchema: obj({
      ...browserProp,
      action: { type: 'string', enum: ['start', 'stop', 'list', 'tab_start', 'tab_stop', 'tab_status', 'show'] },
      id: { type: 'string', description: 'stop, show: recording id; stop defaults to the running one.' },
      video: { type: 'boolean', description: 'start: also capture the screen.' },
      label: { type: 'string' },
      ...tabProp,
      out: { type: 'string', description: 'tab_start: output directory.' },
      steps: { type: 'boolean', description: 'show: the full step list, not just the marks.' },
    }, ['action']),
  },
  {
    name: 'browser_site',
    description: 'Before planning a task on a site: its recipes (its own API calls, faster than any UI) and flow notes (facts about its UI). A page URL puts that page\'s notes first.',
    inputSchema: obj({ site: { type: 'string', description: 'example.com or a page URL.' } }, ['site']),
  },
  {
    name: 'browser_notes',
    description: 'Flow notes about how a site works. After a task add up to 3 one-line facts that would save time on another task there, never task values. confirm a note that held; drop a wrong one with why. Actions: add, confirm, drop, list. reveal/on notes: see the guide.',
    inputSchema: obj({
      action: { type: 'string', enum: ['add', 'confirm', 'drop', 'list'] },
      site: { type: 'string', description: 'example.com or a page URL.' },
      text: { type: 'string' }, path: { type: 'string', description: 'Page path, e.g. /search.' }, id: { type: 'string' }, why: { type: 'string' },
      force: { type: 'boolean', description: 'Store even if judged task-specific.' },
      api: { type: 'boolean', description: 'The note names an endpoint: a recipe candidate.' },
      recipe: { type: 'string', description: 'Recipe this note points to.' },
      reveal: { type: 'object', description: '{target, steps}: when a do step cannot find a matching target, run these steps and retry.', properties: { target: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } } },
      on: { type: 'object', description: '{situation, steps}: when Jev sees this situation in a do step, run these steps.', properties: { situation: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } } },
    }, ['action']),
  },
  {
    name: 'browser_eval',
    description: 'Evaluate JavaScript in the page and return the value, for logic the other tools do not cover.',
    inputSchema: obj({ ...browserProp, ...tabProp, js: { type: 'string' } }, ['tab', 'js']),
  },
];

function listedTools(spec = setting('MCP_TOOLS')) {
  if (spec === 'all') return TOOLS;
  const names = new Set([...CORE_TOOLS, ...String(spec || '').split(',').map(s => s.trim()).filter(Boolean)]);
  return TOOLS.filter(t => names.has(t.name));
}

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

// Appends a line about matching recipes: a faster path than the UI the agent is
// about to drive.
// A challenge seen right after a load: report it with the site's cool-down.
function withChallenge(res, found) {
  if (!found) return res;
  return { ...res, challenge: found.kind, cooldown: cooldown.describe(found.cooldown),
    next: `Do not reload or retry. Hand the tab to the human with browser_captcha (tab ${res.targetId ? res.targetId.slice(0, 8) : 'this tab'}).` };
}

// Recipes, then flow notes, for the site the page is on.
function withHint(result, url) {
  const block = url ? site.hintBlock(url) : [];
  if (block.length) result.content.push({ type: 'text', text: block.map(l => `hint: ${l}`).join('\n') });
  return result;
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
    const result = await fn(conn, port);
    const warnings = conn.takeWarnings();
    if (warnings.length) result.content.push({type: 'text', text: warnings.map(w => `Warning: ${w}`).join('\n')});
    return result;
  } finally {
    conn.close();
  }
}

// The action line a recording shows for one browser_act step.
const actLabel = a => [a.action, a.ref || a.selector || (a.x !== undefined ? `(${a.x}, ${a.y})` : ''), a.key || '', a.value ?? a.text ?? '' ? `= "${String(a.value ?? a.text).slice(0, 80)}"` : ''].filter(Boolean).join(' ');

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

async function safariHandler(args, name = 'browser_safari') {
  if (args.port) throw new Error('Safari uses Apple MCP, not a CDP port.');
  const safari = await import('../lib/safari.mjs');
  if (name === 'browser_reload') {
    const {safariReload} = await import('../lib/safari-reload.mjs');
    return text(await safariReload(args.tab, {waitUntil: args.until || 'load', timeoutMs: args.timeoutMs ?? 30000}));
  }
  if (name === 'browser_activity') return text(await safari.safariActivity(args.action, {owner: args.owner, intent: args.intent, completed: args.completed, total: args.total}));
  if (name === 'browser_safari') {
    if (args.action === 'tools') return text(await safari.safariTools());
    if (args.action === 'status') return text(await safari.safariStatus());
    if (args.action === 'stop') return text(await safari.safariStop());
    if (args.action !== 'call') throw new Error('Unknown Safari action');
    return safari.safariCall(args.tool, args.arguments ?? {}, { tab: args.tab });
  }
  const request = safariMCP(name, args);
  return safari.safariCall(request.name, request.args, { tab: request.tab });
}

const handlers = {
  browser_safari: safariHandler,
  browser_list: async () => {
    const rows = await listBrowsers();
    return text(
      rows.map(b => ({
        browser: b.key,
        name: b.label,
        port: b.port,
        ...(b.provider ? {provider:b.provider} : {}),
        running: b.running,
        debuggable: b.debuggable,
        tabs: b.tabs,
        profiles: b.profiles,
        ...(b.debuggable ? {} : { howToEnable: b.enable }),
      })),
    );
  },

  browser_tabs: args => withConn(args, async conn => {
    const rows = await ops.tabs(conn);
    return text(args.profile ? await profiles.filterByProfile(conn, rows, args.profile) : await profiles.labelTabs(conn, rows));
  }),

  browser_profiles: args => withConn(args, async conn => {
    const info = await profiles.inspect(conn);
    return text({ userDataDir: info.userDataDir, profiles: info.profiles });
  }),

  browser_open: args =>
    withConn(args, async conn => {
      if (args.profile && args.anonymous) throw new Error('profile and anonymous are exclusive: an anonymous tab belongs to no profile.');
      cooldown.guard(args.url, { force: Boolean(args.force), action: 'open' });
      let res = args.profile
        ? await profiles.openInProfile(conn, args.url, args.profile)
        : await ops.newTab(conn, args.url, { anonymous: Boolean(args.anonymous) });
      if (args.until !== 'none') {
        await ops.waitForReady(conn, res.targetId, { waitUntil: args.until || 'load' }).catch(() => {});
        res = withChallenge(res, await captcha.observe(conn, res.targetId).catch(() => null));
      }
      return withHint(text(res), args.url);
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
        all: args.all === true,
      });
      const elements = snap.elements.map(e => {
        const bits = [(e.new ? '*' : '') + e.ref, e.role, e.name];
        if (e.testid) bits.push(`testid=${e.testid}`);
        if (e.disabled) bits.push('disabled');
        if (e.checked) bits.push('checked');
        if (e.value) bits.push(`value=${e.value}`);
        if (e.covered) bits.push(`covered by ${e.covered}`);
        else if (e.inert) bits.push('inert');
        if (e.offscreen) bits.push(e.offscreen);
        return bits.join('  ');
      });
      await rec.still(conn, tab.targetId, 'read', { ifChanged: true });
      const o = snap.omitted;
      if (o?.total) elements.push(`(${o.total} more not listed: ${o.above} above, ${o.below} below, ${o.overLimit} over the limit; pass all: true for the whole page)`);
      const s = snap.stats || {};
      const head = [`stats: ${s.interactive} interactive · ${s.links} links · ${s.iframes} iframes${s.crossOrigin?.length ? ` (cross-origin: ${[...new Set(s.crossOrigin)].join(', ')})` : ''} · ${s.shadowRoots} shadow roots · ${s.total} elements`];
      if (snap.loading) head.push(`loading: ${snap.loading}`);
      if (snap.modal) head.push(`modal open: ${snap.modal.role} "${snap.modal.name}"; its controls come first, everything else is inert`);
      return withHint(text(
        `${snap.title}\n${snap.url}\nscroll ${snap.scroll.y}/${snap.scroll.h} · ${snap.scroll.above} screens above, ${snap.scroll.below} below\n${head.join('\n')}\n\n` +
          `ELEMENTS (${elements.length})\n${elements.join('\n')}\n\n` +
          `TEXT${snap.textTruncated ? ` (truncated from ${snap.textLength} chars)` : ''}\n${snap.text}`,
      ), snap.url);
    }),

  browser_focus: args => withConn(args, async conn => {
    const tab = await ops.resolveTab(conn, args.tab);
    return text(await ops.focus(conn, tab.targetId));
  }),
  browser_wake: args => withConn(args, async conn => {
    const tab = await ops.resolveTab(conn, args.tab);
    return text(await ops.wake(conn, tab.targetId, {enabled: args.off !== true}));
  }),
  browser_reload: args => withConn(args, async conn => {
    const tab = await ops.resolveTab(conn, args.tab);
    return text(await ops.reload(conn, tab.targetId, {waitUntil: args.until || 'load', timeoutMs: args.timeoutMs ?? 30000}));
  }),

  browser_navigate: args =>
    withConn(args, async (conn, port) => {
      const tab = await ops.resolveTab(conn, args.tab);
      claims.claim(port, tab.targetId, { steal: Boolean(args.steal) });
      cooldown.guard(args.url, { force: Boolean(args.force), action: 'navigate to' });
      const res = await ops.navigate(conn, tab.targetId, args.url, { waitUntil: args.until || 'load' });
      await rec.still(conn, tab.targetId, `nav ${args.url}`);
      const found = args.until === 'none' ? null : await captcha.observe(conn, tab.targetId).catch(() => null);
      return withHint(text(found ? withChallenge({ ...res, targetId: tab.targetId }, found) : res), args.url);
    }),

  browser_activity: args => withConn(args, async conn => text(await conn.activity(args.action, {owner: args.owner, intent: args.intent, completed: args.completed, total: args.total}))),

  browser_wait: args =>
    withConn(args, async conn => {
      const tab = await ops.resolveTab(conn, args.tab);
      if (args.readyState) {
        if (args.networkIdle || args.gone || args.fn) throw new Error('readyState supports selector, text and url. Use a separate browser_wait for other conditions.');
        return text(await waitForBackgroundReady(conn, tab.targetId, {waitUntil: args.readyState, timeoutMs: args.timeoutMs ?? 15000, selector: args.selector, text: args.text, url: args.url}));
      }
      return text(
        await ops.waitFor(conn, tab.targetId, {
          selector: args.selector, gone: args.gone, text: args.text, url: args.url,
          fn: args.fn, networkIdle: args.networkIdle, present: Boolean(args.present), timeoutMs: args.timeoutMs ?? 15000,
        }),
      );
    }),

  browser_do: args =>
    withConn(args, async (conn, port) => {
      const tab = await ops.resolveTab(conn, args.tab);
      claims.claim(port, tab.targetId, { steal: Boolean(args.steal) });
      const r = await runSteps(conn, tab.targetId, args.steps || [], {
        then: args.then, dismiss: args.dismiss, repeat: args.repeat, until: args.until, max: args.max, collect: args.collect, open: args.open || 0, grep: args.grep,
        onStep: rec.get(tab.targetId) ? row => rec.still(conn, tab.targetId, `do: ${row.do}`, { status: row.stopped ? 'FAILED' : row.skipped ? 'SKIPPED' : 'SUCCESS' }) : undefined,
      });
      return text(formatSteps(r));
    }),

  browser_visit: args =>
    withConn(args, async conn => {
      let urls = args.urls || [];
      if (args.from) { const base = (await ops.resolveTab(conn, args.from)).url; urls = urls.map(u => new URL(u, base).href); }
      return text(formatVisits(await visit(conn, urls, { grep: args.grep, context: args.context ?? 1, then: args.then || 'text', parallel: args.parallel || 4 })));
    }),

  browser_items: args =>
    withConn(args, async conn => {
      const tab = await ops.resolveTab(conn, args.tab);
      const r = await ops.evaluate(conn, tab.targetId, itemsExpression({ all: Boolean(args.all) }));
      if (args.group) r.groups = r.groups.filter(g => g.id === args.group);
      return text(formatItems(r, { full: Boolean(args.group) }));
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
          await rec.still(conn, tab.targetId, actLabel(step));
        } catch (e) {
          results.push({ step: i + 1, action: step.action, error: e.message });
          await rec.still(conn, tab.targetId, actLabel(step), { status: 'FAILED' });
          return text({ results, stoppedAt: i + 1, note: 'Batch stopped at the first failure.' });
        }
      }
      return text(results.length === 1 ? results[0].result : { results });
    }),

  browser_screenshot: args =>
    withConn(args, async conn => {
      const tab = await ops.resolveTab(conn, args.tab);
      const shot = await ops.screenshot(conn, tab.targetId, {
        path: args.path || path.join(os.tmpdir(), `cdp-shot-${tab.id}.png`),
        fullPage: Boolean(args.full), emulateFocus: Boolean(args.emulateFocus),
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

  browser_captcha: args =>
    withConn(args, async (conn, port) => {
      const tab = await ops.resolveTab(conn, args.tab);
      claims.claim(port, tab.targetId, { steal: false });
      return text(await captcha.solve(conn, tab.targetId, { timeoutMs: args.timeoutMs ?? 300000, attempt: args.attempt !== false, focus: args.focus !== false }));
    }),

  browser_recipe: async args => {
    if (args.action === 'list') return text(listRecipes());
    if (args.action === 'find') return text(findRecipes(args.query || ''));
    if (args.action === 'endpoints') { const store = createStore(); return text(args.host ? store.catalog(args.host) : store.hosts()); }
    if (args.action === 'inspect') return text(createStore().exemplars(args.host, args.match));
    if (args.action !== 'run') throw new Error('action must be find, run, list, endpoints or inspect');
    return withConn(args, async conn => text(await runRecipe(conn, loadRecipe(args.name), args.params || {}, {
      raw: Boolean(args.raw), force: Boolean(args.force), handoff: args.handoff !== false, ...(args.handoffMs ? { handoffMs: args.handoffMs } : {}),
    })));
  },

  browser_annotations: async args => {
    const action = args.action || (args.clear ? 'clear' : args.consume ? 'consume' : 'read');
    if (action === 'marks') {
      const rows = state.marks(resolveBrowserArg(args));
      return text(
        rows.length
          ? rows.map(m => ({ targetId: m.targetId, id: m.targetId.slice(0, 8), port: m.port, note: m.note, title: m.title, url: m.url, minutesAgo: Math.round(m.ageMs / 60000) }))
          : 'No tabs are marked. Ask the human to run `browserctrl tray` or `browserctrl mark <url-substring>`.',
      );
    }
    if (action === 'arm') return withConn(args, async conn => {
      await ensureRunning();
      const tab = await ops.resolveTab(conn, args.tab);
      const res = await ops.installOverlay(conn, tab.targetId, { bridgePort: BRIDGE_PORT, force: Boolean(args.force) });
      if (args.on) await ops.toggleOverlay(conn, tab.targetId);
      return text({ ...res, tab: tab.id, hotkey: 'option+A toggles annotate mode in that page', state: await ops.overlayState(conn, tab.targetId) });
    });
    if (action === 'clear') return text({ cleared: annotations.clear() });
    const sessionId = args.all ? null : SESSION_ID;
    const rows = action === 'consume' ? annotations.consume({ sessionId }) : annotations.pending({ sessionId });
    const others = args.all ? [] : annotations.pending().filter(r => r.for && r.for !== SESSION_ID);
    const note = others.length
      ? `\n\n(${others.length} more annotation${others.length === 1 ? '' : 's'} are aimed at another agent session; pass all=true to see them.)`
      : '';
    return text(annotations.render(rows) + note);
  },

  browser_record: async args => {
    if (args.action?.startsWith('tab_')) {
      if (args.action === 'tab_status') return text(rec.all());
      return withConn(args, async conn => {
        const tab = await ops.resolveTab(conn, args.tab);
        if (args.action === 'tab_start') return text(await rec.start(conn, tab.targetId, { out: args.out, label: args.label }));
        return text(await rec.stop(conn, tab.targetId));
      });
    }
    await ensureRunning();
    const root = `http://127.0.0.1:${BRIDGE_PORT}/api/recordings`;
    if (args.action === 'show') {
      const base = `${root}/${args.id}`;
      if (args.steps) return text(await (await bridgeFetch(`${base}/steps`)).text());
      const marks = await (await bridgeFetch(`${base}/marks`)).json();
      const summary = await (await bridgeFetch(base)).json();
      return text({ summary, marks });
    }
    if (args.action === 'list') return text(await (await bridgeFetch(root)).json());
    if (args.action === 'start') {
      const port = resolveBrowserArg(args);
      if (!port) throw new Error('Which browser should be recorded? Pass browser=<name>.');
      const meta = await (
        await bridgeFetch(root, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port, video: Boolean(args.video), apps: true, label: args.label ?? null }),
        })
      ).json();
      return text({ ...meta, next: 'The human drives the browser now. Stop with browser_record action=stop.' });
    }
    if (args.action !== 'stop') throw new Error('action must be start, stop, list, tab_start, tab_stop, tab_status or show');
    const id = args.id || (await (await bridgeFetch(root)).json()).find(r => !r.stoppedAt)?.id;
    if (!id) throw new Error('No recording is running.');
    return text(await (await bridgeFetch(`${root}/${id}/stop`, { method: 'POST' })).json());
  },

  browser_site: async args => text(site.format(site.lookup(args.site))),

  browser_notes: async args => {
    if (args.action === 'add') {
      if (args.recipe && !listRecipes().some(r => r.name === args.recipe)) return fail(`No recipe ${args.recipe}`);
      const r = await notes.add(args.site, args.text, { path: args.path, force: Boolean(args.force), api: Boolean(args.api), recipe: args.recipe, reveal: args.reveal, on: args.on });
      return r.ok ? text(r) : fail(`Not added: ${r.reason}`);
    }
    if (args.action === 'confirm' || args.action === 'drop') {
      const r = args.action === 'confirm' ? notes.confirm(args.id) : notes.drop(args.id, { why: args.why });
      return r.ok ? text(r) : fail(r.reason);
    }
    return text(args.site ? notes.format(notes.show(args.site)) : notes.sites());
  },

  browser_eval: args =>
    withConn(args, async conn => {
      const tab = await ops.resolveTab(conn, args.tab);
      return text(await ops.evaluate(conn, tab.targetId, args.js));
    }),
};

// Announce this session so the human can aim an annotation at it by name.
const SESSION_ID =
  setting('AGENT_ID') || process.env.CODEX_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || `pid:${process.ppid}`;

// The guide and the references, so tool descriptions can stay short.
const RESOURCES = [
  { uri: 'browserctrl://guide', name: 'guide', description: 'How to use browserctrl: what to use when, the do plan grammar, recovery, safety.', file: 'SKILL.md' },
  ...(() => { try { return fs.readdirSync(path.join(ROOT, 'references')).filter(f => f.endsWith('.md')).sort().map(f => ({ uri: `browserctrl://reference/${f.slice(0, -3)}`, name: `reference: ${f.slice(0, -3)}`, description: `Reference: ${f.slice(0, -3).replace(/-/g, ' ')}.`, file: `references/${f}` })); } catch { return []; } })(),
].map(r => ({ ...r, mimeType: 'text/markdown' }));

const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {}, resources: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listedTools() }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES.map(({ file, ...r }) => r) }));
server.setRequestHandler(ReadResourceRequestSchema, async request => {
  const r = RESOURCES.find(x => x.uri === request.params.uri);
  if (!r) throw new Error(`Unknown resource ${request.params.uri}`);
  return { contents: [{ uri: r.uri, mimeType: r.mimeType, text: fs.readFileSync(path.join(ROOT, r.file), 'utf8') }] };
});

server.setRequestHandler(CallToolRequestSchema, async request => {
  let { name, arguments: args = {} } = request.params;
  const old = LEGACY[name];
  if (old) {
    args = name === 'browser_rec' ? { ...args, action: TAB_REC[args.action] || args.action } : { ...old[1], ...args };
    name = old[0];
  }
  const handler = name === 'browser_safari' || args.browser === 'safari' ? () => safariHandler(args, name) : handlers[name];
  if (!handler) return fail(`Unknown tool ${name}`);
  sessions.touch(SESSION_ID);
  try {
    const result = await withTimeout(withAgentIdentity(args.agentId ?? agentId(), () => handler(args)), TOOL_TIMEOUT_MS, name);
    // The only handoff path that needs nothing from the harness: if the human
    // has left annotations or marked tabs, say so on the way out.
    if (name !== 'browser_annotations' && !result.isError) {
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
  cwd: setting('SESSION_CWD') || process.cwd(),
});
clientRendersImages = IMAGE_CLIENTS.some(rx => rx.test(client));
if (setting('MCP_IMAGES') !== undefined) clientRendersImages = flag('MCP_IMAGES');
void fs;
