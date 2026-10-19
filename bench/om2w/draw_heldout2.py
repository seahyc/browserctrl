"""Draw held-out-2: medium tasks on sites never run, for measuring the 2026-10-19 speed work.

The hard tasks on sites reachable from here are all used (dev, rotations 1-3, final). The
medium tasks on reachable sites that no run has touched are still unseen: nothing in
browserctrl was studied or fixed on them. One task per site, drawn with a fixed seed before
any run, written to splits.json as "heldout-2". Run each task once per arm; fixes made after
the run are not counted against these sites.

usage: python3 -I draw_heldout2.py <tasks.json> <results.jsonl> [n=20]   (reads access.json and
       splits.json beside this file; writes splits.json). Both inputs are gitignored, so they are
       named explicitly: a missing results file would let used sites back in.
"""
import json, random, sys
from pathlib import Path

HERE = Path(__file__).parent
SEED = 20261019
host = lambda url: url.split("//")[1].split("/")[0].removeprefix("www.")

tasks = json.loads(Path(sys.argv[1]).read_text())
n = int(sys.argv[3]) if len(sys.argv) > 3 else 20
splits = json.loads((HERE / "splits.json").read_text())
if "heldout-2" in splits:
    sys.exit("heldout-2 is already drawn; it is fixed once drawn")
reachable = set(json.loads((HERE / "access.json").read_text())["reachable"])

used = set()
for line in Path(sys.argv[2]).read_text().splitlines():
    if line.strip() and (w := json.loads(line).get("website")):
        used.add(host(w))
for k, v in splits.items():
    if isinstance(v, dict) and k != "dev":
        used |= set(v.get("sites", []))

by_site = {}
for t in sorted(tasks, key=lambda t: t["task_id"]):
    s = host(t["website"])
    if t["level"] == "medium" and s in reachable and s not in used:
        by_site.setdefault(s, []).append(t["task_id"])

sites = sorted(by_site)
rng = random.Random(SEED)
rng.shuffle(sites)
picked = sites[:n]
splits["heldout-2"] = {
    "drawn": "2026-10-19, before any run",
    "level": "medium",
    "seed": SEED,
    "sites": sorted(picked),
    "tasks": sorted(rng.choice(by_site[s]) for s in picked),
}
(HERE / "splits.json").write_text(json.dumps(splits, indent=1) + "\n")
print(f"heldout-2: {len(picked)} tasks on {len(picked)} sites")
