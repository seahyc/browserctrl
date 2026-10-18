"""Regenerate docs/results/om2w-2026-10.runs.md from results.jsonl.

Phases come from the table already published (runs before the final set) and from the job
files of later batches; the final set's hand-checked verdicts come from handcheck.json.

usage: python3 bench/om2w/make_runs_md.py
"""
import json, re
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE.parent.parent / "docs/results/om2w-2026-10.runs.md"
rows = [json.loads(l) for l in (HERE / "results.jsonl").read_text().splitlines() if l.strip()]
old = OUT.read_text()
phase = {m.group(1): m.group(2) for m in re.finditer(r"^\| `([^`]+)` \| ([^|]+?) \|", old, re.M)}
final = set(json.loads((HERE / "splits.json").read_text())["final"]["tasks"])
hand = json.loads((HERE / "handcheck.json").read_text())["runs"]
texts = {t["task_id"]: t["confirmed_task"] for t in json.loads((HERE / "tasks.json").read_text())}
for r in rows:
    if r["run"] in phase:
        continue
    if r["task_id"] in final and r["at"] > "2026-10-17T00:50":
        phase[r["run"]] = "final"
    elif r["at"] > "2026-10-17T00:00":
        phase[r["run"]] = "dev check"
# A final run redone after an outage outside the method: the earlier one is kept but marked.
last = {}
for r in rows:
    if phase.get(r["run"]) == "final":
        last[(r["task_id"], r["arm"])] = r["run"]

head, _, _ = old.partition("| run | phase |")
head = re.sub(r"\n- \*\*final:\*\*.*?(?=\n\n)", "", head, flags=re.S)
head = head.rstrip() + "\n\n"
head = head.replace("\n\nRescored verdicts:", """\n- **final:** 21 hard tasks on 17 sites never used while fixing, chosen before any of them was run, one run per method (2026-10-17). Three native runs and one browserctrl run were redone: the native browser tool stopped answering for about 20 minutes, and a test on the same machine restarted browserctrl's background process during one run. The redone runs are marked *superseded*. **hand check** is the verdict from each run's own log, answer and stills (`bench/om2w/handcheck.json`); the automatic judge grades stills only and failed 14 runs whose logs show the task done.

Rescored verdicts:""", 1)
lines = [head.rstrip() + "\n", "| run | phase | task | site | method | notes | judge | hand check | seconds | tool calls | tokens |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
for r in rows:
    p = phase.get(r["run"], "")
    site = r["website"].split("//")[1].split("/")[0].removeprefix("www.")
    method = {"D": "browserctrl", "native": "Codex's own browser", "A": "plain browserctrl", "N": "browserctrl"}.get(r["arm"], r["arm"])
    hc = ""
    if p == "final":
        if last.get((r["task_id"], r["arm"])) != r["run"]:
            hc = "superseded"
        else:
            v = hand.get(f'{r["task_id"][:8]} {r["arm"]}')
            hc = ("yes" if v[0] else "no" + (" (outside the method)" if len(v) > 2 else "")) if v else ""
    task = texts.get(r["task_id"], "").replace("|", "/")
    lines.append(f'| `{r["run"]}` | {p} | {task[:80]} | {site} | {method} | {r.get("notes_arm") or ""} | {"yes" if r.get("success") else "no"} | {hc} | {r["seconds"]} | {r["tool_calls"]} | {r["tokens"]} |')
OUT.write_text(re.sub(r"\n\n+(- \*\*final:\*\*)", r"\n\1", "\n".join(lines)) + "\n")
print(f"{len(rows)} runs -> {OUT}")
