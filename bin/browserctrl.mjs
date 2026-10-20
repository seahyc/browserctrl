#!/usr/bin/env node
// CLI frontend. Thin: parse args, call lib/ops, print. No protocol logic here.
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { connect } from '../lib/daemon.mjs';
import { listBrowsers, requireBrowser, httpGetJson } from '../lib/discovery.mjs';
import { relaunchWithDebugPort, planLaunch, planDirectLaunch, startDetached } from '../lib/launch.mjs';
import { safariCLI } from '../lib/safari-frontend.mjs';
import { BROWSERS } from '../lib/env.mjs';
import { diagnose } from '../lib/diagnostics.mjs';
import { captureConnections } from '../lib/connection-capture.mjs';
import * as ops from '../lib/ops.mjs';
import { waitForBackgroundReady } from '../lib/readiness.mjs';
import * as ext from '../lib/ext.mjs';
import {planNativeGroup} from '../lib/tab-control.mjs';
import {getNativeTabAdapter} from '../lib/adapters/index.mjs';
import * as claims from '../lib/claims.mjs';
import * as state from '../lib/state.mjs';
import * as annotations from '../lib/annotations.mjs';
import { ensureRunning, bridgeFetch, bridgeToken, BRIDGE_PORT } from '../lib/bridge.mjs';
import { listRecipes, loadRecipe, runRecipe, findRecipes, listTaps, tapAdd, tapUpdate, tapRemove } from '../lib/recipes.mjs';
import { createStore } from '../lib/exemplars.mjs';
import * as captcha from '../lib/captcha.mjs';
import * as cooldown from '../lib/cooldown.mjs';
import * as profiles from '../lib/profiles.mjs';
import * as jev from '../lib/jev.mjs';
import { setting, number, dirs, configPath, migrateLegacy, legacyMoves, requireNode } from '../lib/config.mjs';
import { itemsExpression, formatItems } from '../lib/items.mjs';
import { formatRead, deepTextExpression } from '../lib/refs.mjs';
import { runSteps, formatSteps, PAGE_PARAMS, formatParams, mainLinks } from '../lib/steps.mjs';
import * as prefetch from '../lib/prefetch.mjs';
import { visit, formatVisits } from '../lib/visit.mjs';
import * as show from '../lib/show.mjs';
import * as trace from '../lib/trace.mjs';
import * as notes from '../lib/notes.mjs';
import * as site from '../lib/site.mjs';
import * as rec from '../lib/rec.mjs';
import * as readtokens from '../lib/readtokens.mjs';
import * as finder from '../lib/find.mjs';
import * as recording from '../lib/recording.mjs';

// Commands that act on a page take a still when their tab is being recorded; reads
// only when the page moved on since the last one.
const STILL_ACT = new Set(['nav', 'reload', 'refresh', 'click', 'hover', 'drag', 'type', 'key', 'fill', 'select', 'upload', 'scroll', 'scroll-to', 'act', 'captcha']);
const STILL_READ = new Set(['read', 'items', 'text', 'check']);

