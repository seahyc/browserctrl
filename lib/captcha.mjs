// Captchas on a tab: detect, try the kinds that are a plain drag, else hand
// the tab to the human and wait for it to clear.
//
// Alibaba's "drag to the far right" slider (the nc_ widget on Taobao and Tmall
// login and verification pages) is attempted once with a trusted mouse drag.
// A "slide to complete the puzzle" jigsaw is attempted once only when
// the opt-in solver is enabled for that site (lib/jigsaw.mjs). Everything else,
// and every failed attempt, goes to the human: the tab comes to the front, a
// sound and notification name the site, an optional phone ping runs, and the
// agent resumes as soon as the challenge is gone.
//
// Every challenge seen starts a cool-down for its site (lib/cooldown.mjs);
// seeing it gone ends the cool-down.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { setting, flag } from './config.mjs';
import * as ops from './ops.mjs';
import * as cooldown from './cooldown.mjs';
import * as jigsaw from './jigsaw.mjs';

// Runs in the page. Looks in the main frame and same-origin frames, returning
// page coordinates for the slider handle and its track when there is one.
const detectSource = jigsawSource => `(() => {
  const SLIDER = '#nc_1_n1z, .nc_iconfont.btn_slide, .btn_slide';
  const TRACK = '#nc_1__scale_text, .nc_scale, .nc-lang-cnt';
  const WORDS = /拖动到最右边|请按住滑块|滑动验证|拖动滑块完成拼图|slide to verify|slide to complete|complete the puzzle|drag the slider|verify you are human|security check|performing security verification|checking (if the site connection is secure|your browser)|verifying you are human/i;
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const frames = [{ doc: document, dx: 0, dy: 0 }];
  for (const f of document.querySelectorAll('iframe')) {
    try { const r = f.getBoundingClientRect(); if (f.contentDocument) frames.push({ doc: f.contentDocument, dx: r.left, dy: r.top }); } catch {}
  }
  for (const { doc, dx, dy } of frames) {
    const handle = [...doc.querySelectorAll(SLIDER)].find(visible);
    if (!handle) continue;
    const track = handle.closest(TRACK) || handle.parentElement;
    const h = handle.getBoundingClientRect(), t = track.getBoundingClientRect();
    return { kind: 'alibaba-slider', handle: { x: dx + h.left + h.width / 2, y: dy + h.top + h.height / 2 }, trackEnd: dx + t.right };
  }
  const jig = ${jigsawSource};
  if (jig) return jig;
  // A page whose address says it is a check (…/captcha, …/challenge, …/verify/captcha) is one.
  if (/\\/(captcha|challenge|bot-?check|security-check)(\\/|$)|\\/verify\\/(captcha|traffic|human|bot)/i.test(location.pathname)) return { kind: 'verification-page' };
  // Many sites embed an invisible hCaptcha/reCAPTCHA frame (0x0, or visibility:hidden);
  // only a frame a person can actually see is a challenge.
  const shown = f => { const r = f.getBoundingClientRect(), cs = getComputedStyle(f); return r.width >= 100 && r.height >= 60 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.1 && r.bottom > 0 && r.top < innerHeight; };
  if ([...document.querySelectorAll('iframe')].some(f => /captcha|punish|verify|baxia/i.test(f.src) && shown(f))) return { kind: 'framed-challenge' };
  const text = (document.body && document.body.innerText || '').slice(0, 5000);
  // A managed check page (Cloudflare's "Just a moment…"): it often clears by itself or on a reload.
  if (/^(just a moment|attention required)/i.test(document.title) || /performing security verification|checking (if the site connection is secure|your browser)/i.test(text)) return { kind: 'interstitial' };
  if (WORDS.test(text)) return { kind: 'unknown-challenge' };
  return null;
})()`;

export const detect = (conn, targetId) => ops.evaluate(conn, targetId, detectSource(jigsaw.discoverSource(jigsaw.readConfig().selectors)), { timeoutMs: 8000 });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const easeOut = t => 1 - (1 - t) ** 3;

// One drag from the handle to just past the track end, decelerating like a hand.
async function dragSlider(conn, targetId, { handle, trackEnd }, rand = Math.random) {
  const send = (type, x, y) => conn.send(targetId, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1 });
  const endX = trackEnd + 4;
  await conn.send(targetId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x - 30, y: handle.y + 8 });
  await sleep(120 + rand() * 120);
  await conn.send(targetId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y });
  await send('mousePressed', handle.x, handle.y);
  const steps = 28 + Math.floor(rand() * 10);
  for (let i = 1; i <= steps; i++) {
    const x = handle.x + (endX - handle.x) * easeOut(i / steps);
    const y = handle.y + (rand() - 0.5) * 3;
    await send('mouseMoved', Math.round(x), Math.round(y));
    await sleep(12 + rand() * 18);
  }
  await sleep(80 + rand() * 120);
  await send('mouseReleased', endX, handle.y);
}

