"""Compare the arms of an ab.mjs run group. Stdlib only.

  python3 -I bench/om2w/compare.py <group> [--base <arm>] [--gate N] [--json out.json]
  python3 -I bench/om2w/compare.py --group <group> ...      (same; <group> may also be a .jsonl path)

Per run, from Codex's rollout: turns (model responses, a burst of parallel tool calls counted
once, +1 for the final answer), browserctrl and do calls, steps per do plan, plan forms
(if/for top/each/try/pick/extract as/answer), stalls (a browserctrl command whose wall time
exceeded its own reported work by more than 60 s, or that never returned). Per arm: medians
over runs. Paired: each task's mean over its repeats, arm minus base, with a two-sided sign
test over tasks and a bootstrap 95% CI (tasks resampled, then repeats within each task).
Flags runs that started at load >= the gate, stalled, timed out, or needed a retry.

Per run, from the BROWSERCTRL_CLIENT_TIMING files run.mjs writes (client-timing.jsonl for the
agent's commands, watcher-timing.jsonl for the harness's 4 s reads): the slowest command, the
longest wait to reach the daemon (connect), the longest wait after a command's work (post: a
recording still, exit), the browser's share of IPC time (what the daemon did not spend before
sending), and how many agent commands overlapped a watcher read. Matched against the rollout:
launch lag (Codex's call to the CLI process starting) and return lag (the process exiting to
Codex returning its output; Codex yields a running command after about 31 s, so a cell still
running then counts until that yield), and calls that never started a process. A command over
20 s, or a lag over 20 s, is flagged with its breakdown."""
import argparse, glob, json, math, os, random, re, statistics, sys
from datetime import datetime

