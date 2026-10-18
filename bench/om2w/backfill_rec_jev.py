"""Add Jev picks to recordings made before steps carried them (2026-10-19).

Each browserctrl run's own `do` output says how every step was resolved ("(jev p=0.94)");
this writes that onto the matching `do:` rows of the run's rec/steps.jsonl, in order, so its
video captions say when Jev chose. Idempotent.

usage: python3 bench/om2w/backfill_rec_jev.py [run-dir ...]   (default: every -D- run)
"""
import json, re, sys
from pathlib import Path

HERE = Path(__file__).parent
STEP = re.compile(r'^[✓⚠] \d+\. (.*?)  → (.*?) \(jev p=([\d.]+)', re.M)
for d in [Path(a) for a in sys.argv[1:]] or sorted((HERE / "runs").glob("*-D-*")):
    ev, steps = d / "agent-events.jsonl", d / "rec" / "steps.jsonl"
    if not ev.exists() or not steps.exists():
        continue
    picks = []  # (step text, target, p) in the order the agent's do calls ran them
    for line in ev.read_text().splitlines():
        e = json.loads(line); it = e.get("item") or {}
        if e.get("type") == "item.completed" and it.get("type") == "command_execution" and " do " in it.get("command", ""):
            out = it.get("aggregated_output") or ""
            for m in re.finditer(r'^[✓⚠✗–] \d+\. (.*?)(?:  → (.*?) \(([^)]*)\))?  ', out, re.M):
                p = re.search(r"jev p=([\d.]+)", m.group(3) or "")
                picks.append((m.group(1).strip(), m.group(2), float(p.group(1)) if p else None))
    rows = [json.loads(l) for l in steps.read_text().splitlines() if l.strip()]
    i = n = 0
    for r in rows:
        a = str(r.get("action", ""))
        if not a.startswith("do: "):
            continue
        want = a[4:].strip()
        while i < len(picks) and picks[i][0] != want:
            i += 1
        if i == len(picks):
            break
        _, target, p = picks[i]; i += 1
        if p is not None and target:
            r["jev"] = {"target": target, "p": p}; n += 1
    steps.write_text("".join(json.dumps(r) + "\n" for r in rows))
    if n:
        print(f"{d.name}: {n} Jev picks")
