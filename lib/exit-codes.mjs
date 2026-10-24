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

// The exit code for an error a command threw.
export function exitCodeFor(e) {
  if (Number.isInteger(e?.exitCode)) return e.exitCode;
  const msg = String(e?.message ?? e);
  if (['CLAIMED', 'AGENT_PAUSED'].includes(e?.code) || e?.cooldown || e?.name === 'CooldownError' || REFUSED.test(msg)) return EXIT.REFUSED;
  if (UNAVAILABLE.test(msg) || ['ECONNREFUSED', 'ENOENT'].includes(e?.code) && /socket|daemon/i.test(msg)) return EXIT.UNAVAILABLE;
  if (USAGE.test(msg)) return EXIT.USAGE;
  return EXIT.FAILED;
}

// An error that carries its exit code.
export function exitError(message, exitCode) {
  return Object.assign(new Error(message), { exitCode });
}