RESULTS = os.path.expanduser('~/.local/share/browserctrl-bench/results')
SESSIONS = os.path.join(os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex'), 'sessions')
FORMS = re.compile(r"(?:^|[\s'\"])(if \"|if \$|for top|each \"|try (?:pick|click)|same page|pick \"[^\"]*\" top|extract \"[^\"]*\"(?: as)|answer \")")
BC_SUB = re.compile(r"(?:^|[;&|\s(])(?:browserctrl|cdp)\s+(?:--\S+\s+)*([a-z][\w-]*)")


def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()


def parse_rollout(f):
    """Tool calls (with call and output times) and finished shell commands from a Codex rollout."""
    calls, order, cmds = {}, [], []
    for line in open(f):
        try: e = json.loads(line)
        except ValueError: continue
        p = e.get('payload') or {}
        typ = p.get('type') if isinstance(p, dict) else None
        t = ts(e['timestamp'])
        if typ in ('custom_tool_call', 'function_call'):
            c = {'t_call': t, 'input': str(p.get('input') if typ == 'custom_tool_call' else p.get('arguments'))}
            calls[p['call_id']] = c; order.append(c)
        elif typ in ('custom_tool_call_output', 'function_call_output'):
            c = calls.get(p['call_id'])
            if c is not None: c['t_out'] = t; c['output'] = str(p.get('output'))
        elif typ == 'item_completed' and (p.get('item') or {}).get('type') == 'CommandExecution':
            it = p['item']
            cmd = it['command'][-1] if isinstance(it['command'], list) else it['command']
            m = BC_SUB.search(cmd)
            dur = it.get('duration') or {}
            cmds.append({'cmd': cmd, 'cls': 'bc:' + m.group(1) if m else 'other', 'dur': dur.get('secs', 0) + dur.get('nanos', 0) / 1e9, 'out': it.get('aggregated_output') or ''})
    return order, cmds


def turns_of(calls):
    n, i = 0, 0
    while i < len(calls):
        c = calls[i]
        while i + 1 < len(calls) and calls[i + 1]['t_call'] - c['t_call'] < 0.05 and 't_out' in c and calls[i + 1]['t_call'] < c.get('t_out', 1e18): i += 1
        i += 1; n += 1
    return n + 1


def stalls_of(calls):
    n = 0
    for c in calls:
        if 'browserctrl' not in c['input']: continue
        o = c.get('output', '')
        # As in the earlier analyses: no output, or one without an exit (the command was
        # still running when Codex yielded), counts as never returned.
        if 't_out' not in c or not ('Script completed' in o or 'exit_code' in o or 'Process exited' in o): n += 1; continue
        m = re.search(r'total (\d+) ms', o)
        if c['t_out'] - c['t_call'] - (int(m.group(1)) / 1000 if m else 0) > 60: n += 1
    return n


def find_rollout(run_dir):
    try:
        m = re.search(r'"thread_id":"([^"]+)"', open(os.path.join(run_dir, 'agent-events.jsonl')).read(4096))
    except OSError: return None
    if not m: return None
    hits = glob.glob(os.path.join(SESSIONS, '*', '*', '*', f'*{m.group(1)}.jsonl'))
    return hits[0] if hits else None


def metrics(row):
    out = {'turns': None, 'bc_calls': None, 'do_calls': None, 'steps_per_do': None, 'forms': None, 'stalls': None}
    f = row.get('rollout') if row.get('rollout') and os.path.exists(row['rollout']) else (find_rollout(row['run_dir']) if row.get('run_dir') else None)
    if not f: return out
    calls, cmds = parse_rollout(f)
    bc = [c for c in cmds if c['cls'].startswith('bc:')]
    dos = [c for c in bc if c['cls'] == 'bc:do']
    steps = [n for n in (len(re.findall(r"'(?:[^'\\]|\\.)*'", c['cmd'].split(' do ', 1)[-1])) for c in dos) if n]
    out.update(turns=turns_of(calls), bc_calls=len(bc), do_calls=len(dos), steps_per_do=statistics.mean(steps) if steps else None,
               forms=sum(bool(FORMS.search(c['cmd'])) for c in dos), stalls=stalls_of(calls))
    return out


SLOW_S = 20


def read_jsonl(f):
    try: return [json.loads(l) for l in open(f) if l.strip()]
    except (OSError, ValueError): return []


def breakdown(c):
    """Where one CLI process's wall time went, in seconds."""
    m, ipc = c.get('marks') or {}, c.get('ipc') or {}
    total = m.get('exit', 0) / 1000
    connect = (m['connect_done'] - m['connect_start']) / 1000 if 'connect_done' in m and 'connect_start' in m else 0
    post = (m['exit'] - m['command_done']) / 1000 if 'command_done' in m and 'exit' in m else 0
    ipc_s, prep = ipc.get('totalMs', 0) / 1000, (ipc.get('prepMs') or 0) / 1000
    start = datetime.fromisoformat(c['at'].replace('Z', '+00:00')).timestamp() if c.get('at') else None
    return {'cmd': c.get('argv', '?'), 'total': total, 'startup': m.get('imports_done', 0) / 1000, 'connect': connect,
            'probes': (c.get('daemon') or {}).get('attempts'), 'spawned': (c.get('daemon') or {}).get('spawned'),
            'ipc': ipc_s, 'prep': prep, 'browser': max(0.0, ipc_s - prep), 'post': post,
            'slowest_ipc': ipc.get('max'), 'slowest_ipc_s': ipc.get('maxMs', 0) / 1000, 'slowest_ipc_prep_s': (ipc.get('maxPrepMs') or 0) / 1000,
            'start': start, 'end': start + total if start is not None else None}


def match_calls(calls, cmds):
    """Pairs each browserctrl call in the rollout with the CLI process it started: the first
    unmatched process of the same subcommand that started after the call."""
    used, out = set(), []
    for c in calls:
        m = re.search(r'browserctrl\s+((?:--\S+\s+)*)([\w-]+)', c['input'])
        if not m: continue
        sub = m.group(2) if not m.group(1) else m.group(1).split()[0]
        hit = next((i for i, x in enumerate(cmds) if i not in used and x['start'] is not None and x['start'] >= c['t_call'] - 1
                    and x['cmd'].split(' ')[0] == sub), None)
        if hit is None: out.append({'call': c, 'cmd': None}); continue
        used.add(hit)
        x = cmds[hit]
        done = 't_out' in c and 'Script running' not in c.get('output', '')
        out.append({'call': c, 'cmd': x, 'launch': x['start'] - c['t_call'], 'ret': (c['t_out'] - x['end']) if done else None, 'yielded': not done})
    return out


def timing(run_dir, rollout=None):
    """Client timing summary for one run, or None when the run has no timing file."""
    if not run_dir: return None
    cmds = [breakdown(c) for c in read_jsonl(os.path.join(run_dir, 'client-timing.jsonl'))]
    if not cmds: return None
    calls = parse_rollout(rollout)[0] if rollout and os.path.exists(rollout) else []
    pairs = match_calls(calls, cmds)
    started = [p for p in pairs if p['cmd']]
    watch = [breakdown(c) for c in read_jsonl(os.path.join(run_dir, 'watcher-timing.jsonl'))]
    def overlaps(c): return any(w['start'] is not None and c['start'] is not None and w['start'] < c['end'] and c['start'] < w['end'] for w in watch)
    over = [c['total'] for c in cmds if overlaps(c)]
    clear = [c['total'] for c in cmds if not overlaps(c)]
    ipc = sum(c['ipc'] for c in cmds)
    slow = max(cmds, key=lambda c: c['total'])
    return {'commands': len(cmds), 'slowest': slow, 'connect_max': max(c['connect'] for c in cmds), 'post_max': max(c['post'] for c in cmds),
            'browser_share': (sum(c['browser'] for c in cmds) / ipc) if ipc else None, 'watcher_reads': len(watch),
            'overlapped': len(over), 'overlapped_median': statistics.median(over) if over else None, 'clear_median': statistics.median(clear) if clear else None,
            'over_20s': [c for c in cmds if c['total'] > SLOW_S],
            'calls': len(pairs), 'never_started': [p['call']['input'][-90:] for p in pairs if not p['cmd']],
            'launch_max': max((p['launch'] for p in started), default=None), 'launch_median': statistics.median([p['launch'] for p in started]) if started else None,
            'return_max': max((p['ret'] for p in started if p['ret'] is not None), default=None),
            'lagged': [p for p in started if p['launch'] > SLOW_S or (p['ret'] or 0) > SLOW_S]}


def describe(c):
    return (f"{c['cmd']} {c['total']:.1f} s = startup {c['startup']:.1f} + connect {c['connect']:.1f} ({c['probes']} probe{'s' if c['probes'] != 1 else ''}"
            f"{', spawned' if c['spawned'] else ''}) + ipc {c['ipc']:.1f} (daemon {c['prep']:.1f}, browser {c['browser']:.1f}; slowest {c['slowest_ipc']} {c['slowest_ipc_s']:.1f} s)"
            f" + post {c['post']:.1f}")


def sign_test(diffs):
    """Two-sided exact binomial p over non-zero differences."""
    pos, neg = sum(d > 0 for d in diffs), sum(d < 0 for d in diffs)
    n = pos + neg
    if n == 0: return 1.0, pos, neg
    k = min(pos, neg)
    p = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * p), pos, neg