// Commands that take a target as a ref, a stable id or a CSS selector.
const TARGET_CMDS = new Set(['click', 'hover', 'fill', 'select', 'scroll-to', 'upload']);
// "#id", ".class", "[attr]", "tag#id", "div > a", "input[name=q]": not words.
const looksLikeSelector = p => /^[#.\[*]/.test(p) ||
  /^(a|button|input|select|textarea|div|span|li|ul|ol|label|form|img|svg|nav|section|main|header|footer|p|h[1-6]|table|tr|td|th|option|summary|details|dialog)([#.\[:]|\s*[>~+])/.test(p);

// Anything the page's own querySelectorAll accepts and that reads as a selector: CSS punctuation,
// a custom element (its name always has a hyphen), or a tag name that matches something. Plain
// words ("Submit") are valid selectors too, but match nothing and have no selector syntax.
async function selectorOnPage(conn, targetId, p) {
  const syntax = /[#.\[\]:>~+*=()]/.test(p) || /(^|[\s>~+])[a-z][a-z0-9]*-[a-z0-9-]*/.test(p);
  const count = await ops.evaluate(conn, targetId, `(() => { try { return document.querySelectorAll(${JSON.stringify(p)}).length; } catch { return -1; } })()`).catch(() => -1);
  if (count < 0) return false;
  return syntax || (count > 0 && /^[a-z][a-z0-9]*$/.test(p));
}

// Before a read: wait for skeletons and spinners to clear (up to 8 s) so the page is read
// finished, not mid-load. --no-wait skips; BROWSERCTRL_READ_WAIT_MS changes the limit.
async function waitToRead(conn, targetId, flags, { quiet = false } = {}) {
  if (flags['no-wait'] || flags.wait === false) return null;
  const st = await ops.settle(conn, targetId, { timeoutMs: number('READ_WAIT_MS', 8000) });
  const note = ops.describeSettle(st);
  if (note && !quiet) console.error(`(${note})`);
  return st;
}

// --recover: a read of a page that stopped responding recovers it (stops its script and
// reloads; failing that restarts its renderer; failing that replaces the tab) and reads it
// once more. Without the flag the error says why it stopped and what to run.
async function recovering(conn, targetId, flags, read) {
  try { return await read(targetId); }
  catch (e) {
    if (!flags.recover || e.code !== 'timeout' || !['hung', 'crashed'].includes(e.diagnosis?.kind)) throw e;
    const rc = await recoverTab(conn, targetId);
    const r = await read(rc.targetId || targetId);
    const note = `the page had stopped responding (${e.diagnosis.kind}); --recover ${recoveryNote(rc)}`;
    if (r && typeof r === 'object' && !Array.isArray(r)) { r.recovered = note; if (rc.replaced) r.recoveredTab = rc.tab; }
    else console.error(`(${note})`);
    return r;
  }
}

// ops.recoverTab, plus what the CLI keeps per tab: a recording of a tab that had to be
// replaced is closed off, with the command to continue it on the new tab.
async function recoverTab(conn, targetId, opts) {
  const recording = rec.get(targetId);
  const rc = await ops.recoverTab(conn, targetId, opts);
  if (rc.replaced && recording) {
    rec.update(targetId, null);
    try { rec.finish(recording.dir); } catch {}
    rc.recording = `recording ${recording.dir} stopped with the old tab; continue it: browserctrl rec start ${rc.tab} --out ${recording.dir}`;
  }
  return rc;
}
function recoveryNote(rc) {
  return rc.replaced
    ? `replaced the tab: ${rc.oldTab} is closed and the page is open in tab ${rc.tab}; use ${rc.tab} from now on (old refs are gone)${rc.recording ? `. ${rc.recording}` : ''}`
    : `${rc.recovered} it`;
}

// The action line a recording shows for a command: what was done, to what.
function actionLabel(cmd, positional, flags) {
  // `click <tab> ref_9` and `fill <tab> ref_9 "text"` name their target positionally.
  const posTarget = TARGET_CMDS.has(cmd) && !flags.intent && !flags.ref && !flags.selector && positional[2] !== undefined &&
    (/^(ref_\d+|e\d+)$/.test(String(positional[2])) || looksLikeSelector(String(positional[2]))) ? String(positional[2]) : '';
  const what = flags.intent ? `"${flags.intent}"` : flags.ref || flags.selector || posTarget || (flags.x !== undefined ? `(${flags.x}, ${flags.y})` : '');
  const value = flags.value ?? (['fill', 'type'].includes(cmd) ? positional.slice(posTarget ? 3 : 2).join(' ') : '');
  const rest = ['nav', 'key'].includes(cmd) ? positional[2] : cmd === 'act' ? (flags.steps ?? positional.slice(2).join(' ')) : '';
  return [cmd, what, rest, value !== '' && value !== undefined ? `= "${String(value).slice(0, 80)}"` : ''].filter(Boolean).join(' ');
}

const MUTATING = new Set([
  'nav', 'reload', 'refresh', 'focus', 'wake', 'click', 'hover', 'drag', 'type', 'key', 'fill', 'select', 'upload', 'scroll', 'scroll-to', 'close', 'act', 'captcha', 'do',
]);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[name] = true;
      else {
        flags[name] = next;
        i += 1;
      }
    } else positional.push(a);
  }
  return { flags, positional };
}

const out = v => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

// What browserctrl knows about the site the agent is about to drive: recipes (faster than
// the UI), then flow notes. Hints go to stderr so stdout stays parseable.
function hint(url, flags = {}) {
  for (const l of site.hintBlock(url, { notes: !flags['no-notes'] })) console.error(`hint: ${l}`);
}

// After a page load: a challenge starts the site's cool-down; say so on stderr.
async function observe(conn, targetId, res) {
  const found = await captcha.observe(conn, targetId).catch(() => null);
  if (!found) return res;
  console.error(`challenge: ${found.kind} on tab ${targetId.slice(0, 8)}. Cool-down: ${cooldown.describe(found.cooldown)}. ` +
    `Do not reload or retry; hand it to the human with: browserctrl captcha ${targetId.slice(0, 8)}`);
  return { ...res, challenge: found.kind, cooldownUntil: new Date(found.cooldown.until).toISOString() };
}

function cooldownLines() {
  return cooldown.list().map(e => `cool-down: ${cooldown.describe(e)}`);
}

function activityOutput(report, flags) {
  if (flags.json) return out(report);
  return out(report.agents.map(a => {
    const progress = a.total === null ? '' : ` ${a.completed ?? 0}/${a.total}`;
    const tabs = a.tabIds.length ? ` tabs: ${a.tabIds.map(id => id.slice(0, 8)).join(', ')}` : '';
    return `${a.owner} [${a.paused ? 'paused' : 'enabled'}] ${a.intent || '(task not described)'}${progress}${tabs}` +
      a.warnings.map(w => `\n  Warning: ${w}`).join('');
  }).join('\n') || '(no agent activity)');
}

function activityDetails(flags) {
  return {owner: flags.owner, intent: flags.intent,
    ...(flags.completed === undefined ? {} : {completed: Number(flags.completed)}),
    ...(flags.total === undefined ? {} : {total: Number(flags.total)})};
}

function usage() {
  return `browserctrl — browser control

  Pick a browser first. There is no default:
    browserctrl browsers                                 what is debuggable right now
    browserctrl migrate [--apply]                       move an earlier version's folders to this OS's (shows the plan first)
    browserctrl where                                    the install folder and the data, config, state and runtime folders
    browserctrl launch <browser> [--user-data-dir D]     relaunch with its debug port; waits until ready (D = separate instance)
    browserctrl tabs --browser dia                       tabs, with who has claimed them
    browserctrl native-tabs --browser dia                all Dia tabs, including dormant tabs
    browserctrl native-focus <native UUID> --browser dia  select and wake a native Dia tab
    browserctrl native-group --ids UUIDs --group-id N --browser dia [--dry-run] [--allow-focus]
    browserctrl doctor --browser dia                     read-only connection diagnosis (JSON)
    browserctrl doctor --browser dia --watch-seconds 20   passive OS connection capture

  Captchas: browserctrl captcha <tab> --browser dia [--timeout ms] [--no-attempt] [--no-focus]
    tries a drag-to-end slider once (or an installed solver plugin), otherwise brings the tab to the front,
    sounds, notifies (and runs $BROWSERCTRL_NOTIFY_CMD "<message>" if set) and resumes once it clears
    browserctrl captcha plugins                          optional solver plugins installed (none ship)
    browserctrl captcha <plugin> …                       a plugin's own commands
    browserctrl cooldown [clear <site>]                   sites cooling down after a challenge
    A challenge starts a cool-down for its site (20 min, doubling within a day, max 2 h): open, nav,
    do with nav and recipe run refuse that site until it ends or clears; --force overrides.

  Recordings: small, watch-later runs of one tab (rrweb DOM events + one JPEG still per action):
    browserctrl rec start <tab> --browser dia [--out DIR] [--label L]   record until stopped, across navigations
    browserctrl rec stop <tab> --browser dia                            stop; prints sizes
    browserctrl rec status [--browser dia]                              tabs being recorded
    browserctrl replay <DIR> [--out FILE] [--no-open]                   one self-contained HTML: DOM replay + step timeline
    browserctrl replay <DIR> --video out.mp4 [--gif out.gif] [--webp out.webp] [--gif-speed 4] [--trim-start] [--speed 1] [--width 1280] [--label L] [--proxy socks5://…] [--no-captions] [--no-clock]
                                                          real-time MP4: captions in plain words, a clock, stills where DOM replay is blank
    browserctrl replay --side-by-side <A> <B> --labels "Without,With" --video out.mp4 [--gif out.gif]   two runs on one clock

  Recipes: a site's own API call, faster than its UI (see references/recipes.md):
    browserctrl recipe find <url or words>                recipes for a page or task; open/nav/read also hint at them
    browserctrl recipe run shopee.sg/orders --browser dia run one; key=value args override params; --raw skips output mapping
    browserctrl recipe list                               all recipes, local and tapped
    browserctrl recipe tap add <git-url> [name]           add a shared recipe repo; tap list | update [name] [--accept] | remove <name>
    browserctrl recipe endpoints [host]                   fetch/XHR endpoints captured from attached tabs (after capture on)
    browserctrl recipe inspect <host> [match]             full captured exemplars (headers, tokens, bodies)

  Safari 27 on macOS, through Apple's automation interface:
    browserctrl safari tools --browser safari
    browserctrl safari call <tool> --args '{"key":"value"}' --tab <handle> --browser safari
    browserctrl tabs --browser safari
    browserctrl open <url> --browser safari
    browserctrl read <full-handle> --browser safari
    Safari reads return node UIDs, not Chromium ref_N values.

  Agent activity:
    browserctrl activity --browser dia [--json]
    browserctrl activity describe --intent 'Reviewing guide links' --completed 0 --total 91 --browser dia
    browserctrl activity pause --owner <agent-id> --browser dia
    browserctrl activity resume --owner <agent-id> --browser dia

  Read before you act:
    browserctrl read <tab> --browser dia [--json] [--all] snapshot with ref_1..N + page text (--all: whole page, not just near the viewport)
    browserctrl text <tab> [--max-text 8000] [--match re] visible text, bounded by default
    browserctrl find <tab> "<text or regex>" [--json]    controls whose name matches, hidden ones too: what hides them, the
                                                          control that opens them, their link; handles work in do steps
    browserctrl fields <tab> [--all] [--json]            every form field and what it holds now (selects, boxes, sliders, radios)
    browserctrl items <tab> [--group g2] [--all] [--json]  repeated items (results, cards, rows, messages) grouped by page region
                       read, text and items first wait up to 8 s for skeletons/spinners to clear (--no-wait skips);
                       --recover reloads a page that stopped responding and reads it again
    browserctrl html <tab> [selector]
    browserctrl eval <tab> <js>

  Act (all accept --ref ref_3, --selector <css>, or --x/--y):
    browserctrl click <tab> --intent "the Grey option" [--expect "…"]   Jev picks the element (also fill/select/hover); never clicks Buy/Send/Pay/Delete
    browserctrl do <tab> 'fill "search" = "aeron"' 'key Enter' 'click Apply => "results are filtered"' [--then items|text]
                                                   run a plan in one call; stops at the first uncertain or committing step,
                                                   or the first unmet => expectation; 'optional click …' skips when absent
                                                   [--dismiss "cookie banner, app-install prompt"] closes only those overlays
                                                   [--repeat 'click Next' --until "<condition>" --max 10 --collect items|text]
                                                   a challenge mid-plan goes to the human [--handoff-timeout ms | --no-handoff]
                                                   whole task in one call: 'extract "<what>"' (copies the answering line),
                                                   'pick "<criterion>"' (opens the best-fitting item), 'if "<page shows>" then <step>',
                                                   'click "A" | "B"' (the first name present)
    browserctrl trace <tab> [--last N] [--json]          what recent do runs did: targets, expectations, overlays, notices
    browserctrl trace on|off                              keep that log (on by default; 2 MB per tab, 50 MB in all)
    browserctrl capture on|off|status                     keep tabs' fetch/XHR traffic for recipe endpoints (off by default; 200 MB)
    browserctrl site <site|url> [--json]                 before planning on a site: its recipes (run usage), then flow notes (ids, this page first)
    browserctrl notes [site|url] [--clear] [--json]      flow notes alone; open/nav/read and do steps hint recipes + notes
    browserctrl notes add <site|url> [--path /p] [--api] [--recipe <name>] "<fact>" [--force]
    browserctrl notes add <site|url> --reveal "<target>" '<step>'... "<fact>"   do runs the steps when it cannot find that target
    browserctrl notes add <site|url> --on "<situation>" '<step>'... "<fact>"    do runs the steps when Jev sees the situation
                                                         after a task: what would have saved time (Jev rejects answers/values);
                                                         --api: where a page's data comes from (a recipe candidate)
    browserctrl notes confirm <id> | drop <id> --why "…"  a note held / was wrong. --no-notes skips hints once;
                                                         BROWSERCTRL_NOTES=quiet records without hints, =off disables
    browserctrl check <tab> [--expect "…"]               Jev yes/no checks: challenge, login, error, dialog, empty
    browserctrl click <tab> ref_3 [--button right] [--count 2] [--mod cmd,shift]   (or --ref ref_3; a CSS selector: click <tab> "#id")
    browserctrl hover <tab> ".menu"
    browserctrl fill  <tab> ref_5 "text"                   (or --ref ref_5 --value "text"); a label or wrapper is followed to its field
                       refs mean what your last read saw, even after do or --intent read the page again
    browserctrl select <tab> --ref ref_7 --label "Option"
    browserctrl dialog <tab> --accept | --dismiss [--text "prompt answer"]   answer a JavaScript alert/confirm/prompt
    browserctrl type  <tab> "literal text"
    browserctrl key   <tab> Enter | cmd+a | shift+Tab
    browserctrl upload <tab> --ref ref_2 --files a.pdf,b.png
    browserctrl scroll <tab> [--dy 600]     browserctrl scroll-to <tab> --ref ref_9
    browserctrl drag <tab> --from ref_1 --to ref_2
    browserctrl act <tab> --steps '[{"action":"scroll","dy":800},{"action":"key","key":"Enter"}]'

  Navigate and wait (no blind sleeps):
    browserctrl ready <tab> --browser dia [--until load|domcontentloaded] [--timeout 15000]
                       [--selector CSS] [--text TEXT] [--url substring] (background, no activation)
    browserctrl reload <tab> [--until load|domcontentloaded|networkidle|none] [--timeout 30000] [--hard]  (refresh is an alias;
                       --hard restarts the tab's renderer when the page is stuck and a plain reload times out)
    browserctrl nav <tab> <url> [--until load|domcontentloaded|networkidle|none]
    browserctrl wait <tab> --selector ".done" | --text "Saved" | --url /success | --gone ".spinner" | --network-idle
                   [--timeout 15000]

  See what happened:
    browserctrl shot <tab> [file] [--full] [--emulate-focus] [--ref ref_3] [--selector css]
    browserctrl console <tab> [--limit 50] [--clear]
    browserctrl network <tab> [--failed]
    browserctrl cookies <tab>

  Tabs and claims:
    browserctrl open <url> --browser dia [--anonymous]          open a tab
    browserctrl visit <url|/path>... [--from <tab>] [--grep RE] [--then items] [--parallel 4]
                       open links in parallel background tabs, return matching lines or items, close them
    browserctrl open <url> --browser dia --anonymous            clean temporary session
    browserctrl profiles --browser chrome [--json]              profiles, their tabs, which is the default
    browserctrl open <url> --profile <name|dir|prefix> --browser chrome   open in that profile (opens its window if needed)
    browserctrl tabs --profile <name> --browser chrome          only that profile's tabs
    browserctrl close <tab>                    browserctrl focus <tab>  (selects it)
    browserctrl wake <tab> [--off]             render in the background without selecting it
    browserctrl group --url <substr>[,<substr>...] [--title T] [--color blue]
    browserctrl ungroup --url <substr>[,<substr>...]
    browserctrl claims [--browser dia]       browserctrl release [<tab>|--mine]
    browserctrl status --browser dia         browserctrl stop --browser dia

  Chromium commands take --browser <${Object.keys(BROWSERS).join('|')}> or --port <n>, or set
  BROWSERCTRL_BROWSER / BROWSERCTRL_PORT once in the environment of the agent that runs them.
  Safari commands take --browser safari and an explicit full native handle.
  Add --steal to take a tab another agent has claimed.`;
}

async function launch(name) {
  const meta = BROWSERS[String(name).toLowerCase()];
  if (!meta) throw new Error(`Unknown browser "${name}". Known: ${Object.keys(BROWSERS).join(', ')}`);
  if (process.platform !== 'darwin') {
    // Linux and Windows: only ever start a separate instance on its own profile; the running browser is left alone.
    const key = String(name).toLowerCase();
    const ext = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
    const plan = planDirectLaunch({
      key, meta, userDataDir: flags['user-data-dir'] ? path.resolve(String(flags['user-data-dir'])) : null,
      extension: !flags['no-extension'] && fs.existsSync(ext) ? ext : null,
    });
    fs.mkdirSync(plan.userDataDir, { recursive: true });
    const r = await startDetached({ plan, probe: () => httpGetJson(meta.port, '/json/version', 1000) });
    return { launched: meta.label, port: meta.port, ready: r.ready, browser: r.version.Browser, waited_ms: r.waitedMs, profile: plan.userDataDir,
      note: r.alreadyRunning ? `something already answers on port ${meta.port}; nothing was started` : `started a separate ${meta.label} on its own profile; your normal ${meta.label} was not touched` };
  }
  const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, e => (e ? rej(e) : res())));
  // Load the handoff extension alongside the debug port, so a browser started
  // this way has both halves: CDP for the agent, extension UI for the human.
  // Chrome 137+ ignores --load-extension for non-enterprise profiles; other
  // Chromium forks still honour it. Where it is ignored, load it once from
  // chrome://extensions instead and it persists in the profile.
  const extension = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
  const dataDir = flags['user-data-dir'] ? path.resolve(String(flags['user-data-dir'])) : null;
  const plan = planLaunch({
    name, meta, userDataDir: dataDir,
    extension: !flags['no-extension'] && fs.existsSync(extension) ? extension : null,
  });
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const pgrep = argv => new Promise(res => execFile('/usr/bin/pgrep', argv, e => res(!e)));
  let result;
  try {
    result = await relaunchWithDebugPort({
      // A separate instance never touches the user's running browser.
      quit: plan.separateInstance ? async () => {} : () => run('/usr/bin/osascript', ['-e', `tell application "${meta.app}" to quit`]),
      isRunning: plan.separateInstance ? () => pgrep(['-f', '--', plan.processMatch]) : () => pgrep(['-x', meta.app]),
      open: () => run('/usr/bin/open', [...(plan.separateInstance ? ['-n'] : []), '-a', meta.app, '--args', ...plan.args]),
      probe: () => httpGetJson(meta.port, '/json/version', 1000),
    });
  } catch (e) {
    throw new Error(`${e.message}. To enable debugging for ${meta.label}: ${meta.enable}`);
  }
  return {
    launched: meta.label,
    port: meta.port,
    ready: result.ready,
    browser: result.version.Browser,
    waited_ms: result.waitedMs,
    reopened: result.reopened,
    profile: dataDir || 'real',
    extension: plan.args.some(a => a.startsWith('--load-extension=')) ? extension : 'not loaded',
  };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const cmd = positional[0];
