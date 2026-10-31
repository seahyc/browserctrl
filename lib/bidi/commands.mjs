// The shared command set on an open WebDriver BiDi session. Used by the BiDi daemon, which
// keeps one session per port: Camoufox numbers browsing contexts per session, so tab ids are
// stable only while one session lives.

import * as currentTab from '../current-tab.mjs';
import * as ops from './ops.mjs';

export const BIDI_COMMANDS = new Set([
  'tabs', 'open', 'close', 'focus', 'wake', 'nav', 'read', 'text', 'html', 'eval', 'shot', 'click', 'hover',
  'fill', 'type', 'key', 'select', 'scroll', 'wait', 'status', 'doctor', 'stop', 'use', 'launch',
]);

export const usageError = message => Object.assign(new Error(message), { exitCode: 2 });

/** Run one command on session s. owner is the calling agent (its current tab). */
export async function runCommand(s, { cmd, positional, flags, port, key, owner }) {
  // "." or an omitted tab is this agent's current tab (open and use set it).
  const tabWord = positional[1];
  const contextFor = async (word = tabWord) => {
    if (word === undefined || word === '.') {
      const cur = currentTab.get(port, { owner });
      if (!cur) throw usageError(`No tab given, and this agent has no current tab on port ${port}. Name one (browserctrl tabs --browser ${key}), or open one.`);
      return ops.resolveContext(s, cur.targetId);
    }
    return ops.resolveContext(s, word);
  };
  switch (cmd) {
    case 'status': case 'doctor': return { data: await ops.status(s, port) };
    case 'tabs': {
      const rows = await ops.tabs(s);
      if (flags.json || flags.jsonl) return { data: rows };
      return { text: rows.map(r => `${r.id}  ${r.title || '(untitled)'}  ${r.url}`).join('\n') || '(no tabs)' };
    }
    case 'open': {
      const r = await ops.open(s, positional[1]);
      currentTab.set(port, r.context, { owner });
      return flags.id ? { text: r.id } : { data: r };
    }
    case 'use': {
      const context = await ops.resolveContext(s, positional[1]);
      currentTab.set(port, context, { owner });
      return { data: { current: ops.shortId(context) } };
    }
    case 'close': {
      const context = await contextFor();
      const r = await ops.close(s, context);
      currentTab.clear(port, { owner, targetId: context });
      return { data: r };
    }
    case 'focus': case 'wake': return { data: await ops.focus(s, await contextFor()) };
    case 'nav': return { data: await ops.nav(s, await contextFor(), positional[2]) };
    case 'read': {
      const snap = await ops.read(s, await contextFor(), { all: Boolean(flags.all) });
      return flags.json ? { data: snap } : { text: ops.formatRead(snap) };
    }
    case 'text': return { text: await ops.text(s, await contextFor()) };
    case 'html': return { text: await ops.html(s, await contextFor()) };
    case 'eval': {
      const expression = positional.slice(2).join(' ');
      if (!expression) throw usageError('Usage: browserctrl eval <tab> <expression>');
      return { data: await ops.evaluate(s, await contextFor(), expression) };
    }
    case 'shot': {
      const r = await ops.shot(s, await contextFor(), { file: positional[2], full: Boolean(flags.full) });
      return flags.json ? { data: r } : { text: `Saved ${r.path} (${Math.round(r.bytes / 1024)} KB)` };
    }
    case 'click': return { data: await ops.click(s, await contextFor(), ops.targetOf(positional, flags), { button: flags.button === 'right' ? 2 : flags.button === 'middle' ? 1 : 0, count: Number(flags.count || 1) }) };
    case 'hover': return { data: await ops.hover(s, await contextFor(), ops.targetOf(positional, flags)) };
    case 'fill': {
      const target = ops.targetOf(positional, flags);
      const value = flags.value !== undefined ? String(flags.value) : positional.slice(target && !flags.ref && !flags.selector ? 3 : 2).join(' ');
      return { data: await ops.fill(s, await contextFor(), target, value) };
    }
    case 'type': {
      const target = flags.ref || flags.selector ? ops.targetOf(positional, flags) : null;
      return { data: await ops.type(s, await contextFor(), positional.slice(2).join(' '), target) };
    }
    case 'key': return { data: await ops.key(s, await contextFor(), positional[2]) };
    case 'select': {
      const target = ops.targetOf(positional, flags);
      const option = flags.label ?? flags.value ?? positional[target && !flags.ref && !flags.selector ? 3 : 2];
      return { data: await ops.select(s, await contextFor(), target, option === undefined ? undefined : String(option)) };
    }
    case 'scroll': return { data: await ops.scroll(s, await contextFor(), { to: positional[2], dy: flags.dy }) };
    case 'wait': {
      const r = await ops.wait(s, await contextFor(), {
        text: flags.text === undefined ? undefined : String(flags.text),
        url: flags.url === undefined ? undefined : String(flags.url),
        selector: flags.selector === undefined ? undefined : String(flags.selector),
        gone: Boolean(flags.gone), timeoutMs: Number(flags.timeout || 15000),
      });
      return { data: r, exitCode: r.met ? 0 : 1 };
    }
    default: throw usageError(`Unsupported command ${cmd}`);
  }
}
