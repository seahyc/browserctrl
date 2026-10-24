"""Compare the arms of an ab.mjs run group. Stdlib only.

  python3 -I bench/om2w/compare.py <group> [--base <arm>] [--gate N] [--json out.json]
  python3 -I bench/om2w/compare.py --group <group> ...      (same; <group> may also be a .jsonl path)

Per run, from Codex's rollout: turns (model responses, a burst of parallel tool calls counted
once, +1 for the final answer), browserctrl and do calls, steps per do plan, plan forms
(if/for top/each/try/pick/extract as/answer), stalls (a browserctrl command whose wall time
exceeded its own reported work by more than 60 s, or that never returned). Per arm: medians
over runs. Paired: each task's mean over its repeats, arm minus base, with a two-sided sign
test over tasks and a bootstrap 95% CI (tasks resampled, then repeats within each task).
Flags runs that started at load >= the gate, stalled, timed out, or needed a retry."""
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
        runs.append({**r, **metrics(r)})
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

    flags = []
    for r in runs:
        why = []
        if (r.get('start_load') or 0) >= gate: why.append(f"start load {r['start_load']:.1f} >= gate {gate}")
        if r.get('stalls'): why.append(f"{r['stalls']} stalled command(s)")
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