// The browser is never guessed, but whoever launches an agent can choose it once:
// BROWSERCTRL_BROWSER=dia or BROWSERCTRL_PORT=9230 stands for --browser/--port on every command.
if (flags.browser === undefined && flags.port === undefined) {
  if (setting('PORT')) flags.port = setting('PORT');
  else if (setting('BROWSER')) flags.browser = setting('BROWSER');
}

// Commands are the words the help text documents after "browserctrl", plus every case below.
// An unknown one gets a pointer instead of the whole help text.
const SYNONYMS = { screenshot: 'shot', capture: 'shot', snapshot: 'read', navigate: 'nav', goto: 'nav', go: 'nav', press: 'key', input: 'fill', type_text: 'type', list: 'tabs' };
function knownCommands() {
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const words = new Set([...usage().matchAll(/browserctrl ([a-z][a-z-]+)/g)].map(m => m[1]));
  for (const m of src.matchAll(/case '([a-z][a-z-]+)':/g)) words.add(m[1]);
  return words;
}
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
  {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // a swap
  }
  return d[a.length][b.length];
}
export function suggestCommand(word, known = knownCommands()) {
  if (known.has(word)) return null;
  if (SYNONYMS[word] && known.has(SYNONYMS[word])) return SYNONYMS[word];
  const best = [...known].map(k => [k, k.startsWith(word) || word.startsWith(k) ? 0.5 : editDistance(word, k)]).sort((a, b) => a[1] - b[1])[0];
  return best && best[1] <= Math.max(2, Math.floor(word.length / 3)) ? best[0] : '';
}

