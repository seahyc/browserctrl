#!/usr/bin/env node
// MCP frontend. Same core as the CLI: this file only maps tool calls to
// lib/ops and shapes results. Uses the low-level Server API with plain JSON
// Schema so the server carries no zod version coupling.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import os from 'node:os';
import path from 'node:path';
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
import { ensureRunning, BRIDGE_PORT } from '../lib/bridge.mjs';
import * as sessions from '../lib/sessions.mjs';
import * as profiles from '../lib/profiles.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { itemsExpression, formatItems } from '../lib/items.mjs';
import { visit, formatVisits } from '../lib/visit.mjs';

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
    description: 'Chromium: tab id from browser_tabs, its 8-character prefix, or a title/URL substring. Safari: the full native tab handle only.',
  },
};
const targetProps = {
  ref: { type: 'string', description: 'Chromium snapshot ref, e.g. ref_3, or a Safari node UID from its own content read. Never mix the two.' },
  selector: { type: 'string', description: 'CSS selector, when no ref is available.' },
  x: { type: 'number', description: 'CSS pixel x, last resort.' },
  y: { type: 'number', description: 'CSS pixel y, last resort.' },
};

const TOOLS = [
  { name: 'browser_safari', description: "Safari 27+ on macOS via Apple's official MCP server. Use action=tools to discover native tools and schemas, or action=call with tool and arguments. Every page operation requires an explicit full tab handle; node UIDs come from get_page_content. Shared daemon serializes current-tab selection and action. Chromium grouping, recording and raw CDP are unsupported.",
    inputSchema: { type: 'object', properties: { agentId: browserProp.agentId, action: { type: 'string', enum: ['tools', 'call', 'status', 'stop'] }, tool: { type: 'string' }, arguments: { type: 'object' }, tab: { type: 'string' } }, required: ['action'] } },
  {
    name: 'browser_list',
    description:
      'List every Chromium-family browser on this machine: which are running, which are debuggable right now, tab counts, and which tabs other agents have claimed. Call this first; no other tool has a default browser.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_tabs',
    description: 'List open tabs in one browser, with their ids, browser profile names, and any claims held by other agents.',
    inputSchema: { type: 'object', properties: { ...browserProp, profile: { type: 'string', description: 'Only tabs in this browser profile: directory, display name, or unique name prefix (see browser_profiles).' } } },
  },
  {
    name: 'browser_profiles',
    description: 'List the browser profiles (Chromium user profiles, e.g. Work and Personal): directory, display name, open tab count, and which is the default for new tabs.',
    inputSchema: { type: 'object', properties: { ...browserProp } },
  },
  {
    name: 'browser_open',
    description: 'Open a new tab at a URL and wait for it to load. Optionally use a clean temporary Chromium session with no profile cookies or storage. Safari uses its separate automation session. Returns the new tab id.',
    inputSchema: {
      type: 'object',
      properties: {
        ...browserProp,
        url: { type: 'string' },
        until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'none'] },
        anonymous: { type: 'boolean', description: 'Use a temporary isolated browser context with no profile cookies or storage. Closing the tab disposes the entire context.' },
        profile: { type: 'string', description: 'Open in this browser profile (directory, display name, or unique prefix; see browser_profiles). Opens a window in the profile if it has none.' },
        force: { type: 'boolean', description: 'Load the site even though it is cooling down after a challenge. Only when the user wants it now: retrying into a challenge escalates it.' },
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
    name: 'browser_do',
    description: 'Run a multi-step plan on a Chromium tab in one call, the fastest way through a page task. Steps: click <element>, fill <element> = <value>, select <element> = <option>, hover, key Enter, type "<text>" (into the focused element), scroll down|up, nav <url>, wait <ms>, expect <page state>. Name elements as they appear; exact names match without a model, others are grounded by Jev (needs TYPESAFE_API_KEY). Append => "<expected result>" to check a step; prefix optional to skip a missing element; click! "<exact name>" for a committing control the user authorized. Stops at the first uncertain step and reports candidates, hidden matches and on-screen controls: re-plan from that.',
    inputSchema: {
      type: 'object',
      properties: {
        ...browserProp,
        ...tabProp,
        steps: { type: 'array', items: { type: 'string' }, description: 'Plan lines, e.g. [\'fill "the search box" = "aeron"\', "key Enter", \'click "Price: low to high"\'].' },
        then: { type: 'string', enum: ['items', 'text'], description: 'Return the resulting page as items (lists, cards, rows) or text in the same call.' },
        dismiss: { type: 'string', description: 'Kinds of popups to close when they block a step, e.g. "cookie banner, app-install prompt".' },
        repeat: { type: 'string', description: 'A step to repeat after the plan, usually click Next.' },
        until: { type: 'string', description: 'Page condition that ends repeat.' },
        max: { type: 'number', description: 'Most repeats, default 10.' },
        collect: { type: 'string', enum: ['items', 'text'], description: 'Collect each repeated page, merged.' },
        open: { type: 'number', description: 'Then open the first N items of the main list (ads skipped) in parallel and return what grep finds on each.' },
        grep: { type: 'string', description: 'With open: case-insensitive regex for the lines to return from each opened page.' },
        steal: { type: 'boolean' },
      },
      required: ['tab'],
    },
  },
  {
    name: 'browser_visit',
    description: 'Open several links at once in background tabs, let each render, and return what you are looking for on each: lines matching grep (with neighbouring lines), the page items, or the main text. Tabs are closed afterwards. Use it to drill into a list (each PR, each listing) in one call; paths resolve against the from tab.',
    inputSchema: { type: 'object', properties: { ...browserProp, urls: { type: 'array', items: { type: 'string' } }, from: { type: 'string', description: 'Tab whose URL relative paths resolve against.' }, grep: { type: 'string', description: 'Case-insensitive regex for the lines to return.' }, context: { type: 'number' }, then: { type: 'string', enum: ['text', 'items'] }, parallel: { type: 'number', description: 'Tabs at once, default 4.' } }, required: ['urls'] },
  },
  {
    name: 'browser_items',
    description: 'The repeated items on a page (search results, listings, table rows, inbox, chat messages, standalone headlines) grouped by page region and heading, each with its own text and link. Use it to report what a list shows instead of page text.',
    inputSchema: { type: 'object', properties: { ...browserProp, ...tabProp, all: { type: 'boolean' }, group: { type: 'string', description: 'Show one group in full, e.g. g2.' } }, required: ['tab'] },
  },
  {
    name: 'browser_read',
    description:
      'Safari returns Apple content with node UIDs. Chromium snapshots list the interactive elements within about one screen of the viewport (all: true for the whole page) as ref_1..ref_N with role, accessible name, test id and a stable id, plus the visible text. A card link is one element; covered, inert (behind a modal) and new (* since the last read) elements are marked; the header has page stats, a loading hint and screens above/below. Read before acting, then pass refs to browser_act. Refs are invalidated by navigation and the tools say so rather than clicking the wrong element.',
    inputSchema: {
      type: 'object',
      properties: {
        ...browserProp,
        ...tabProp,
        maxText: { type: 'number', description: 'Cap on returned page text, default 20000 characters.' },
        includeHidden: { type: 'boolean', description: 'Include off-screen and hidden elements. Default false.' },
        all: { type: 'boolean', description: 'List elements from the whole page, not just near the viewport. Default false.' },
      },
      required: ['tab'],
    },
  },
  ...['browser_focus', 'browser_wake'].map(name => ({
    name, description: name === 'browser_wake'
      ? 'Keep a background tab rendering (lazy lists, animations) without selecting it or taking focus. The page sees itself visible and focused. off=true stops it.'
      : 'Select a tab without reloading it. Use browser_wait readyState for background readiness.',
    inputSchema: {type: 'object', properties: {...browserProp, ...tabProp, ...(name === 'browser_wake' ? {off: {type: 'boolean'}} : {})}, required: ['tab']},
  })),
  ...['browser_reload', 'browser_refresh'].map(name => ({
    name, description: name === 'browser_refresh' ? 'Compatibility alias for browser_reload.' : 'Reload the current page without selecting its tab, then wait for the new document. The reload is never automatically replayed.',
    inputSchema: {type: 'object', properties: {...browserProp, ...tabProp, until: {type: 'string', enum: ['load','domcontentloaded','networkidle','none']}, timeoutMs: {type: 'number'}}, required: ['tab']},
  })),
  {
    name: 'browser_navigate',
    description: 'Navigate a tab and wait for real readiness (load, domcontentloaded, or networkidle). No fixed sleeps.',
    inputSchema: {
      type: 'object',
      properties: { ...browserProp, ...tabProp, url: { type: 'string' }, until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'none'] }, force: { type: 'boolean', description: 'Load the site even though it is cooling down after a challenge. Only when the user wants it now: retrying into a challenge escalates it.' }, },
      required: ['tab', 'url'],
    },
  },
  {
    name: 'browser_activity',
    description: 'List agent activity and rapid navigation warnings, describe your task and progress, or pause/resume an owner. Pause stops subsequent browser requests without closing tabs; already sent actions can finish.',
    inputSchema: {
      type: 'object',
      properties: {
        ...browserProp,
        action: {type: 'string', enum: ['list', 'describe', 'pause', 'resume']},
        owner: {type: 'string', description: 'Owner to pause or resume. Defaults to caller.'},
        intent: {type: 'string', maxLength: 240},
        completed: {type: 'integer', minimum: 0},
        total: {type: 'integer', minimum: 0},
      },
      required: ['action'],
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
        readyState: {type: 'string', enum: ['load','domcontentloaded'], description: 'Wait for page readiness in the background without navigation or tab activation. May combine with selector/text/url.'},
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
      properties: { ...browserProp, ...tabProp, full: { type: 'boolean' }, ref: { type: 'string' }, selector: { type: 'string' }, path: { type: 'string' }, emulateFocus: { type: 'boolean', description: 'Chromium only: temporarily emulate page focus to generate background frames without activating an OS window. Disabled again after capture.' } },
      required: ['tab'],
    },
  },
  {
    name: 'browser_diagnostics',
    description: 'Chromium only. For Safari use browser_safari with browser_console_messages and list_network_requests. Console output, uncaught JS errors, and the network log for a tab, buffered since the daemon attached. Use failedOnly for 4xx/5xx and failed requests.',
    inputSchema: {
      type: 'object',
      properties: { ...browserProp, ...tabProp, limit: { type: 'number' }, failedOnly: { type: 'boolean' }, clear: { type: 'boolean' } },
      required: ['tab'],
    },
  },
  {
    name: 'browser_captcha',
    description: 'Chromium only. Clear a captcha or verification challenge on a tab. Tries Alibaba\'s drag-to-end slider once with a trusted drag (and a jigsaw puzzle slider only where the user enabled the solver); for anything else or after a failed attempt, brings the tab to the front, sounds and notifies the human, and returns as soon as the challenge is gone. Returns {captcha, solvedBy: auto|solver|human, waitedMs} or {captcha: null}; errors when not cleared in time. A challenge starts a cool-down for its site: do not reload or retry into it.',
    inputSchema: {
      type: 'object',
      properties: { ...browserProp, ...tabProp, timeoutMs: { type: 'number', description: 'How long to wait for the human (default 300000)' }, attempt: { type: 'boolean', description: 'Try the automatic slider drag first (default true)' }, focus: { type: 'boolean', description: 'Bring the tab to the front for the human (default true)' } },
      required: ['tab'],
    },
  },
  {
    name: 'browser_recipe',
    description:
      "Chromium only. Get a site's data through its own API instead of its UI: seconds instead of minutes. action=find with query (a URL or words, e.g. 'shopee orders') lists matching recipes; browser_open/navigate/read also hint when a page has one. action=run runs one (name like shopee.sg/orders; params override its defaults) inside a tab on that site and returns structured items. Recipes with tab=handoff (e.g. Taobao) need a tab the human opened. action=list shows every recipe, local and tapped. action=endpoints lists fetch/XHR endpoints captured from tabs you drove (host optional); action=inspect returns full captured exemplars to write a new recipe from. See references/recipes.md.",
    inputSchema: {
      type: 'object',
      properties: {
        ...browserProp,
        action: { type: 'string', enum: ['find', 'run', 'list', 'endpoints', 'inspect'] },
        query: { type: 'string', description: 'For find: a URL or words' },
        name: { type: 'string', description: 'For run: a recipe such as shopee.sg/orders' },
        params: { type: 'object', description: 'Overrides for the recipe params' },
        raw: { type: 'boolean', description: 'Return unmapped items' },
        host: { type: 'string', description: 'Host for endpoints/inspect, e.g. shopee.sg' },
        match: { type: 'string', description: 'Template substring for inspect' },
        force: { type: 'boolean', description: 'Load the site even though it is cooling down after a challenge. Only when the user wants it now: retrying into a challenge escalates it.' },
        handoff: { type: 'boolean', description: 'On a challenge, hand the tab to the human and wait (default true); false fails at once' },
        handoffMs: { type: 'number', description: 'How long to wait for the human (default 300000)' },
      },
      required: ['action'],
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
    name: 'browser_rec',
    description:
      'Record one tab for watching later, in little space: rrweb DOM events plus one small JPEG still per action, across navigations, until stopped. action=start (optional out dir, label), stop (returns the directory and sizes; open it with `browserctrl replay <dir>`), status.',
    inputSchema: {
      type: 'object',
      properties: { ...browserProp, action: { type: 'string', enum: ['start', 'stop', 'status'] }, tab: { type: 'string' }, out: { type: 'string' }, label: { type: 'string' } },
      required: ['action'],
    },
  },
  {
    name: 'browser_site',
    description:
      'Before planning a task on a site: everything browserctrl knows about it. Recipes first (the site\'s own API calls, faster than any UI, with run usage for browser_recipe), then flow notes (facts about how its UI works, with ids; a page URL puts that page\'s notes first). api notes are recipe candidates.',
    inputSchema: { type: 'object', properties: { site: { type: 'string', description: 'example.com or a page URL' } }, required: ['site'] },
  },
  {
    name: 'browser_notes',
    description:
      'Flow notes: short facts about how a site works, hinted on open, navigate, read and do steps with an id. After finishing a task on a site, add up to 3 one-line facts that would have saved you the most time on a different task there (never the answer or the task\'s values; Jev rejects those). confirm a note you relied on that held; drop one that was wrong, with why. When the lesson is how to reach a control hidden behind another (Pets under Guests) or how to clear a recurring interruption, add it with reveal or on so do runs it next time. action=add (site or url, text, optional path template like /search), confirm (id), drop (id, why), list (optional site).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'confirm', 'drop', 'list'] },
        site: { type: 'string', description: 'example.com or a page URL (its path becomes the note\'s page)' },
        text: { type: 'string' }, path: { type: 'string' }, id: { type: 'string' }, why: { type: 'string' },
        force: { type: 'boolean', description: 'Store even if Jev judges it task-specific.' },
        api: { type: 'boolean', description: 'The note says where a page\'s data comes from (an endpoint): a recipe candidate.' },
        recipe: { type: 'string', description: 'Name of a recipe this note points to.' },
        reveal: { type: 'object', description: 'A note do can run: when a step\'s target cannot be found and matches this target, run these do steps, then retry. {target, steps}', properties: { target: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } } },
        on: { type: 'object', description: 'A note do can run: when Jev sees this situation during a do step, run these do steps and carry on. {situation, steps}', properties: { situation: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } } },
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
  if (name === 'browser_reload' || name === 'browser_refresh') {
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
  browser_refresh: args => handlers.browser_reload(args),

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

  browser_rec: async args => {
    if (args.action === 'status') return text(rec.all());
    return withConn(args, async conn => {
      const tab = await ops.resolveTab(conn, args.tab);
      if (args.action === 'start') return text(await rec.start(conn, tab.targetId, { out: args.out, label: args.label }));
      return text(await rec.stop(conn, tab.targetId));
    });
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
  const handler = name === 'browser_safari' || args.browser === 'safari' ? () => safariHandler(args, name) : handlers[name];
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
