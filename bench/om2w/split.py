"""Split Online-Mind2Web into site-disjoint sets for developing browserctrl honestly.

A fix studied on one site can tune browserctrl to that site, so sets are split by site, not
by task: no site appears in two sets.

- dev: every site already run (the 13 hard tasks, notes test, demos, retired rotations) plus
  leftovers. Study and fix against these freely.
- rotation-1, rotation-2: held-out rounds already run and studied; retired into dev.
- rotation-3 (and rotation-4 if enough reachable sites remain; none did): ~10 hard tasks for the next held-out round, retired into
  dev after it has been run and studied.
- final: ~20 hard tasks, run once at the end. The only numbers reported as "unseen sites".

Since 2026-10-16 runs use a direct connection from Singapore (no VPN), so the unused sets are
drawn only from sites access.json lists as reachable that way (no block, no redirect to
another country's site).

usage: python3 split.py   (reads tasks.json, results.jsonl, heldout.txt, access.json and the
       retired rotations in splits.json; writes splits.json)
"""
import json, random
from pathlib import Path

HERE = Path(__file__).parent
SEED = 20261016
FINAL, ROTATION = 20, 10

host = lambda url: url.split("//")[1].split("/")[0].removeprefix("www.")
tasks = json.loads((HERE / "tasks.json").read_text())
by_site = {}
for t in tasks:
    by_site.setdefault(host(t["website"]), []).append(t["task_id"])
hard_by_site = {s: [t["task_id"] for t in tasks if host(t["website"]) == s and t["level"] == "hard"] for s in by_site}

old = json.loads((HERE / "splits.json").read_text()) if (HERE / "splits.json").exists() else {}
retired = {k: v for k, v in old.items() if k in ("rotation-1", "rotation-2")}
reachable = set(json.loads((HERE / "access.json").read_text())["reachable"])

used = set()
for line in (HERE / "results.jsonl").read_text().splitlines():
    if line.strip() and (w := json.loads(line).get("website")):
        used.add(host(w))
for v in retired.values():
    used |= set(v["sites"])

free = sorted(s for s in by_site if s not in used and s in reachable and hard_by_site[s])
random.Random(SEED).shuffle(free)

def take(n):
    """Sites from the shuffled list until the set holds n hard tasks."""
    sites, count = [], 0
    while free and count < n:
        s = free.pop(0)
        sites.append(s)
        count += len(hard_by_site[s])
    return sites

final_sites = take(FINAL)
r3_sites, r4_sites = take(ROTATION), take(ROTATION)
held = set(final_sites) | set(r3_sites) | set(r4_sites)
dev_sites = sorted(s for s in by_site if s not in held)

def hard(sites):
    return [t for s in sites for t in hard_by_site[s]]

splits = {
    "seed": SEED,
    "rule": "site-disjoint; hard tasks only in rotations and final; dev holds every task on its sites; unused sets drawn from sites reachable directly (access.json)",
    "final": {"sites": sorted(final_sites), "tasks": hard(final_sites)},
    **retired,
    "rotation-3": {"sites": sorted(r3_sites), "tasks": hard(r3_sites), "status": "next held-out test"},
    **({"rotation-4": {"sites": sorted(r4_sites), "tasks": hard(r4_sites)}} if r4_sites else {}),
    "dev": {"sites": dev_sites, "tasks": [t for s in dev_sites for t in by_site[s]]},
}
(HERE / "splits.json").write_text(json.dumps(splits, indent=1) + "\n")
for k, v in splits.items():
    if isinstance(v, dict):
        print(f"{k:11} {len(v['sites']):3} sites  {len(v['tasks']):3} tasks")