const main = async () => {
  requireNode();
  if (!cmd || cmd === 'help' || flags.help) return out(usage());
  if (/^[a-z][a-z_-]*$/.test(cmd)) {
    const near = suggestCommand(cmd);
    if (near !== null) throw new Error(`Unknown command "${cmd}".${near ? ` Did you mean "${near}"?` : ''} Run browserctrl help for the list.`);
  }
  if (flags.browser === 'safari' || cmd === 'safari') {
    if (flags.port) throw new Error('Safari uses native automation without a CDP port.');
    const safari = await import('../lib/safari.mjs');
    if (cmd === 'safari') {
      if (positional[1] === 'tools') return out(await safari.safariTools());
      if (positional[1] !== 'call') throw new Error('Usage: browserctrl safari tools | call <tool> --args JSON --tab <handle> --browser safari');
      const args = flags.args ? JSON.parse(flags.args) : {};
      const result = await safari.safariCall(positional[2], args, { tab: flags.tab });
      if (result.isError) process.exitCode = 1;
      return out(result);
    }
    if (cmd === 'reload' || cmd === 'refresh') {
      const {safariReload} = await import('../lib/safari-reload.mjs');
      return out(await safariReload(positional[1], {waitUntil: flags.until || 'load', timeoutMs: Number(flags.timeout || 30000)}));
    }
    if (cmd === 'activity') return activityOutput(await safari.safariActivity(positional[1] || 'list', activityDetails(flags)), flags);
    if (cmd === 'status' || cmd === 'doctor') return out(await safari.safariStatus());
    if (cmd === 'stop') return out(await safari.safariStop());
    if (cmd === 'claims') return out(claims.list(9228));
    if (cmd === 'release') return out({ released: flags.mine || !positional[1] ? claims.releaseMine() : claims.release(9228, positional[1]) });
    const request = safariCLI(cmd, positional, flags);
    const result = await safari.safariCall(request.name, request.args, { tab: request.tab });
    if (result.isError) process.exitCode = 1;
    return out(result);
  }
  if (cmd === 'doctor') {
    const seconds = flags['watch-seconds'] === undefined ? null : Number(flags['watch-seconds']);
    if (seconds !== null && (flags['watch-seconds'] === true || !Number.isFinite(seconds) || seconds <= 0 || seconds > 60)) throw new Error('watch-seconds must be greater than 0 and at most 60.');
    const report = await diagnose(flags);
    if (seconds !== null && report.port) report.capture = await captureConnections(report.port, { seconds, daemonPid: report.daemonPid });
    report.cooldowns = cooldown.list().map(e => ({ site: e.site, kind: e.kind, until: new Date(e.until).toISOString(), strikes: e.strikes, summary: cooldown.describe(e) }));
    return out(report);
  }

  if (cmd === 'migrate') {
    // Folders an earlier version made are used in place until this moves them (lib/config.mjs).
    const apply = Boolean(flags.apply);
    const moves = migrateLegacy({ moves: legacyMoves(), dry: !apply });
    if (apply) {
      const { retireLegacyDaemon } = await import('../lib/daemon.mjs');
      for (const port of Object.values(BROWSERS).map(b => b.port).concat(flags.port ? [Number(flags.port)] : [])) retireLegacyDaemon(port);
    }
    const lines = moves.map(m => `${m.skipped ? 'kept ' : apply ? 'moved' : 'would move'} ${m.from} -> ${m.to}${m.skipped ? `  (${m.skipped})` : ''}`);
    return out(lines.length ? `${lines.join('\n')}${apply ? '' : '\n\nStop any older browserctrl first (its agents and daemons), then: browserctrl migrate --apply'}` : 'Nothing to move: no folders from an earlier version.');
  }
  if (cmd === 'where') {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    return out({ install: root, stdio: path.join(root, 'bin', 'stdio.mjs'), ...dirs });
  }

  if (cmd === 'browsers') {
    const rows = await listBrowsers();
    return out(
      rows
        .map(b => {
          if (b.provider === 'safari') return `  Safari    --browser safari  Apple automation adapter; ${b.enable}`;
          if (b.debuggable) {
            const bits = [`:${b.port}`, b.tabs === null ? 'tabs ?' : `${b.tabs} tabs`, b.daemon ? 'daemon up' : 'no daemon'];
            const prof = b.profiles.length ? `  profiles: ${b.profiles.join(', ')}` : '';
            return `✓ ${b.label.padEnd(9)} --browser ${b.key.padEnd(9)} ${bits.join('  ')}${prof}`;
          }
          if (b.running) return `• ${b.label.padEnd(9)} running, not debuggable -> ${b.enable}`;
          return `  ${b.label.padEnd(9)} not running`;
        })
        .join('\n'),
    );
  }

  if (cmd === 'native-tabs' || cmd === 'native-focus' || cmd === 'native-group') {
    if (!flags.browser || flags.port) throw new Error('Native commands require an explicit local --browser');
    const adapter = getNativeTabAdapter(flags.browser);
    if (cmd === 'native-tabs') return out(await adapter.listTabs());
    const ids = String(flags.ids || '').split(',').filter(Boolean);
    const groupId = Number(flags['group-id']);
    if (cmd === 'native-group' && flags['dry-run']) return out(planNativeGroup(await adapter.listTabs(),ids,groupId));
    const port = await requireBrowser(flags);
    const conn = await connect(port);
    try { return out(cmd === 'native-group' ? await conn.groupNativeTabs(ids,groupId,{allowFocus:Boolean(flags['allow-focus'])}) : await conn.focusNativeTab(positional[1])); } finally { conn.close(); }
  }

  if (cmd === 'launch') return out(await launch(positional[1]));
  // Nothing is logged unless switched on: capture keeps the fetch/XHR traffic recipes are built
  // from, trace keeps a line per do step.
  if ((cmd === 'capture' || cmd === 'trace') && ['on', 'off', 'status', undefined].includes(positional[1]) && (cmd === 'capture' || positional[1])) {
    const what = cmd === 'capture' ? 'capturing fetch/XHR traffic for recipes' : 'tracing do plans';
    if (positional[1] === 'on' || positional[1] === 'off') recording.set(cmd, positional[1] === 'on');
    return out(`${recording.enabled(cmd) ? 'on' : 'off'}: ${what}${recording.enabled(cmd) ? ` (browserctrl ${cmd} off to stop)` : ` (browserctrl ${cmd} on to start)`}`);
  }
  if (cmd === 'trace') {
    if (!positional[1]) throw new Error('Usage: browserctrl trace <tab> [--last N] [--json]');
    const runs = trace.read(positional[1], { last: Number(flags.last || 5) });
    return out(flags.json ? runs : trace.format(runs));
  }
  if (cmd === 'site') {
    if (!positional[1]) throw new Error('Usage: browserctrl site <site|url> [--json]   recipes, then flow notes, for a site or page');
    const info = site.lookup(positional[1]);
    return out(flags.json ? info : site.format(info));
  }
  if (cmd === 'notes') {
    const sub = positional[1];
    if (sub === 'add') {
      // A boolean flag written before the text swallows it (--force "text"); take it back.
      const rest = [...positional.slice(3), ...(typeof flags.force === 'string' ? [flags.force] : [])];
      if (!positional[2] || (!rest.length && typeof flags.api !== 'string')) throw new Error('Usage: browserctrl notes add <site|url> [--path /search] [--api] [--recipe <name>] "<one-line fact about how the site works>" [--force]');
      const recipe = typeof flags.recipe === 'string' ? flags.recipe : undefined;
      if (recipe && !listRecipes().some(r => r.name === recipe)) throw new Error(`No recipe ${recipe}. See: browserctrl site ${positional[2]}`);
      // --api "<text>": the text is the value of the flag when written before it.
      const restApi = typeof flags.api === 'string' ? [flags.api, ...rest] : rest;
      // --reveal "<target>" / --on "<situation>": the words before the last are do steps, the last is the note.
      const runFlag = typeof flags.reveal === 'string' ? 'reveal' : typeof flags.on === 'string' ? 'on' : null;
      if ((flags.reveal || flags.on) && !runFlag) throw new Error('Usage: browserctrl notes add <site|url> --reveal "<target>" \'<step>\'... "<fact>"   or   --on "<situation>" \'<step>\'... "<fact>"');
      if (runFlag && restApi.length < 2) throw new Error(`--${runFlag} needs at least one do step and then the note, e.g. notes add example.com --${runFlag} "${runFlag === 'reveal' ? 'Pets' : 'a cookie banner'}" 'click "${runFlag === 'reveal' ? 'Guests' : 'Accept'}"' "<what the note says>"`);
      const text = runFlag ? restApi.at(-1) : restApi.join(' ');
      const runSpec = runFlag ? { [runFlag]: { [runFlag === 'reveal' ? 'target' : 'situation']: flags[runFlag], steps: restApi.slice(0, -1) } } : {};
      const r = await notes.add(positional[2], text, { path: typeof flags.path === 'string' ? flags.path : undefined, force: Boolean(flags.force), api: Boolean(flags.api), recipe, ...runSpec });
      if (flags.json) return out(r);
      if (!r.ok) { process.exitCode = 1; return out(`Not added: ${r.reason}`); }
      return out(`Added ${r.id} to ${r.site}${r.p != null ? ` (Jev p=${r.p})` : ''}${r.unchecked ? ` (not checked by Jev: ${r.unchecked})` : ''}`);
    }
    if (sub === 'confirm' || sub === 'drop') {
      if (!positional[2]) throw new Error(`Usage: browserctrl notes ${sub} <id>${sub === 'drop' ? ' --why "what was wrong"' : ''}`);
      const r = sub === 'confirm' ? notes.confirm(positional[2]) : notes.drop(positional[2], { why: typeof flags.why === 'string' ? flags.why : '' });
      if (flags.json) return out(r);
      if (!r.ok) { process.exitCode = 1; return out(r.reason); }
      return out(sub === 'confirm' ? `Confirmed ${r.id} on ${r.site} (worked ${r.count}×)` : `Dropped ${r.id} from ${r.site}: ${r.text}`);
    }
    const what = sub;
    if (flags.clear) return out(`Cleared flow notes: ${notes.clear(what)}`);
    if (!what) {
      const all = notes.sites();
      if (flags.json) return out(all);
      return out(all.map(s => `${s.site}  ${s.facts} notes, last ${s.last.slice(0, 10)}`).join('\n') || `(no flow notes yet; add one with notes add <site> "…"; stored in ${notes.dir()})`);
    }
    const note = notes.show(what);
    return out(flags.json ? note : notes.format(note));
  }
  if (cmd === 'replay' && (flags.video || flags['side-by-side'])) {
    const dirs = flags['side-by-side'] ? [flags['side-by-side'], ...positional.slice(1)].filter(d => typeof d === 'string') : positional.slice(1, 2);
    if (!dirs.length || dirs.some(d => !fs.existsSync(path.join(d, 'steps.jsonl'))) || (flags['side-by-side'] && dirs.length < 2) || typeof flags.video !== 'string') {
      throw new Error('Usage: browserctrl replay <recording dir> --video out.mp4 [--gif out.gif] [--gif-speed 4] [--fps 12] [--width 1280] [--speed 1] [--label "…"] [--no-captions] [--no-clock]\n       browserctrl replay --side-by-side <dirA> <dirB> --labels "Without do,With do + Jev" --video out.mp4 [--gif out.gif]');
    }
    const { renderVideo } = await import('../lib/video.mjs');
    const labels = typeof flags.labels === 'string' ? flags.labels.split(/\s*[,|]\s*/) : typeof flags.label === 'string' ? [flags.label] : [];
    const num = (v, d) => (v === undefined || v === true ? d : Number(v));
    return out(await renderVideo(dirs, {
      out: flags.video, gif: typeof flags.gif === 'string' ? flags.gif : null, webp: typeof flags.webp === 'string' ? flags.webp : null, gifSpeed: num(flags['gif-speed'], 4),
      fps: num(flags.fps, 12), width: flags.width ? Number(flags.width) : undefined, speed: num(flags.speed, 1), labels,
      captions: !flags['no-captions'], clock: !flags['no-clock'], trimStart: Boolean(flags['trim-start']), ...(typeof flags.proxy === 'string' ? { proxy: flags.proxy } : {}),
      onProgress: (i, f, n) => process.stderr.write(`video${dirs.length > 1 ? ` ${i + 1}/${dirs.length}` : ''}: ${Math.round((f / n) * 100)}%\r`),
    }));
  }
  if (cmd === 'replay') {
    const dir = positional[1];
    if (!dir || !fs.existsSync(path.join(dir, 'steps.jsonl'))) throw new Error('Usage: browserctrl replay <recording dir> [--out FILE] [--no-open]');
    const file = path.resolve(flags.out || path.join(os.tmpdir(), `browserctrl-replay-${path.basename(path.resolve(dir))}.html`));
    fs.writeFileSync(file, rec.replayHtml(dir));
    if (!flags['no-open']) execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [file]);
    return out({ replay: file, bytes: fs.statSync(file).size });
  }
  if (cmd === 'rec' && positional[1] === 'status') {
    const rows = Object.entries(rec.all());
    if (flags.json) return out(Object.fromEntries(rows));
    return out(rows.map(([t, r]) => `${t.slice(0, 8)}  :${r.port}  ${r.n} stills  since ${new Date(r.startedAt).toISOString().slice(11, 19)}  ${r.dir}`).join('\n') || '(no tab is being recorded)');
  }
  if (cmd === 'cooldown') {
    if (positional[1] === 'clear') {
      if (!positional[2]) throw new Error('Usage: browserctrl cooldown clear <site>');
      const url = /^[a-z]+:\/\//i.test(positional[2]) ? positional[2] : `https://${positional[2]}`;
      return out({ cleared: cooldown.clear(url) ? cooldown.siteOf(url) : null });
    }
    if (flags.json) return out(cooldown.list());
    return out(cooldownLines().join('\n') || '(no site is cooling down)');
  }
  if (cmd === 'captcha' && positional[1] === 'plugins') {
    const list = await captcha.plugins();
    return out(list.length ? list.map(p => p.error ? `${p.file}  (failed to load: ${p.error})` : `${p.name.padEnd(12)} ${p.kinds.join(', ')}  ${p.file}`).join('\n') : `(no solver plugins; put one in ${configPath('plugins')} or list it in BROWSERCTRL_CAPTCHA_PLUGINS)`);
  }
  if (cmd === 'captcha' && positional[1] && !/^[0-9a-f]{4,}$/i.test(positional[1]) && !/^\d+$/.test(positional[1])) {
    const plugin = (await captcha.plugins()).find(p => p.name === positional[1]);
    if (plugin?.cli) return out(await plugin.cli(positional.slice(2), captcha.pluginApi));
    if (positional[1] === 'solver') throw new Error('The jigsaw solver is an optional plugin now: browserctrl captcha plugins lists what is installed.');
  }
  if (cmd === 'recipe' && positional[1] !== 'run') {
    const sub = positional[1] || 'list';
    const row = r => `${r.name.padEnd(28)} ${r.error || `${r.kind}${r.tab === 'handoff' ? ', handoff tab' : ''}${r.source !== 'local' ? `, tap ${r.source}` : ''}  ${r.description || ''}`}`;
    if (sub === 'list') return out(flags.json ? listRecipes() : listRecipes().map(row).join('\n') || '(no recipes yet; add a tap: browserctrl recipe tap add <git-url>)');
    if (sub === 'find') {
      const found = findRecipes(positional.slice(2).join(' '));
      return out(flags.json ? found : found.map(row).join('\n') || '(no matching recipe)');
    }
    if (sub === 'tap') {
      const action = positional[2] || 'list';
      if (action === 'list') return out(listTaps().join('\n') || '(no taps)');
      if (action === 'add') return out(await tapAdd(positional[3], positional[4]));
      if (action === 'update') return out(await tapUpdate(positional[3] ?? (typeof flags.accept === "string" ? flags.accept : undefined), undefined, { accept: Boolean(flags.accept) }));
      if (action === 'remove') return out(tapRemove(positional[3]));
      throw new Error('Usage: browserctrl recipe tap list | add <git-url> [name] | update [name] [--accept] | remove <name>');
    }
    const store = createStore();
    if (sub === 'endpoints') {
      const off = recording.enabled('capture') ? '' : ' Capture is off: browserctrl capture on, then use the site.';
      if (!positional[2]) return out(store.hosts().join('\n') || `(nothing captured yet)${off}`);
      const rows = store.catalog(positional[2]);
      return out(flags.json ? rows : rows.map(r => `${String(r.count).padStart(4)}  ${r.lastSeen.slice(0, 16)}  ${r.status ?? '-'}  ${r.template}`).join('\n') || `(nothing captured for this host)${off}`);
    }
    if (sub === 'inspect') return out(store.exemplars(positional[2], positional[3]));
    throw new Error('Usage: browserctrl recipe list | find <url or words> | run <site/name> [key=value ...] [--raw] --browser B | endpoints [host] | inspect <host> [match] | tap ...');
  }

  if (cmd === 'claims') {
    const port = flags.browser || flags.port ? await requireBrowser(flags) : null;
    const rows = claims.list(port);
    return out(rows.length ? rows.map(r => `${r.targetId.slice(0, 8)}  :${r.port}  ${r.label} (${r.owner})  ${Math.round(r.ageMs / 60000)}m ago`).join('\n') : '(no live claims)');
  }

  if (cmd === 'release' && (flags.mine || !positional[1])) return out({ released: claims.releaseMine() });

  if (cmd === 'annotations') {
    if (flags.clear) return out({ cleared: annotations.clear() });
    const rows = flags.consume ? annotations.consume() : annotations.pending();
    return out(flags.json ? rows : annotations.render(rows));
  }

  if (cmd === 'group' || cmd === 'ungroup') {
    const port = await requireBrowser(flags);
    const patterns = String(flags.url || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!patterns.length) throw new Error(`Usage: browserctrl ${cmd} --url <substring>[,<substring>...]`);
    const expression = cmd === 'group'
      ? `__cdpAgent.groupByUrl(${JSON.stringify(patterns)}, ${JSON.stringify({
          title: flags.title || 'agent', color: flags.color || 'blue', collapsed: Boolean(flags.collapsed),
        })})`
      : `__cdpAgent.ungroupByUrl(${JSON.stringify(patterns)})`;
    return out(await ext.evaluate(port, expression));
  }

  if (cmd === 'bridge') {
    await ensureRunning();
    return out({ bridge: `http://127.0.0.1:${BRIDGE_PORT}`, tray: `http://127.0.0.1:${BRIDGE_PORT}/tray?t=${bridgeToken()}` });
  }

  if (cmd === 'record' && positional[1] === 'stop') {
    await ensureRunning();
    const id = positional[2] || (await (await bridgeFetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings`)).json()).find(r => !r.stoppedAt)?.id;
    if (!id) throw new Error('No recording is running.');
    const res = await (await bridgeFetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings/${id}/stop`, { method: 'POST' })).json();
    return out({
      ...res,
      next: res.hasVideo ? `browserctrl annotate ${id} --browser <name>` : `browserctrl recording ${id} --steps`,
    });
  }

  if (cmd === 'recordings') {
    await ensureRunning();
    const rows = await (await bridgeFetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings`)).json();
    return out(
      rows.length
        ? rows.map(r => `${r.id}  ${r.stoppedAt ? 'done' : 'RECORDING'}  ${r.events} events  ${r.marks} marks${r.label ? `  ${r.label}` : ''}`).join('\n')
        : '(no recordings)',
    );
  }

  if (cmd === 'recording') {
    await ensureRunning();
    const id = positional[1];
    if (!id) throw new Error('Which recording? See: browserctrl recordings');
    if (flags.steps) return out(await (await bridgeFetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings/${id}/steps`)).text());
    const marks = await (await bridgeFetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings/${id}/marks`)).json();
    if (flags.json) return out(marks);
    const summary = await (await bridgeFetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings/${id}`)).json();
    const lines = [`${summary.id}  ${Math.round(summary.durationMs / 1000)}s  ${summary.events} events  video: ${summary.hasVideo ? 'yes' : 'no'}`, ''];
    for (const m of marks) {
      lines.push(`${m.clock}  ${m.note || '(no note)'}`);
      lines.push(`     -> ${m.summary}`);
      const el = m.events?.[0]?.element;
      if (el) lines.push(`     -> ${el.role} "${el.name}"${el.testid ? ` [${el.testid}]` : ''}  selector: ${el.selector}`);
      if (m.events?.[0]?.url) lines.push(`     -> ${m.events[0].url}`);
    }
    return out(lines.join('\n'));
  }

  const port = await requireBrowser(flags);
  const conn = await connect(port);
  let stillAfter = null;
  try {
    if (cmd === 'activity') return activityOutput(await conn.activity(positional[1] || 'list', activityDetails(flags)), flags);
    if (cmd === 'ready') {
      const tab = await ops.resolveTab(conn, positional[1]);
      return out(await waitForBackgroundReady(conn, tab.targetId, {waitUntil: flags.until || 'load', timeoutMs: Number(flags.timeout || 15000), selector: flags.selector, text: flags.text, url: flags.url}));
    }
    if (cmd === 'status') return out(await conn.status());
    if (cmd === 'stop') {
      await conn.stop().catch(() => {});
      return out(`Daemon stopped for port ${port}`);
    }
    if (cmd === 'profiles') {
      const info = await profiles.inspect(conn);
      if (flags.json) return out({ userDataDir: info.userDataDir, profiles: info.profiles });
      return out([`user data: ${info.userDataDir}`, ...info.profiles.map(p =>
        `${p.dir.padEnd(12)} ${p.name.slice(0, 24).padEnd(24)} ${p.tabs ? `${p.tabs} tab${p.tabs === 1 ? '' : 's'}` : p.contexts.length ? 'open, no tabs' : 'no window'}` +
        `${p.default ? '  [default: new tabs land here]' : ''}${p.email ? `  ${p.email}` : ''}`)].join('\n'));
    }
    if (cmd === 'tabs') {
      if (!flags.json) for (const line of cooldownLines()) console.error(line);
      let rows = await ops.tabs(conn, { focus: !flags['no-focus'] });
      // Profile names cost a one-time probe per profile; see lib/profiles.mjs.
      rows = flags.profile ? await profiles.filterByProfile(conn, rows, flags.profile) : await profiles.labelTabs(conn, rows);
      if (flags.json) return out(rows);
      return out(
        rows
          .map(t => {
            const tags = [];
            if (t.focused) tags.push('←you');
            if (t.rendering) tags.push('rendering');
            if (t.anonymous) tags.push('anonymous');
            if (t.marked) tags.push(`marked${t.marked.note ? `: ${t.marked.note}` : ''}`);
            if (t.suspended) tags.push('suspended');
            if (t.claimedBy) tags.push(t.claimedBy);
            const name = t.alias ? `${t.alias} (${t.id})` : t.id;
            const profile = rows.some(r => r.profile && r.profile !== '?') ? `${(t.profile || '-').slice(0, 14).padEnd(14)} ` : '';
            return `${name.padEnd(22)} ${profile}${(t.title || '').slice(0, 38).padEnd(38)}  ${t.url.slice(0, 52)}${tags.length ? `  [${tags.join(' | ')}]` : ''}`;
          })
          .join('\n') || '(no tabs)',
      );
    }
    if (cmd === 'marks') {
      const rows = state.marks(port);
      if (!rows.length) return out('(no marked tabs)');
      const all = await ops.tabs(conn);
      return out(
        rows
          .map(m => {
            const t = all.find(x => x.targetId === m.targetId);
            return `${m.targetId.slice(0, 8)}  ${(t?.title || m.title || '(closed)').slice(0, 40).padEnd(40)}  ${Math.round(m.ageMs / 60000)}m ago${m.note ? `  note: ${m.note}` : ''}`;
          })
          .join('\n'),
      );
    }
    if (cmd === 'tray') {
      await ensureRunning();
      const trayUrl = `http://127.0.0.1:${BRIDGE_PORT}/tray?t=${bridgeToken()}`;
      await ops.newTab(conn, trayUrl);
      return out({ tray: trayUrl });
    }
    if (cmd === 'record') {
      await ensureRunning();
      const sub = positional[1];
      if (sub === 'start') {
        const meta = await (await bridgeFetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port, video: Boolean(flags.video), apps: flags.apps !== 'false', label: flags.label === true ? null : flags.label }),
        })).json();
        return out({ ...meta, note: 'Drive the browser now. Stop with: browserctrl record stop ' + meta.id });
      }
      if (sub === 'stop') {
        const id = positional[2] || (await (await bridgeFetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings`)).json()).find(r => !r.stoppedAt)?.id;
        if (!id) throw new Error('No recording is running.');
        const res = await (await bridgeFetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings/${id}/stop`, { method: 'POST' })).json();
        return out({ ...res, annotate: res.hasVideo ? `browserctrl annotate ${id} --browser <name>` : 'no video: read the steps with browserctrl recording ' + id + ' --steps' });
      }
      if (sub === 'arm') {
        const st = await (await bridgeFetch(`http://127.0.0.1:${BRIDGE_PORT}/api/prewarm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port }),
        })).json();
        return out({ ...st, note: 'Capture is warming. `browserctrl record start --video` will adopt it, so the first seconds are on film.' });
      }
      if (sub === 'disarm') {
        return out(await (await bridgeFetch(`http://127.0.0.1:${BRIDGE_PORT}/api/prewarm`, { method: 'DELETE' })).json());
      }
      if (sub === 'status') {
        return out(await (await bridgeFetch(`http://127.0.0.1:${BRIDGE_PORT}/api/prewarm`)).json());
      }
      throw new Error('Usage: browserctrl record start|stop [id] | browserctrl record arm|disarm|status');
    }
    if (cmd === 'annotate') {
      await ensureRunning();
      const id = positional[1];
      const url = `http://127.0.0.1:${BRIDGE_PORT}/annotator?id=${encodeURIComponent(id)}&t=${bridgeToken()}`;
      await ops.newTab(conn, url);
      return out({ annotator: url });
    }
    if (cmd === 'ext') {
      const sub = positional[1];
      if (!sub || sub === 'info') return out(await ext.info(port));
      if (sub === 'group') {
        const pats = (flags.url || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!pats.length) throw new Error('Usage: browserctrl ext group --url <substr>[,<substr>...] [--title T] [--color blue] [--collapsed]');
        return out(await ext.evaluate(port, `__cdpAgent.groupByUrl(${JSON.stringify(pats)}, ${JSON.stringify({
          title: flags.title || 'agent',
          color: flags.color || 'blue',
          collapsed: Boolean(flags.collapsed),
        })})`));
      }
      if (sub === 'outline') return out(await ext.operation(port, 'outline'));
      if (sub === 'undo-close') return out(await ext.evaluate(port, '__cdpAgent.undoClose()'));
      if (sub === 'api') {
        const apiPath = positional[2];
        if (!apiPath) throw new Error('Usage: browserctrl ext api <chrome.path> [jsonArgs]   e.g. browserctrl ext api tabs.update \'[123,{"pinned":true}]\'');
        let args = [];
        const raw = positional.slice(3).join(' ').trim();
        if (raw) {
          try { args = JSON.parse(raw); } catch { throw new Error(`args must be JSON: ${raw}`); }
          if (!Array.isArray(args)) args = [args];
        }
        if (['tabs.query','tabGroups.query','tabGroups.get','tabs.group','tabs.remove','tabGroups.update'].includes(apiPath)) return out(await ext.operation(port, apiPath, args));
        return out(await ext.evaluate(port, `__cdpAgent.api(${JSON.stringify(apiPath)}, ${JSON.stringify(args)})`));
      }
      if (sub === 'apis') return out(await ext.evaluate(port, '__cdpAgent.apis()'));
      if (sub === 'eval') {
        const expr = positional.slice(2).join(' ');
        if (!expr) throw new Error('Usage: browserctrl ext eval "chrome.bookmarks.getTree()"');
        return out(await ext.evaluate(port, expr));
      }
      throw new Error('Usage: browserctrl ext [info] | apis | api <chrome.path> [jsonArgs] | group --url a,b | outline | undo-close | eval <expr>');
    }
    if (cmd === 'recipe') {
      const params = Object.fromEntries(positional.slice(3).map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
      const res = await runRecipe(conn, loadRecipe(positional[2]), params, {
        raw: Boolean(flags.raw), force: Boolean(flags.force), handoff: !flags['no-handoff'],
        ...(flags['handoff-timeout'] ? { handoffMs: Number(flags['handoff-timeout']) } : {}),
      });
      if (res.challenge) console.error(`  challenge: ${res.challenge.captcha} cleared by ${res.challenge.solvedBy}${res.challenge.waitedMs ? ` after ${Math.round(res.challenge.waitedMs / 1000)} s` : ''}`);
      console.error(`[${res.recipe}] ${res.count} items, ${res.calls} calls, ${res.ms} ms (tab ${res.tab})`);
      for (const r of res.retried || []) console.error(`  retried after: ${r}`);
      return out(res.items);
    }
    if (cmd === 'visit') {
      let urls = positional.slice(1);
      if (!urls.length) throw new Error('Usage: browserctrl visit <url|/path> ... [--from <tab>] [--grep "Source branch|files changed"] [--context 1] [--then items] [--parallel 4]');
      // Paths from `items` resolve against the tab they came from.
      if (flags.from) {
        const base = (await ops.resolveTab(conn, flags.from)).url;
        urls = urls.map(u => new URL(u, base).href);
      }
      const res = await visit(conn, urls, {
        grep: flags.grep, then: flags.then === 'items' ? 'items' : 'text', parallel: Number(flags.parallel || 4),
        maxText: Number(flags['max-text'] || 1500), force: Boolean(flags.force), show: show.showing(flags), context: flags.context != null ? Number(flags.context) : 1,
      });
      return out(flags.json ? res : formatVisits(res));
    }
    if (cmd === 'rec') {
      const sub = positional[1];
      if (!['start', 'stop'].includes(sub) || !positional[2]) throw new Error('Usage: browserctrl rec start|stop <tab> [--out DIR] [--label L]  (also: rec status, rec om2w, replay)');
      const t = await ops.resolveTab(conn, positional[2]);
      if (sub === 'start') return out(await rec.start(conn, t.targetId, { out: flags.out, label: flags.label === true ? null : flags.label }));
      const res = await rec.stop(conn, t.targetId);
      return out({ ...res, replay: `browserctrl replay ${res.recording}` });
    }
    if (cmd === 'open') {
      if (flags.profile && flags.anonymous) throw new Error('--profile and --anonymous are exclusive: an anonymous tab belongs to no profile.');
      if (positional[1]) cooldown.guard(positional[1], { force: Boolean(flags.force), action: 'open' });
      let res = flags.profile
        ? await profiles.openInProfile(conn, positional[1], flags.profile)
        : await ops.newTab(conn, positional[1], { anonymous: Boolean(flags.anonymous) });
      if (flags.until !== 'none' && positional[1]) {
        await ops.waitForReady(conn, res.targetId, { waitUntil: flags.until || 'load' }).catch(() => {});
        res = await observe(conn, res.targetId, res);
      }
      hint(positional[1], flags);
      return out(res);
    }

    const tab = await ops.resolveTab(conn, positional[1]);
    const targetId = tab.targetId;
    if (MUTATING.has(cmd)) claims.claim(port, targetId, { steal: Boolean(flags.steal) });
    if (rec.get(targetId) && (STILL_ACT.has(cmd) || STILL_READ.has(cmd))) {
      // One still per action once the command is done (or failed), outside its timing.
      stillAfter = { targetId, label: actionLabel(cmd, positional, flags), ifChanged: STILL_READ.has(cmd) };
    }

    const target = {
      ref: flags.ref,
      selector: flags.selector,
      x: flags.x !== undefined ? Number(flags.x) : undefined,
      y: flags.y !== undefined ? Number(flags.y) : undefined,
      token: flags.token,
    };
    const timeoutMs = flags.timeout ? Number(flags.timeout) : undefined;
    // The natural forms: `click <tab> ref_9`, `click <tab> "#id"`, `fill <tab> ref_61 "value"`.
    let valueArg = positional[2];
    if (TARGET_CMDS.has(cmd) && !flags.intent && !target.ref && !target.selector && target.x === undefined && positional[2] !== undefined) {
      const p = String(positional[2]);
      const num = (v) => v !== undefined && /^-?\d+(\.\d+)?$/.test(String(v));
      if (/^(ref_\d+|e\d+)$/.test(p)) target.ref = p;
      else if (num(p) && num(positional[3]) && cmd !== 'fill') { target.x = Number(p); target.y = Number(positional[3]); } // click <tab> 150 407
      else if (looksLikeSelector(p) || await selectorOnPage(conn, targetId, p)) target.selector = p;
      else if (/^i\d+$/.test(p)) throw new Error(`${p} is an item id from \`items\`, not a ref. Click the item by its text: browserctrl do ${tab.id} 'click "<the item's text>"', or use a ref_N from browserctrl read ${tab.id}.`);
      else if (cmd !== 'fill') throw new Error(`"${p}" is not a ref (ref_9) or a CSS selector. Name it in words instead: browserctrl do ${tab.id} '${cmd} "${p}"', or browserctrl ${cmd} ${tab.id} --intent "${p}".`);
      if (target.ref || target.selector) valueArg = positional[3];
      if (target.x !== undefined) valueArg = positional[4];
    }
    // A ref means what the agent's last `read` of this tab printed, not whatever snapshot
    // ran last (do and --intent read the page again).
    if (target.ref && !target.token) target.token = readtokens.recall(port, targetId);

    // --show / BROWSERCTRL_SHOW=1: bring the tab forward, outline the target and log the
    // action in a corner panel, so a person can watch the automation.
    if (show.showing(flags) && ['click', 'fill', 'select', 'hover', 'key', 'type', 'scroll', 'scroll-to', 'nav', 'reload'].includes(cmd)) {
      await show.bringToFront(conn, targetId);
      const what = flags.intent ? `"${flags.intent}"` : target.ref || target.selector || positional.slice(2).join(' ');
      await show.panel(conn, targetId, { title: 'browserctrl', append: `▶ ${cmd} ${String(what).slice(0, 70)}${flags.value !== undefined ? ` = ${String(flags.value).slice(0, 30)}` : ''}` });
      const label = cmd === 'fill' ? `type "${String(flags.value ?? positional[2] ?? '').slice(0, 40)}"` : cmd === 'type' ? `type "${String(positional[2] ?? '').slice(0, 40)}"` : cmd === 'key' ? `⌨ ${positional[2]}` : cmd === 'nav' ? `go to ${String(positional[2] || '').slice(0, 60)}` : `${cmd} ${String(what).slice(0, 50)}`;
      if (!flags.intent) await show.act(conn, targetId, { ref: target.ref, kind: cmd, label });
      await show.busy(conn, targetId, false); // the idle timer runs from here until the next command
    }

    // Refs that --intent prints come from its own snapshot, the page's latest. A do plan reads
    // the caller's refs in the caller's last read, and hands over its own snapshot only when
    // its report prints refs.
    const callerToken = cmd === 'do' ? readtokens.recall(port, targetId) : null;
    if (flags.intent) readtokens.forget(port, targetId);
    // --intent: Jev picks the target from the page instead of the caller naming a ref.
    if (flags.intent && ['click', 'fill', 'select', 'hover'].includes(cmd)) {
      const cfg = jev.jevKey();
      const snap = await ops.readPage(conn, targetId, { maxText: 0, max: 1500, all: true });
      const view = await ops.evaluate(conn, targetId, jev.VIEW_TEXT);
      const pick = await jev.pickTarget(cfg, snap, { intent: String(flags.intent), action: cmd, view });
      const why = jev.refusal(pick, flags['min-p'] ? Number(flags['min-p']) : undefined);
      if (why) {
        process.exitCode = 3;
        return out({ acted: false, reason: why, candidates: pick.ranked, jev_ms: pick.ms });
      }
      const t = { ref: pick.pick.ref, token: snap.token };
      let result;
      if (cmd === 'click') result = await ops.click(conn, targetId, { ...t, button: flags.button || 'left', clickCount: Number(flags.count || 1) });
      else if (cmd === 'fill') result = await ops.fill(conn, targetId, { ...t, value: flags.value ?? positional[2] });
      else if (cmd === 'select') result = await ops.selectOption(conn, targetId, { ...t, value: flags.value, label: flags.label });
      else result = await ops.hover(conn, targetId, t);
      const report = { acted: true, target: { ref: t.ref, role: pick.pick.role, name: (pick.pick.name || '').slice(0, 80) }, p: pick.p, result, jev_ms: pick.ms };
      if (!flags['no-check']) {
        await ops.waitForReady(conn, targetId, { timeoutMs: 5000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 400));
        const page = await ops.evaluate(conn, targetId, jev.VIEW_TEXT);
        report.page = { url: page.url, title: page.title };
        report.after = await jev.checkPage(cfg, page, { expect: flags.expect });
      }
      return out(report);
    }

    switch (cmd) {
      case 'do': {
        const lines = positional.slice(2);
        if (!lines.length && !flags.repeat) throw new Error('Usage: browserctrl do <tab> \'click "More filters"\' \'click Apply => "results are filtered"\' ... [--dismiss "cookie banner, …"] [--repeat \'click Next\' --until "…" --collect items] [--then items|text] [--open N --grep "label|label"]');
        const recording = rec.get(targetId);
        const r = await runSteps(conn, targetId, lines, { onWarning: warning => console.error(`⚠ ${warning}`), show: show.showing(flags), noNotes: Boolean(flags['no-notes']),
          onStep: recording ? row => rec.still(conn, targetId, `do: ${row.do}`, { status: row.stopped ? 'FAILED' : row.skipped ? 'SKIPPED' : 'SUCCESS',
            // A step Jev resolved: what it picked and how sure it was, for the video's captions.
            extra: /jev p=([\d.]+)/.test(row.how || '') && row.target ? { jev: { target: row.target, p: Number(row.how.match(/jev p=([\d.]+)/)[1]) } } : null }) : undefined,
          then: flags.then, minP: flags['min-p'] ? Number(flags['min-p']) : undefined,
          force: Boolean(flags.force), handoff: !flags['no-handoff'], handoffMs: Number(flags['handoff-timeout'] || 300000),
          dismiss: flags.dismiss, repeat: flags.repeat, until: flags.until, max: flags.max ? Number(flags.max) : undefined, collect: flags.collect,
          open: flags.open ? Number(flags.open) : 0, grep: flags.grep, prefetch: !flags['no-prefetch'], context: flags.context != null ? Number(flags.context) : 1,
          diff: !flags['no-diff'], refToken: callerToken,
        });
        if (r.refsToken) readtokens.remember(port, targetId, r.refsToken);
        if (!r.done) process.exitCode = 3;
        return out(flags.json ? r : formatSteps({ ...r, warnings: [] }));
      }
      case 'items': {
        await waitToRead(conn, targetId, flags);
        const r = await recovering(conn, targetId, flags, (id) => ops.evaluate(conn, id, itemsExpression({ all: Boolean(flags.all), maxGroups: Number(flags.groups || 8), maxItems: Number(flags.max || 30) }), { retry: true }));
        if (flags.group) r.groups = r.groups.filter(g => g.id === flags.group);
        if (!flags['no-prefetch']) await prefetch.start(conn, mainLinks(r, 3, r.url)).catch(() => {});
        return out(flags.json ? r : formatItems(r, { full: Boolean(flags.group), grep: flags.grep }));
      }
      case 'check': {
        const page = await ops.evaluate(conn, targetId, jev.VIEW_TEXT);
        const c = await jev.checkPage(jev.jevKey(), page, { expect: flags.expect });
        const cool = c.flags.includes('challenge') ? cooldown.record(page.url, { kind: 'challenge (Jev)' }) : null;
        return out({ page: { url: page.url, title: page.title }, ...c, ...(cool ? { cooldown: cooldown.describe(cool) } : {}) });
      }
      case 'read': {
        const settled = await waitToRead(conn, targetId, flags, { quiet: true });
        const snap = await recovering(conn, targetId, flags, (id) => ops.readPage(conn, id, {
          maxText: flags.text === 'none' ? 0 : Number(flags['max-text'] || 20000),
          max: Number(flags.max || 400),
          includeHidden: Boolean(flags['include-hidden']),
          all: Boolean(flags.all),
        }));
        const readId = snap.recoveredTab ? (await ops.resolveTab(conn, snap.recoveredTab)).targetId : targetId;
        readtokens.remember(port, readId, snap.token);
        if (settled) { snap.settled = settled; snap.waitNote = ops.describeSettle(settled); }
        if (snap.recovered) snap.waitNote = [snap.waitNote, snap.recovered].filter(Boolean).join('; ');
        hint(snap.url, flags);
        snap.params = await ops.evaluate(conn, readId, PAGE_PARAMS).catch(() => []);
        const blocked = await captcha.notice(conn, readId, positional[1]);
        if (flags.json) return out(blocked ? { ...snap, challenge: blocked } : snap);
        return out((blocked ? `${blocked}\n\n` : '') + formatRead(snap) + (snap.params?.length ? `\nurl params (set them with a nav step): ${formatParams(snap.params)}` : ''));
      }
      case 'text': {
        await waitToRead(conn, targetId, flags);
        // Shadow-root text too (a quiz or popup drawn by a web component).
        const raw = await recovering(conn, targetId, flags, (id) => ops.evaluate(conn, id, deepTextExpression(), { retry: true }));
        const source = String(raw || '');
        let selected = source;
        if (flags.match) {
          let re;
          try { re = new RegExp(String(flags.match), 'i'); }
          catch (e) { throw new Error(`Invalid --match regex: ${e.message}`); }
          selected = source.split(/\r?\n/).filter(line => re.test(line)).join('\n');
        }
        const limit = flags['max-text'] === undefined ? 20000 : Number(flags['max-text']);
        const clipped = limit > 0 && selected.length > limit;
        const text = clipped ? `${selected.slice(0, limit)}\n\n[truncated ${selected.length - limit} characters]` : selected;
        const blocked = source.length < 3000 ? await captcha.notice(conn, targetId, positional[1]) : null;
        return out(flags.json ? { text, textLength: selected.length, truncated: clipped, ...(blocked ? { challenge: blocked } : {}) } : (blocked ? `${blocked}\n\n${text}` : text));
      }
      case 'find': {
        const pattern = positional.slice(2).join(' ');
        if (!pattern) throw new Error('Usage: browserctrl find <tab> "<text or regex>"');
        try { new RegExp(pattern, 'i'); } catch (e) { throw new Error(`Invalid pattern: ${e.message}`); }
        await waitToRead(conn, targetId, flags);
        const r = await recovering(conn, targetId, flags, (id) => ops.evaluate(conn, id, finder.FIND(pattern, { limit: Number(flags.max) || 25 }), { retry: true }));
        return out(flags.json ? r : finder.formatFind(r, pattern));
      }
      case 'fields': {
        await waitToRead(conn, targetId, flags);
        const r = await recovering(conn, targetId, flags, (id) => ops.evaluate(conn, id, finder.FIELDS({ all: !!flags.all }), { retry: true }));
        return out(flags.json ? r : finder.formatFields(r));
      }
      case 'html':
        return out(await ops.html(conn, targetId, positional[2]));
      case 'eval':
        return out(await ops.evaluate(conn, targetId, positional.slice(2).join(' '), { timeoutMs }));
      case 'act': {
        let raw = flags.steps ?? positional.slice(2).join(' ');
        if (!raw) throw new Error('Usage: browserctrl act <tab> --steps \'[{"action":"scroll","dy":800}]\'');
        let steps;
        try { steps = JSON.parse(raw); } catch (e) { throw new Error(`--steps must be valid JSON: ${e.message}`); }
        if (!Array.isArray(steps) || !steps.length) throw new Error('--steps must be a non-empty JSON array');
        const results = [];
        for (const [i, a] of steps.entries()) {
          try {
            const target2 = { ref: a.ref, selector: a.selector, x: a.x, y: a.y };
            let result;
            switch (a.action) {
              case 'click': result = await ops.click(conn, targetId, { ...target2, button: a.button || 'left', clickCount: a.clickCount || 1, modifiers: a.modifiers || [] }); break;
              case 'double_click': result = await ops.click(conn, targetId, { ...target2, clickCount: 2, modifiers: a.modifiers || [] }); break;
              case 'right_click': result = await ops.click(conn, targetId, { ...target2, button: 'right', modifiers: a.modifiers || [] }); break;
              case 'hover': result = await ops.hover(conn, targetId, target2); break;
              case 'type': result = await ops.type(conn, targetId, a.text ?? ''); break;
              case 'key': result = await ops.key(conn, targetId, a.key); break;
              case 'fill': result = await ops.fill(conn, targetId, { ...target2, value: a.value }); break;
              case 'select': result = await ops.selectOption(conn, targetId, { ...target2, value: a.value, label: a.label }); break;
              case 'scroll': result = await ops.scroll(conn, targetId, { deltaY: a.dy ?? 400, deltaX: a.dx ?? 0 }); break;
              case 'scroll_to': result = await ops.scrollTo(conn, targetId, target2); break;
              case 'drag': result = await ops.drag(conn, targetId, { from: { ref: a.from }, to: { ref: a.to } }); break;
              case 'upload': result = await ops.upload(conn, targetId, { ...target2, files: a.files }); break;
              default: throw new Error(`Unknown action "${a.action}"`);
            }
            results.push({ step: i + 1, action: a.action, result });
          } catch (e) {
            results.push({ step: i + 1, action: a.action, error: e.message });
            return out(flags.json ? { results, stoppedAt: i + 1 } : results.map(r => JSON.stringify(r)).join('\n'));
          }
        }
        return out(flags.json ? { results } : results.map(r => JSON.stringify(r)).join('\n'));
      }
      case 'nav': {
        cooldown.guard(positional[2], { force: Boolean(flags.force), action: 'navigate to' });
        let res = await ops.navigate(conn, targetId, positional[2], { waitUntil: flags.until || 'load', timeoutMs: timeoutMs || 30000 });
        if ((flags.until || 'load') !== 'none') res = await observe(conn, targetId, res);
        hint(res.url, flags);
        return out(res);
      }
      case 'wait':
        return out(
          await ops.waitFor(conn, targetId, {
            selector: flags.selector, text: flags.text, url: flags.url, gone: flags.gone, present: Boolean(flags.present),
            fn: flags.fn, networkIdle: Boolean(flags['network-idle']), timeoutMs: timeoutMs || 15000,
          }),
        );
      case 'click':
        return out(
          await ops.click(conn, targetId, {
            ...target,
            button: flags.button || 'left',
            clickCount: Number(flags.count || 1),
            modifiers: flags.mod ? String(flags.mod).split(',') : [],
          }),
        );
      case 'hover':
        return out(await ops.hover(conn, targetId, target));
      case 'drag':
        return out(await ops.drag(conn, targetId, { from: { ref: flags.from }, to: { ref: flags.to } }));
      case 'type':
        return out(await ops.type(conn, targetId, positional.slice(2).join(' ')));
      case 'key':
        return out(await ops.key(conn, targetId, positional[2]));
      case 'fill': {
        const value = flags.value ?? valueArg;
        if (value === undefined || value === true) throw new Error(`Usage: browserctrl fill ${tab.id} ref_5 "text"   (or --ref ref_5 --value "text")`);
        return out(await ops.fill(conn, targetId, { ...target, value }));
      }
      case 'select':
        return out(await ops.selectOption(conn, targetId, { ...target, value: flags.value, label: flags.label }));
      case 'upload':
        return out(await ops.upload(conn, targetId, { ...target, files: String(flags.files || '').split(',').filter(Boolean) }));
      case 'scroll':
        return out(await ops.scroll(conn, targetId, { deltaY: Number(flags.dy || 400), deltaX: Number(flags.dx || 0) }));
      case 'scroll-to':
        return out(await ops.scrollTo(conn, targetId, target));
      case 'captcha':
        return out(await captcha.solve(conn, targetId, { timeoutMs: Number(flags.timeout || 300000), attempt: !flags['no-attempt'], focus: !flags['no-focus'] }));
      case 'shot': {
        const res = await ops.screenshot(conn, targetId, {
          path: positional[2],
          fullPage: Boolean(flags.full), emulateFocus: Boolean(flags['emulate-focus']),
          ref: flags.ref,
          selector: flags.selector,
        });
        return out(`Saved ${res.path} (${Math.round(res.bytes / 1024)} KB, DPR=${res.dpr}; CSS px = image px / DPR)`);
      }
      case 'console': {
        const d = await ops.diagnostics(conn, targetId, { limit: Number(flags.limit || 50), clear: Boolean(flags.clear) });
        const rows = [...d.console.map(c => `[${c.level}] ${c.text}`), ...d.errors.map(e => `[error] ${e.text} (${e.url || ''}:${e.line ?? ''})`)];
        return out(rows.join('\n') || '(no console output buffered since the daemon attached to this tab)');
      }
      case 'network': {
        const rows = flags.failed
          ? await ops.failedRequests(conn, targetId, { limit: Number(flags.limit || 50) })
          : (await ops.diagnostics(conn, targetId, { limit: Number(flags.limit || 50) })).network;
        return out(rows.map(r => `${String(r.status ?? (r.failed ? 'ERR' : '...')).padEnd(4)} ${r.method.padEnd(5)} ${r.url.slice(0, 100)}${r.errorText ? `  ${r.errorText}` : ''}`).join('\n') || '(no requests buffered)');
      }
      case 'cookies':
        return out(await ops.cookies(conn, targetId));
      case 'close':
        return out(await ops.closeTab(conn, targetId));
      case 'focus':
        return out(await ops.focus(conn, targetId));
      case 'wake':
        return out(await ops.wake(conn, targetId, { enabled: !flags.off }));
      case 'reload':
      case 'refresh':
        if (flags.hard) return out(await ops.hardReload(conn, targetId, { timeoutMs: timeoutMs || 30000 }));
        try {
          return out(await ops.reload(conn, targetId, {waitUntil: flags.until || 'load', timeoutMs: timeoutMs || 30000}));
        } catch (e) {
          // A stuck page cannot run a reload: recover it instead (see ops.recoverTab).
          const d = await ops.diagnoseTab(conn, targetId);
          if (!['hung', 'crashed'].includes(d.kind)) throw e;
          const rc = await recoverTab(conn, targetId, { timeoutMs: Math.min(timeoutMs || 20000, 20000) });
          return out({ ...rc, note: `the page was not responding (${d.kind}); ${recoveryNote(rc)}` });
        }
      case 'dialog': {
        if (!flags.accept && !flags.dismiss) throw new Error(`Usage: browserctrl dialog ${tab.id} --accept | --dismiss [--text "prompt answer"]`);
        const open = (await conn.events(targetId, { limit: 1 }).catch(() => null))?.dialog;
        await conn.send(targetId, 'Page.handleJavaScriptDialog', { accept: Boolean(flags.accept), ...(typeof flags.text === 'string' ? { promptText: flags.text } : {}) }, 5000);
        return out({ answered: flags.accept ? 'accept' : 'dismiss', ...(open ? { dialog: { type: open.type, message: open.message } } : {}) });
      }
      case 'release':
        claims.release(port, targetId);
        return out({ released: tab.id });
      case 'overlay': {
        await ensureRunning();
        // The overlay refuses to install twice, so upgrading it needs an
        // explicit teardown of both the object and the DOM marker.
        const res = await ops.installOverlay(conn, targetId, { bridgePort: BRIDGE_PORT, force: Boolean(flags.force) });
        if (flags.on) await ops.toggleOverlay(conn, targetId);
        return out({ ...res, hotkey: 'option+A in the page toggles annotate mode', state: await ops.overlayState(conn, targetId) });
      }
      case 'name':
        if (!positional[2]) {
          state.clearAlias(port, targetId);
          return out({ cleared: tab.id });
        }
        return out(state.setAlias(port, targetId, positional[2]));
      case 'mark':
        return out({
          marked: tab.alias || tab.id,
          title: tab.title,
          ...state.mark(port, targetId, { note: flags.note === true ? null : flags.note, url: tab.url, title: tab.title }),
        });
      case 'unmark':
        return out({ unmarked: tab.alias || tab.id, wasMarked: state.unmark(port, targetId) });
      default:
        return out(usage());
    }
  } catch (e) {
    if (stillAfter) stillAfter.status = 'FAILED';
    throw e;
  } finally {
    if (stillAfter) await rec.still(conn, stillAfter.targetId, stillAfter.label, { status: stillAfter.status || 'SUCCESS', ifChanged: stillAfter.ifChanged && !stillAfter.status });
    for (const warning of conn.takeWarnings()) console.error(`Warning: ${warning}`);
    conn.close();
  }
};

main().catch(e => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