def bootstrap_ci(per_task, iters=10000, seed=20261024):
    """per_task: list of (base values, arm values) per task. Resample tasks, then repeats within
    each task; the statistic is the mean over tasks of (arm mean - base mean)."""
    if not per_task: return None
    rnd = random.Random(seed)
    stats = []
    for _ in range(iters):
        s = 0
        for _ in per_task:
            b, a = per_task[rnd.randrange(len(per_task))]
            s += statistics.mean(rnd.choice(a) for _ in a) - statistics.mean(rnd.choice(b) for _ in b)
        stats.append(s / len(per_task))
    stats.sort()
    return stats[int(0.025 * iters)], stats[int(0.975 * iters) - 1]


def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def fmt(x, nd=1):
    return '-' if x is None else (f'{x:.{nd}f}' if isinstance(x, float) and x != int(x) else str(int(x)) if isinstance(x, float) else str(x))


def main():
    ap = argparse.ArgumentParser(prog='compare.py', description=__doc__.split('\n\n', 2)[2], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('group_pos', nargs='?', metavar='group', help='run group id (from ab.mjs) or a path to its .jsonl')
    ap.add_argument('--group', help='the same, as a flag')
    ap.add_argument('--base', help='arm the others are compared against (default: the first arm)')
    ap.add_argument('--gate', type=float, help="flag runs that started at or over this load (default: the group's gate)")
    ap.add_argument('--json', metavar='OUT', help='also write runs and paired results to this file')
    args = ap.parse_args()
    src = args.group or args.group_pos
    if not src: ap.error('give a group: compare.py <group> or --group <group>')
    path = src if os.path.exists(src) else os.path.join(RESULTS, f'{src}.jsonl')
    if not os.path.exists(path): ap.error(f'no results for {src} ({path})')
    group = os.path.basename(path)[:-len('.jsonl')]
    meta_path = os.path.join(os.path.dirname(path), f'{group}.meta.json')
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    gate = args.gate if args.gate is not None else meta.get('gate', 30)
    rows = [json.loads(l) for l in open(path) if l.strip()]
    retried = {(r['arm'], r['task_id'], r['repeat']) for r in rows if r['status'] == 'harness_error'}
    final = {}
    for r in rows:  # the last good row per (arm, task, repeat): a later judge row updates it
        if r['status'] != 'harness_error': final[(r['arm'], r['task_id'], r['repeat'])] = r
    lost = sorted(k for k in retried if k not in final)
    arms = [a['label'] for a in meta.get('arms', [])] or sorted({k[0] for k in final})
    base = args.base or arms[0]
    if base not in arms: ap.error(f'--base {base}: arms are {", ".join(arms)}')
    runs = []
    for k, r in final.items():
        rollout = r.get('rollout') if r.get('rollout') and os.path.exists(r['rollout']) else (find_rollout(r['run_dir']) if r.get('run_dir') else None)
        runs.append({**r, **metrics(r), 'timing': timing(r.get('run_dir'), rollout)})
    runs.sort(key=lambda r: (r['arm'], r['task_id'], r['repeat']))

    arm_list = ', '.join('%s=%s' % (a['label'], a['sha'][:7]) for a in meta.get('arms', []))
    print(f"group {group}: {arm_list}  gate {gate}  model {meta.get('model', '?')}/{meta.get('effort', '?')}")
    print(f"runs {len(runs)} (harness retries {len(retried)}, lost after retry {len(lost)})\n")

    keys = [('turns', 'turns'), ('seconds', 'wall s'), ('tool_calls', 'tools'), ('do_calls', 'do'), ('steps_per_do', 'steps/do'), ('forms', 'forms')]
    print(f"{'arm':14} {'n':>3} " + ' '.join(f'{h:>8}' for _, h in keys) + f" {'success':>8} {'stalls':>6} {'max load':>8}")
    for a in arms:
        rs = [r for r in runs if r['arm'] == a]
        judged = [r['success'] for r in rs if r.get('success') is not None]
        print(f"{a:14} {len(rs):>3} " + ' '.join(f'{fmt(med([r.get(k) for r in rs])):>8}' for k, _ in keys)
              + f" {(f'{sum(judged)}/{len(judged)}' if judged else '-'):>8} {sum(r.get('stalls') or 0 for r in rs):>6} {fmt(max((r.get('start_load') or 0 for r in rs), default=None)):>8}")
    print('(medians over runs; forms = do plans using a plan form, per run)\n')

    tasks = meta.get('tasks') or sorted({r['task_id'] for r in runs})
    out = {'group': group, 'base': base, 'arms': arms, 'runs': runs, 'paired': {}}
    for a in arms:
        if a == base: continue
        print(f"paired: {a} - {base} (per-task means over repeats)")
        print(f"{'task':9} {'n b/a':>6} " + ' '.join(f'{h:>15}' for _, h in keys[:3]))
        per = {k: [] for k, _ in keys[:3]}
        for t in tasks:
            b = [r for r in runs if r['arm'] == base and r['task_id'] == t]
            x = [r for r in runs if r['arm'] == a and r['task_id'] == t]
            cells = []
            for k, _ in keys[:3]:
                bv, xv = [r[k] for r in b if r.get(k) is not None], [r[k] for r in x if r.get(k) is not None]
                if bv and xv:
                    per[k].append((bv, xv))
                    cells.append(f'{statistics.mean(bv):.1f}->{statistics.mean(xv):.1f}')
                else: cells.append('-')
            print(f"{t[:8]:9} {len(b):>2}/{len(x):<3} " + ' '.join(f'{c:>15}' for c in cells))
        out['paired'][a] = {}
        for k, h in keys[:3]:
            diffs = [statistics.mean(xv) - statistics.mean(bv) for bv, xv in per[k]]
            if not diffs: continue
            p, pos, neg = sign_test(diffs)
            ci = bootstrap_ci(per[k])
            print(f"  {h:7} mean diff {statistics.mean(diffs):+.2f}  median diff {statistics.median(diffs):+.2f}  "
                  f"{a} lower in {neg}/{len(diffs)}, higher in {pos}  sign test p={p:.3f}  bootstrap 95% CI [{ci[0]:+.2f}, {ci[1]:+.2f}]")
            out['paired'][a][k] = {'tasks': len(diffs), 'mean_diff': statistics.mean(diffs), 'median_diff': statistics.median(diffs), 'lower': neg, 'higher': pos, 'sign_p': p, 'ci95': ci}
        print()

    timed = [r for r in runs if r.get('timing')]
    if timed:
        print('client timing (per run): commands, slowest, max connect wait, max post-command wait, browser share of IPC, agent commands overlapping a watcher read')
        for r in timed:
            t = r['timing']
            share = '-' if t['browser_share'] is None else f"{100 * t['browser_share']:.0f}%"
            ov = f"{t['overlapped']}/{t['commands']} (median {fmt(t['overlapped_median'], 1)} s vs {fmt(t['clear_median'], 1)} s clear, {t['watcher_reads']} watcher reads)"
            print(f"  {r['arm']:12} {r['task_id'][:8]} r{r['repeat']}: {t['commands']} cmds, slowest {t['slowest']['cmd']} {t['slowest']['total']:.1f} s, "
                  f"connect max {t['connect_max']:.1f} s, post max {t['post_max']:.1f} s, browser {share}, overlapped {ov}")
            if t['calls']:
                print(f"    rollout: {t['calls']} browserctrl calls; launch lag median {fmt(t['launch_median'], 1)} s, max {fmt(t['launch_max'], 1)} s; "
                      f"return lag max {fmt(t['return_max'], 1)} s; never started {len(t['never_started'])}")
            for c in t['over_20s']: print(f"    > {SLOW_S} s: {describe(c)}")
            for p in t['lagged']:
                print(f"    lag: {p['cmd']['cmd']}: launched {p['launch']:.1f} s after Codex's call, ran {p['cmd']['total']:.1f} s, "
                      + (f"returned {p['ret']:.1f} s after exiting" if p['ret'] is not None else "Codex had already yielded the cell as still running"))
            for x in t['never_started']: print(f"    never started a CLI process: {x!r}")
        print()
    else: print('client timing: none recorded (runs before BROWSERCTRL_CLIENT_TIMING)\n')

    flags = []
    for r in runs:
        why = []
        if (r.get('start_load') or 0) >= gate: why.append(f"start load {r['start_load']:.1f} >= gate {gate}")
        if r.get('stalls'): why.append(f"{r['stalls']} stalled command(s)")
        if r.get('timing') and r['timing']['over_20s']: why.append(f"{len(r['timing']['over_20s'])} command(s) over {SLOW_S} s by client timing")
        if r.get('timing') and r['timing']['lagged']: why.append(f"{len(r['timing']['lagged'])} command(s) waited over {SLOW_S} s outside browserctrl (launch or return lag)")
        if r.get('timed_out'): why.append('agent timed out')
        if (r['arm'], r['task_id'], r['repeat']) in retried: why.append('retried after a harness error')
        if r.get('turns') is None: why.append('no Codex rollout found (turns unknown)')
        if why: flags.append(f"  {r['arm']} {r['task_id'][:8]} r{r['repeat']}: {'; '.join(why)}")
    for k in lost: flags.append(f"  {k[0]} {k[1][:8]} r{k[2]}: no result (harness error twice)")
    print('flags:' if flags else 'flags: none')
    if flags: print('\n'.join(flags))
    if args.json: json.dump(out, open(args.json, 'w'), indent=1, default=str)


if __name__ == '__main__':
    main()
