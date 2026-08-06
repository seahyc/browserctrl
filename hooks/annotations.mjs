#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: put the human's pending browser
// annotations in front of the agent without them having to ask.
//
// Harness-specific by nature. The portable paths are the browser_annotations
// tool and the piggyback line on every browser_* result; this is the extra
// seamlessness Claude Code allows. Silent and fast when the queue is empty.
import { pending, render } from '../lib/annotations.mjs';
import { marks } from '../lib/state.mjs';

try {
  const rows = pending();
  const marked = marks();
  if (!rows.length && !marked.length) process.exit(0);

  const parts = [];
  if (rows.length) {
    parts.push(
      `The human left ${rows.length} browser annotation${rows.length === 1 ? '' : 's'} for you. ` +
        `Act on them if this message relates to them, then call browser_annotations with consume=true.\n\n${render(rows)}`,
    );
  }
  if (marked.length) {
    parts.push(
      `Tabs handed to you: ${marked
        .map(m => `${m.title || m.url || m.targetId.slice(0, 8)}${m.note ? ` (note: ${m.note})` : ''}`)
        .join('; ')}. Reach them with tab="marked".`,
    );
  }
  process.stdout.write(parts.join('\n\n'));
} catch {
  // A hook must never block a prompt.
  process.exit(0);
}
