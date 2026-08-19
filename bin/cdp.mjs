#!/usr/bin/env node
// CLI frontend. Thin: parse args, call lib/ops, print. No protocol logic here.
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connect } from '../lib/daemon.mjs';
import { listBrowsers, requireBrowser } from '../lib/discovery.mjs';
import { BROWSERS } from '../lib/env.mjs';
import * as ops from '../lib/ops.mjs';
import * as ext from '../lib/ext.mjs';
import * as claims from '../lib/claims.mjs';
import * as state from '../lib/state.mjs';
import * as annotations from '../lib/annotations.mjs';
import { ensureRunning, BRIDGE_PORT } from '../lib/bridge.mjs';

const MUTATING = new Set([
  'nav', 'click', 'hover', 'drag', 'type', 'key', 'fill', 'select', 'upload', 'scroll', 'scroll-to', 'close',
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

function usage() {
  return `cdp — cross-browser CDP control

  Pick a browser first. There is no default:
    cdp browsers                                 what is debuggable right now
    cdp launch dia                               relaunch a browser with its debug port
    cdp tabs --browser dia                       tabs, with who has claimed them

  Read before you act:
    cdp read <tab> --browser dia                 snapshot with ref_1..N + page text
    cdp text <tab>                               visible text only
    cdp html <tab> [selector]
    cdp eval <tab> <js>

  Act (all accept --ref ref_3, --selector <css>, or --x/--y):
    cdp click <tab> --ref ref_3 [--button right] [--count 2] [--mod cmd,shift]
    cdp hover <tab> --selector ".menu"
    cdp fill  <tab> --ref ref_5 --value "text"
    cdp select <tab> --ref ref_7 --label "Option"
    cdp type  <tab> "literal text"
    cdp key   <tab> Enter | cmd+a | shift+Tab
    cdp upload <tab> --ref ref_2 --files a.pdf,b.png
    cdp scroll <tab> [--dy 600]     cdp scroll-to <tab> --ref ref_9
    cdp drag <tab> --from ref_1 --to ref_2

  Navigate and wait (no blind sleeps):
    cdp nav <tab> <url> [--until load|domcontentloaded|networkidle|none]
    cdp wait <tab> --selector ".done" | --text "Saved" | --url /success | --gone ".spinner" | --network-idle
                   [--timeout 15000]

  See what happened:
    cdp shot <tab> [file] [--full] [--ref ref_3] [--selector css]
    cdp console <tab> [--limit 50] [--clear]
    cdp network <tab> [--failed]
    cdp cookies <tab>

  Tabs and claims:
    cdp open <url> --browser dia     cdp close <tab>     cdp wake <tab>
    cdp claims [--browser dia]       cdp release [<tab>|--mine]
    cdp status --browser dia         cdp stop --browser dia

  Every command takes --browser <${Object.keys(BROWSERS).join('|')}> or --port <n>.
  Add --steal to take a tab another agent has claimed.`;
}

async function launch(name) {
  const meta = BROWSERS[String(name).toLowerCase()];
  if (!meta) throw new Error(`Unknown browser "${name}". Known: ${Object.keys(BROWSERS).join(', ')}`);
  const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, e => (e ? rej(e) : res())));
  await run('/usr/bin/osascript', ['-e', `tell application "${meta.app}" to quit`]).catch(() => {});
  for (let i = 0; i < 20; i += 1) {
    const running = await new Promise(res => execFile('/usr/bin/pgrep', ['-x', meta.app], e => res(!e)));
    if (!running) break;
    await new Promise(r => setTimeout(r, 500));
  }
  // Load the handoff extension alongside the debug port, so a browser started
  // this way has both halves: CDP for the agent, extension UI for the human.
  // Chrome 137+ ignores --load-extension for non-enterprise profiles; other
  // Chromium forks still honour it. Where it is ignored, load it once from
  // chrome://extensions instead and it persists in the profile.
  const extension = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
  const args = [`--remote-debugging-port=${meta.port}`];
  if (!flags['no-extension'] && fs.existsSync(extension)) args.push(`--load-extension=${extension}`);
  await run('/usr/bin/open', ['-a', meta.app, '--args', ...args]);
  return {
    launched: meta.label,
    port: meta.port,
    extension: args.length > 1 ? extension : 'not loaded',
    note: 'Tabs are restored by the browser; the debug port is live once it finishes starting.',
  };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const cmd = positional[0];

const main = async () => {
  if (!cmd || cmd === 'help' || flags.help) return out(usage());

  if (cmd === 'browsers') {
    const rows = await listBrowsers();
    return out(
      rows
        .map(b => {
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

  if (cmd === 'launch') return out(await launch(positional[1]));

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

  if (cmd === 'bridge') {
    await ensureRunning();
    return out({ bridge: `http://127.0.0.1:${BRIDGE_PORT}`, tray: `http://127.0.0.1:${BRIDGE_PORT}/tray` });
  }

  if (cmd === 'record' && positional[1] === 'stop') {
    await ensureRunning();
    const id = positional[2] || (await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings`)).json()).find(r => !r.stoppedAt)?.id;
    if (!id) throw new Error('No recording is running.');
    const res = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings/${id}/stop`, { method: 'POST' })).json();
    return out({
      ...res,
      next: res.hasVideo ? `cdp annotate ${id} --browser <name>` : `cdp recording ${id} --steps`,
    });
  }

  if (cmd === 'recordings') {
    await ensureRunning();
    const rows = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings`)).json();
    return out(
      rows.length
        ? rows.map(r => `${r.id}  ${r.stoppedAt ? 'done' : 'RECORDING'}  ${r.events} events  ${r.marks} marks${r.label ? `  ${r.label}` : ''}`).join('\n')
        : '(no recordings)',
    );
  }

  if (cmd === 'recording') {
    await ensureRunning();
    const id = positional[1];
    if (!id) throw new Error('Which recording? See: cdp recordings');
    if (flags.steps) return out(await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings/${id}/steps`)).text());
    const marks = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings/${id}/marks`)).json();
    if (flags.json) return out(marks);
    const summary = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings/${id}`)).json();
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
  try {
    if (cmd === 'status') return out(await conn.status());
    if (cmd === 'stop') {
      await conn.stop().catch(() => {});
      return out(`Daemon stopped for port ${port}`);
    }
    if (cmd === 'tabs') {
      const rows = await ops.tabs(conn, { focus: !flags['no-focus'] });
      return out(
        rows
          .map(t => {
            const tags = [];
            if (t.focused) tags.push('←you');
            if (t.marked) tags.push(`marked${t.marked.note ? `: ${t.marked.note}` : ''}`);
            if (t.suspended) tags.push('suspended');
            if (t.claimedBy) tags.push(t.claimedBy);
            const name = t.alias ? `${t.alias} (${t.id})` : t.id;
            return `${name.padEnd(22)} ${(t.title || '').slice(0, 38).padEnd(38)}  ${t.url.slice(0, 52)}${tags.length ? `  [${tags.join(' | ')}]` : ''}`;
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
      const trayUrl = `http://127.0.0.1:${BRIDGE_PORT}/tray`;
      await ops.newTab(conn, trayUrl);
      return out({ tray: trayUrl });
    }
    if (cmd === 'record') {
      await ensureRunning();
      const sub = positional[1];
      if (sub === 'start') {
        const meta = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port, video: Boolean(flags.video), apps: flags.apps !== 'false', label: flags.label === true ? null : flags.label }),
        })).json();
        return out({ ...meta, note: 'Drive the browser now. Stop with: cdp record stop ' + meta.id });
      }
      if (sub === 'stop') {
        const id = positional[2] || (await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings`)).json()).find(r => !r.stoppedAt)?.id;
        if (!id) throw new Error('No recording is running.');
        const res = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/recordings/${id}/stop`, { method: 'POST' })).json();
        return out({ ...res, annotate: res.hasVideo ? `cdp annotate ${id} --browser <name>` : 'no video: read the steps with cdp recording ' + id + ' --steps' });
      }
      if (sub === 'arm') {
        const st = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/prewarm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port }),
        })).json();
        return out({ ...st, note: 'Capture is warming. `cdp record start --video` will adopt it, so the first seconds are on film.' });
      }
      if (sub === 'disarm') {
        return out(await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/prewarm`, { method: 'DELETE' })).json());
      }
      if (sub === 'status') {
        return out(await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/prewarm`)).json());
      }
      throw new Error('Usage: cdp record start|stop [id] | cdp record arm|disarm|status');
    }
    if (cmd === 'annotate') {
      await ensureRunning();
      const id = positional[1];
      const url = `http://127.0.0.1:${BRIDGE_PORT}/annotator?id=${encodeURIComponent(id)}`;
      await ops.newTab(conn, url);
      return out({ annotator: url });
    }
    if (cmd === 'ext') {
      const sub = positional[1];
      if (!sub || sub === 'info') return out(await ext.info(port));
      if (sub === 'group') {
        const pats = (flags.url || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!pats.length) throw new Error('Usage: cdp ext group --url <substr>[,<substr>...] [--title T] [--color blue] [--collapsed]');
        return out(await ext.evaluate(port, `__cdpAgent.groupByUrl(${JSON.stringify(pats)}, ${JSON.stringify({
          title: flags.title || 'agent',
          color: flags.color || 'blue',
          collapsed: Boolean(flags.collapsed),
        })})`));
      }
      if (sub === 'outline') return out(await ext.evaluate(port, '__cdpAgent.outline()'));
      if (sub === 'undo-close') return out(await ext.evaluate(port, '__cdpAgent.undoClose()'));
      if (sub === 'eval') {
        const expr = positional.slice(2).join(' ');
        if (!expr) throw new Error('Usage: cdp ext eval "chrome.bookmarks.getTree()"');
        return out(await ext.evaluate(port, expr));
      }
      throw new Error('Usage: cdp ext [info] | group --url a,b | outline | undo-close | eval <chrome.* expression>');
    }
    if (cmd === 'open') {
      const res = await ops.newTab(conn, positional[1]);
      if (flags.until !== 'none' && positional[1]) {
        await ops.waitForReady(conn, res.targetId, { waitUntil: flags.until || 'load' }).catch(() => {});
      }
      return out(res);
    }

    const tab = await ops.resolveTab(conn, positional[1]);
    const targetId = tab.targetId;
    if (MUTATING.has(cmd)) claims.claim(port, targetId, { steal: Boolean(flags.steal) });

    const target = {
      ref: flags.ref,
      selector: flags.selector,
      x: flags.x !== undefined ? Number(flags.x) : undefined,
      y: flags.y !== undefined ? Number(flags.y) : undefined,
      token: flags.token,
    };
    const timeoutMs = flags.timeout ? Number(flags.timeout) : undefined;

    switch (cmd) {
      case 'read': {
        const snap = await ops.readPage(conn, targetId, {
          maxText: flags.text === 'none' ? 0 : Number(flags['max-text'] || 20000),
          max: Number(flags.max || 400),
          includeHidden: Boolean(flags['include-hidden']),
        });
        const lines = snap.elements.map(
          e => `${e.ref.padEnd(8)} ${e.role.padEnd(10)} ${(e.name || '').slice(0, 60).padEnd(60)}${e.testid ? ` [${e.testid}]` : ''}${e.disabled ? ' (disabled)' : ''}`,
        );
        return out(
          `${snap.title}\n${snap.url}\ntoken: ${snap.token}   scroll ${snap.scroll.y}/${snap.scroll.h}\n\n` +
            `${lines.join('\n')}\n\n--- text${snap.textTruncated ? ` (truncated from ${snap.textLength})` : ''} ---\n${snap.text}`,
        );
      }
      case 'text':
        return out(await ops.evaluate(conn, targetId, 'document.body ? document.body.innerText : ""'));
      case 'html':
        return out(await ops.html(conn, targetId, positional[2]));
      case 'eval':
        return out(await ops.evaluate(conn, targetId, positional.slice(2).join(' '), { timeoutMs }));
      case 'nav':
        return out(await ops.navigate(conn, targetId, positional[2], { waitUntil: flags.until || 'load', timeoutMs: timeoutMs || 30000 }));
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
      case 'fill':
        return out(await ops.fill(conn, targetId, { ...target, value: flags.value ?? positional[2] }));
      case 'select':
        return out(await ops.selectOption(conn, targetId, { ...target, value: flags.value, label: flags.label }));
      case 'upload':
        return out(await ops.upload(conn, targetId, { ...target, files: String(flags.files || '').split(',').filter(Boolean) }));
      case 'scroll':
        return out(await ops.scroll(conn, targetId, { deltaY: Number(flags.dy || 400), deltaX: Number(flags.dx || 0) }));
      case 'scroll-to':
        return out(await ops.scrollTo(conn, targetId, target));
      case 'shot': {
        const res = await ops.screenshot(conn, targetId, {
          path: positional[2] || '/tmp/cdp-shot.png',
          fullPage: Boolean(flags.full),
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
      case 'wake':
        return out(await ops.wake(conn, targetId));
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
  } finally {
    conn.close();
  }
};

main().catch(e => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