const LABEL = {
  'alibaba-slider': 'slider check', 'jigsaw-slider': 'puzzle slider', 'verification-page': 'verification page',
  'framed-challenge': 'verification challenge', 'unknown-challenge': 'verification challenge', interstitial: 'bot check page',
};
const label = kind => LABEL[kind] || 'verification challenge';

// One line for read and text: what is in the way and the one command that deals with it, so
// an agent does not re-read a bot check page until its time runs out.
export async function notice(conn, targetId, tab) {
  const found = await detect(conn, targetId).catch(() => null);
  if (!found) return null;
  const trouble = await pageUrl(conn, targetId).then(u => (u ? ops.siteTrouble(u) : null)).catch(() => null);
  return `⚠ This page is a ${label(found.kind)}, not the site. Run: browserctrl captcha ${tab} (waits for it to clear and hands it to a person if needed). If it comes back after that, the site is refusing automated browsers: report that instead of retrying.${trouble ? ` ${trouble}` : ''}`;
}

const pageUrl = (conn, targetId) => ops.evaluate(conn, targetId, 'location.href', { timeoutMs: 5000 }).catch(() => null);

// Is `name` an executable on PATH? Checked in-process so a missing notifier costs nothing.
function onPath(name, { platform = process.platform, env = process.env } = {}) {
  const win = platform === 'win32';
  const dirs = String(env.PATH || env.Path || '').split(win ? ';' : ':').filter(Boolean);
  const exts = win ? ['', ...String(env.PATHEXT || '.EXE;.CMD').split(';')] : [''];
  return dirs.some(d => exts.some(x => { try { return fs.statSync(path.join(d, name + x)).isFile(); } catch { return false; } }));
}

// The commands that make a sound and show a desktop notification, per system, as
// [command, args, env] triples. Nothing is run here, so each system's choice can be tested.
// BROWSERCTRL_NOTIFY=0 silences everything; BROWSERCTRL_NOTIFY_SOUND picks a sound file, or 0 for none.
export function alertCommands(message, { platform = process.platform, env = process.env, has = n => onPath(n, { platform, env }) } = {}) {
  if (!flag('NOTIFY', true, env)) return [];
  const sound = setting('NOTIFY_SOUND', env);
  const out = [];
  if (platform === 'darwin') {
    out.push(['osascript', ['-e', `display notification ${JSON.stringify(message)} with title "browserctrl"`]]);
    if (sound !== '0') out.push(['afplay', [sound ?? '/System/Library/Sounds/Glass.aiff']]);
  } else if (platform === 'win32') {
    // A balloon from a short-lived hidden PowerShell: it never blocks the agent. The text goes in
    // through the environment, so quotes in it cannot break the script.
    const play = sound && sound !== '0' ? '(New-Object System.Media.SoundPlayer $env:BROWSERCTRL_ALERT_SOUND).PlaySync()' : sound === '0' ? '' : '[console]::beep(880,300)';
    const script = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;" +
      "$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;" +
      "$n.ShowBalloonTip(10000,'browserctrl',$env:BROWSERCTRL_ALERT_TEXT,'Info');" + play + ";Start-Sleep -Seconds 10;$n.Dispose()";
    out.push(['powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { BROWSERCTRL_ALERT_TEXT: message, BROWSERCTRL_ALERT_SOUND: sound ?? '' }]);
  } else {
    if (has('notify-send')) out.push(['notify-send', ['--app-name=browserctrl', 'browserctrl', message]]);
    // Linux has no standard alert sound, so one plays only when a file is named.
    if (sound && sound !== '0') {
      const player = ['paplay', 'aplay', 'afplay'].find(has);
      if (player) out.push([player, [sound]]);
    }
  }
  return out;
}

function alertHuman(message) {
  for (const [cmd, args, extraEnv] of alertCommands(message)) {
    try {
      const child = execFile(cmd, args, { env: extraEnv ? { ...process.env, ...extraEnv } : process.env, windowsHide: true }, () => {});
      child.on('error', () => {});
    } catch {}
  }
}

// Optional phone ping: BROWSERCTRL_NOTIFY_CMD runs through the shell with the
// message as its last argument ("$1"), so it may carry its own arguments.
// browserctrl never sends anything itself.
export function ping(message, cmd = setting('NOTIFY_CMD')) {
  if (!cmd) return Promise.resolve(null);
  return new Promise(resolve => {
    const child = process.platform === 'win32'
      ? execFile(cmd, [message], { shell: true, timeout: 30000 }, e => resolve(e ? `failed: ${e.message}` : 'sent'))
      : execFile('/bin/sh', ['-c', `${cmd} "$1"`, 'browserctrl-notify', message], { timeout: 30000 }, e => resolve(e ? `failed: ${e.message}` : 'sent'));
    child.on('error', e => resolve(`failed: ${e.message}`));
  });
}

// Hand the tab to the human: bring it to the front, sound, notify, ping, then
// poll until the challenge is gone. Resolves with how long the human took;
// throws when the wait runs out.
export async function handoff(conn, targetId, { found, url, timeoutMs = 300000, pollMs = 1000, focus = true, reloadOnTimeout = true } = {}) {
  url ||= await pageUrl(conn, targetId);
  found ||= await detect(conn, targetId);
  if (!found) { cooldown.clear(url); return { captcha: null }; }
  const site = cooldown.siteOf(url) || 'the page';
  const message = `${site} shows a ${label(found.kind)}. The tab is in front: solve it and the agent carries on (waiting up to ${Math.round(timeoutMs / 60000) || 1} min).`;
  if (focus) await ops.focus(conn, targetId).catch(() => {});
  alertHuman(message);
  const pinged = ping(message);
  const started = Date.now();
  const deadline = started + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      const still = await detect(conn, targetId).catch(() => found);
      if (!still) {
        cooldown.clear(url);
        return { captcha: found.kind, solvedBy: 'human', waitedMs: Date.now() - started };
      }
    }
  } finally {
    await Promise.race([pinged, sleep(3000)]);
  }
  // Not cleared in time: a managed check page (Cloudflare's "Just a moment…") often passes on
  // a fresh load, so try one reload, as a person would. A puzzle is not reloaded: that only
  // serves a new puzzle and looks more like a bot.
  const reloads = reloadOnTimeout && found.kind === 'interstitial';
  if (reloads) {
    await ops.reload(conn, targetId, { timeoutMs: 30000 }).catch(() => {});
    for (const end = Date.now() + 5000; Date.now() < end;) {
      if (!(await detect(conn, targetId).catch(() => found))) { cooldown.clear(url); return { captcha: found.kind, solvedBy: 'reload', waitedMs: Date.now() - started }; }
      await sleep(Math.min(pollMs, 500));
    }
  }
  const cool = cooldown.active(url);
  throw Object.assign(new Error(`The ${found.kind} on ${site} (tab ${targetId.slice(0, 8)}) was not cleared within ${Math.round(timeoutMs / 1000)}s.` +
    (reloads ? ' A reload did not clear it either.' : '') +
    (cool ? ` ${site} is cooling down until ${new Date(cool.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; do not retry into the challenge.` : '')), { challenge: found });
}

