// The CLI's exit codes, one scheme for every command (references/scripting.md):
//   0 success, or the thing was found
//   1 a negative answer: nothing matched (find, text --match), a wait or check condition is false
//   2 usage: unknown command or flag value, bad pattern, plan syntax
//   3 a do plan stopped before its end (its report says why), or --intent would not pick
//   4 no browser or daemon to talk to
//   5 refused by a guard before acting: another agent's claim, a paused agent, a site cooling
//     down, a vault-tainted tab, a click that would commit
//   6 the command failed for another reason (timeout, closed tab, page error)
export const EXIT = { OK: 0, NO: 1, USAGE: 2, STOPPED: 3, UNAVAILABLE: 4, REFUSED: 5, FAILED: 6 };

const USAGE = /^(Usage:|Unknown command|Unknown browser|Invalid (pattern|--match|regex)|No browser specified|Native commands require|Safari uses native|Which recording|step [^,]+, line \d+, column \d+:|--[\w-]+ (must|needs|and --[\w-]+ are)|watch-seconds must|args must be JSON|"[^"]*" is not a ref|\S+ is an item id|Cannot read the plan|do - reads|The plan is empty)/;
const UNAVAILABLE = /No browser is debuggable|No Chromium-family browser|Daemon failed to become ready|Daemon IPC is unresponsive|Could not acquire daemon socket|daemon_retiring|transport is retiring|handoff extension is not loaded|ECONNREFUSED|Safari daemon (connection timed out|is stopping)/;
const REFUSED = /is claimed by|busy with another agent|blocked by another agent|blocked while a tab is claimed|Browser activity paused|is cooling down after|^tab_tainted|tab_not_dedicated|sensitive_phase_blocked|intents never click it/;

// The Safari daemon's error codes (lib/safari-daemon.mjs, lib/safari.mjs), by meaning.
const SAFARI_CODES = {
  CLAIMED: EXIT.REFUSED, AGENT_PAUSED: EXIT.REFUSED, SENSITIVE_PHASE: EXIT.REFUSED, PROTECTED_HISTORY: EXIT.REFUSED,
  TAB_REQUIRED: EXIT.USAGE, TAB_MISMATCH: EXIT.USAGE, INVALID_TAB_HANDLE: EXIT.USAGE, INVALID_ARGUMENTS: EXIT.USAGE,
  UNKNOWN_TOOL: EXIT.USAGE, INVALID_OWNER: EXIT.USAGE, INVALID_JSON: EXIT.USAGE, INVALID_REQUEST: EXIT.USAGE,
  INVALID_OPERATION: EXIT.USAGE, REQUEST_TOO_LARGE: EXIT.USAGE,
  DAEMON_STOPPING: EXIT.UNAVAILABLE, SAFARI_DISCONNECTED: EXIT.UNAVAILABLE, SAFARI_UNAVAILABLE: EXIT.UNAVAILABLE,
  SWITCH_FAILED: EXIT.FAILED, DAEMON_BUSY: EXIT.FAILED, QUEUE_FULL: EXIT.FAILED, CALLER_DISCONNECTED: EXIT.FAILED,
};
// Safari's own messages: a shared command or flag it has no equivalent for is a usage error;
// a Safari that cannot be reached is unavailable.
const SAFARI_USAGE = /^(Safari (does not support|shared actions do not support|interactions use node UIDs|requires a node UID|uses node UIDs|uses its own automation session|currently supports viewport|tool arguments must be|timeout must be|tab handles must be)|Focus emulation is a Chromium feature|Unknown Safari MCP tool|This Safari tool needs an explicit tab handle|Unsupported reload wait mode|Reload timeout must be)/;
const SAFARI_UNAVAILABLE = /^(Safari daemon did not become available|Could not start Safari’s official MCP server|Safari provider is available only on macOS|The official Safari MCP server is available only on macOS|Safari native connection closed)/;

// The exit code of a Safari tool result: 0, or for one Safari reported as an error (isError)
// 5 when its text says a guard refused it, else 6.
export function safariResultCode(result) {
  if (!result?.isError) return EXIT.OK;
  const text = (result.content || []).map(c => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  return REFUSED.test(text) ? EXIT.REFUSED : EXIT.FAILED;
}

// The exit code for an error a command threw.
export function exitCodeFor(e) {
  if (Number.isInteger(e?.exitCode)) return e.exitCode;
  const msg = String(e?.message ?? e);
  if (typeof e?.code === 'string' && SAFARI_CODES[e.code] !== undefined) return SAFARI_CODES[e.code];
  if (SAFARI_USAGE.test(msg)) return EXIT.USAGE;
  if (SAFARI_UNAVAILABLE.test(msg)) return EXIT.UNAVAILABLE;
  if (['CLAIMED', 'AGENT_PAUSED'].includes(e?.code) || e?.cooldown || e?.name === 'CooldownError' || REFUSED.test(msg)) return EXIT.REFUSED;
  if (UNAVAILABLE.test(msg) || ['ECONNREFUSED', 'ENOENT'].includes(e?.code) && /socket|daemon|\.sock\b/i.test(msg)) return EXIT.UNAVAILABLE;
  if (USAGE.test(msg)) return EXIT.USAGE;
  return EXIT.FAILED;
}

// An error that carries its exit code.
export function exitError(message, exitCode) {
  return Object.assign(new Error(message), { exitCode });
}
