"""Split Online-Mind2Web into site-disjoint sets for developing browserctrl honestly.

A fix studied on one site can tune browserctrl to that site, so sets are split by site, not
by task: no site appears in two sets.

- dev: sites already used (the 13 hard tasks, the notes test, demos) plus leftover sites.
  Study and fix against these freely.
- rotation-1: the held-out set chosen on 2026-10-16 (heldout.txt). Once its results have
  been studied, it is retired into dev.
- rotation-2, rotation-3: ~10 hard tasks each, for later rounds; each is retired into dev
  after use.
- final: ~20 hard tasks, run once at the end. The only numbers reported as "unseen sites".

usage: python3 split.py   (reads tasks.json, results.jsonl, heldout.txt; writes splits.json)
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

used = set()
for line in (HERE / "results.jsonl").read_text().splitlines():
    if line.strip() and (w := json.loads(line).get("website")):
        used.add(host(w))
rotation1 = [l.strip() for l in (HERE / "heldout.txt").read_text().splitlines() if l.strip() and not l.startswith("#")]
r1_sites = {host(t["website"]) for t in tasks if t["task_id"] in rotation1}

free = sorted(s for s in by_site if s not in used and s not in r1_sites and hard_by_site[s])
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
r2_sites, r3_sites = take(ROTATION), take(ROTATION)
dev_sites = sorted(s for s in by_site if s not in set(final_sites) | set(r2_sites) | set(r3_sites) | r1_sites)

def hard(sites):
    return [t for s in sites for t in hard_by_site[s]]

splits = {
    "seed": SEED,
    "rule": "site-disjoint; hard tasks only in rotations and final; dev holds every task on its sites",
    "final": {"sites": sorted(final_sites), "tasks": hard(final_sites)},
    "rotation-1": {"sites": sorted(r1_sites), "tasks": rotation1, "status": "running 2026-10-16"},
    "rotation-2": {"sites": sorted(r2_sites), "tasks": hard(r2_sites)},
    "rotation-3": {"sites": sorted(r3_sites), "tasks": hard(r3_sites)},
    "dev": {"sites": dev_sites, "tasks": [t for s in dev_sites for t in by_site[s]]},
}
(HERE / "splits.json").write_text(json.dumps(splits, indent=1) + "\n")
for k, v in splits.items():
    if isinstance(v, dict):
        print(f"{k:11} {len(v['sites']):3} sites  {len(v['tasks']):3} tasks")