// Wait up to a few seconds for an attempted challenge to go away.
async function clearedSoon(conn, targetId, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    await sleep(300);
    if (!(await detect(conn, targetId).catch(() => true))) return true;
  }
  return false;
}

// Look at a tab after a load: record a challenge (starting the site's
// cool-down) or, when there is none, end any cool-down for the site.
export async function observe(conn, targetId) {
  const [found, url] = await Promise.all([detect(conn, targetId).catch(() => null), pageUrl(conn, targetId)]);
  if (!url || !/^https?:/.test(url)) return null;
  if (!found) { cooldown.clear(url); return null; }
  return { ...found, url, cooldown: cooldown.record(url, { kind: found.kind }) };
}

// Detect and clear a captcha on the tab. Returns how it cleared, or throws when
// it was not cleared in time (or at once, with handoff: false).
export async function solve(conn, targetId, { timeoutMs = 300000, attempt = true, pollMs = 1000, handoff: handOff = true, focus = true } = {}) {
  const found = await detect(conn, targetId);
  const url = await pageUrl(conn, targetId);
  if (!found) { cooldown.clear(url); return { captcha: null }; }
  cooldown.record(url, { kind: found.kind });
  const extra = {};
  if (attempt && found.kind === 'alibaba-slider') {
    await dragSlider(conn, targetId, found);
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      if (!(await detect(conn, targetId))) { cooldown.clear(url); return { captcha: found.kind, solvedBy: 'auto' }; }
    }
  }
  if (found.kind === 'jigsaw-slider') {
    if (!attempt) extra.solver = 'not attempted';
    else if (!jigsaw.solverEnabled(url)) extra.solver = `off for ${cooldown.siteOf(url)} (browserctrl captcha solver enable <site> to opt in)`;
    else {
      try {
        const r = await jigsaw.solveJigsaw(conn, targetId, found, { focus });
        if (r.attempted && await clearedSoon(conn, targetId)) { cooldown.clear(url); return { captcha: found.kind, solvedBy: 'solver', solver: r }; }
        extra.solver = { ...r, failed: true };
      } catch (e) { extra.solver = { failed: true, error: e.message }; }
    }
  }
  if (!handOff) {
    const cool = cooldown.active(url);
    throw Object.assign(new Error(`A ${found.kind} blocks tab ${targetId.slice(0, 8)} on ${cooldown.siteOf(url)}; handoff was skipped.` +
      (cool ? ` The site is cooling down until ${new Date(cool.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '') +
      ` Hand it to the human with: browserctrl captcha ${targetId.slice(0, 8)}`), { challenge: found });
  }
  try {
    return { ...(await handoff(conn, targetId, { found, url, timeoutMs, pollMs, focus })), ...extra };
  } catch (e) { throw Object.assign(e, extra); }
}
