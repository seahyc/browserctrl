"""Build picker.html: a page for choosing Online-Mind2Web tasks.

Inputs (public, from OSU-NLP-Group/Online-Mind2Web on GitHub):
  human_label.json  all 300 tasks with per-agent human pass/fail labels
  hosts.json        task_id -> website, inferred from URLs in published agent runs
The official site and level fields live in the gated Hugging Face dataset.

usage: python3 make_picker.py <dir with human_label.json, hosts.json> [preselect ids file]
"""
import html, json, re, sys
from pathlib import Path

src = Path(sys.argv[1])
pre = set(Path(sys.argv[2]).read_text().split()) if len(sys.argv) > 2 else set()
tasks = json.loads((src / "human_label.json").read_text())
hosts = json.loads((src / "hosts.json").read_text()) if (src / "hosts.json").exists() else {}
# Official task file (gated dataset): current wording, start site, level, human step count.
official = {t["task_id"].split("_")[0]: t for t in json.loads((src / "tasks.json").read_text())} if (src / "tasks.json").exists() else {}

WRITE = re.compile(r"\b(add|cart|book|reserve|subscribe|sign|log ?in|register|set|save|follow|apply|order|buy|purchase|checkout|rent|schedule|join|create|post|submit|donate)\b", re.I)

rows = []
for i, t in enumerate(tasks, 1):
    labels = [int(v) for k, v in t.items() if k.endswith("human_label") and v in ("0", "1")]
    rate = sum(labels) / len(labels) if labels else 0
    o = official.get(t["task_id"])
    band = o["level"] if o else "easy" if rate >= 0.8 else "medium" if rate >= 0.34 else "hard"
    task = o["confirmed_task"] if o else t["confirmed_task"]
    site = re.sub(r"^https?://(www\.)?|/$", "", o["website"]) if o else hosts.get(t["task_id"], "")
    rows.append({
        "n": i, "id": o["task_id"] if o else t["task_id"], "task": task, "site": site,
        "rate": round(rate, 2), "agents": len(labels), "band": band, "steps": o["reference_length"] if o else 0,
        # Labels were collected on the old wording of updated tasks.
        "reworded": bool(o and o["task_id"] != t["task_id"]),
        "writes": bool(WRITE.search(task)), "pick": t["task_id"] in pre or (o and o["task_id"] in pre),
    })

page = """<!doctype html><meta charset=utf-8><title>Online-Mind2Web task picker</title>
<style>
body{font:14px/1.45 -apple-system,system-ui,sans-serif;margin:0;color:#222;background:#faf9f6}
header{position:sticky;top:0;background:#faf9f6;border-bottom:1px solid #ddd;padding:12px 20px;z-index:1}
h1{font-size:17px;margin:0 0 8px}
.bar{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
input[type=search]{padding:5px 8px;width:260px}
table{border-collapse:collapse;width:100%}
td,th{padding:6px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
th{font-weight:600;color:#666;font-size:12px;cursor:pointer;user-select:none}
tr.on{background:#eef6ea}
.b{font-size:11px;padding:1px 6px;border-radius:8px;white-space:nowrap}
.easy{background:#dff0d8}.medium{background:#fcf2d6}.hard{background:#f6dcdc}
.w{color:#a33;font-size:11px}.site{color:#555;white-space:nowrap}
#count{font-weight:600}
button{padding:5px 10px;cursor:pointer}
.note{color:#777;font-size:12px;margin-top:6px}
</style>
<header><h1>Online-Mind2Web: pick our tasks</h1>
<div class=bar>
<span><span id=count></span> picked (<span id=bands></span>)</span>
<input type=search id=q placeholder="Filter by task or site">
<label><input type=checkbox id=ro checked> read-only only</label>
<label><input type=checkbox id=mine> picked only</label>
<select id=band><option value="">all difficulties</option><option>easy</option><option>medium</option><option>hard</option></select>
<button id=copy>Copy picked IDs</button><button id=reset>Reset to suggested</button>
</div>
<div class=note>Level and human steps are the dataset's own (reference_length = steps a human needed). Agents passed = human-labelled passes among 6 published agents (Operator, Browser Use, Agent-E, Claude CU 3.5/3.7, SeeAct); "reworded" tasks changed after those runs, so their labels don't apply.
"May write" flags tasks whose wording suggests a login, cart, booking or post. Picks are saved in this browser.</div>
</header>
<table><thead><tr><th></th><th data-k=n>#</th><th data-k=task>Task</th><th data-k=site>Site</th><th data-k=steps>Human steps</th><th data-k=rate>Agents passed</th></tr></thead><tbody id=tb></tbody></table>
<script>
const ROWS = __ROWS__;
const KEY = "om2w-picks";
const suggested = ROWS.filter(r => r.pick).map(r => r.id);
let picks = new Set(JSON.parse(localStorage.getItem(KEY) || "null") || suggested);
let sortK = "n", sortDir = 1;
const $ = id => document.getElementById(id);
const esc = s => s.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function save(){ localStorage.setItem(KEY, JSON.stringify([...picks])); }
function render(){
  const q = $("q").value.toLowerCase(), band = $("band").value;
  const rows = ROWS.filter(r => (!$("ro").checked || !r.writes || picks.has(r.id)) && (!$("mine").checked || picks.has(r.id))
    && (!band || r.band === band) && (!q || (r.task + " " + r.site).toLowerCase().includes(q)))
    .sort((a, b) => (a[sortK] > b[sortK] ? 1 : a[sortK] < b[sortK] ? -1 : 0) * sortDir);
  $("tb").innerHTML = rows.map(r => `<tr class="${picks.has(r.id) ? "on" : ""}"><td><input type=checkbox data-id="${r.id}" ${picks.has(r.id) ? "checked" : ""}></td>
    <td>${r.n}</td><td>${esc(r.task)} ${r.writes ? "<span class=w>may write</span>" : ""}</td><td class=site>${esc(r.site)}</td>
    <td><span class="b ${r.band}">${r.band}</span> ${r.steps}</td><td>${r.reworded ? "<span class=w title='labels predate the current wording'>reworded</span>" : Math.round(r.rate * r.agents) + "/" + r.agents}</td></tr>`).join("");
  const p = ROWS.filter(r => picks.has(r.id));
  $("count").textContent = p.length;
  $("bands").textContent = ["easy", "medium", "hard"].map(b => `${p.filter(r => r.band === b).length} ${b}`).join(", ");
}
$("tb").addEventListener("change", e => { const id = e.target.dataset.id; e.target.checked ? picks.add(id) : picks.delete(id); save(); render(); });
["q", "ro", "mine", "band"].forEach(id => $(id).addEventListener("input", render));
document.querySelectorAll("th[data-k]").forEach(th => th.onclick = () => { sortDir = sortK === th.dataset.k ? -sortDir : 1; sortK = th.dataset.k; render(); });
$("copy").onclick = () => { navigator.clipboard.writeText([...picks].join("\\n")); $("copy").textContent = "Copied " + picks.size; setTimeout(() => $("copy").textContent = "Copy picked IDs", 1500); };
$("reset").onclick = () => { picks = new Set(suggested); save(); render(); };
render();
</script>
"""
out = Path(__file__).with_name("picker.html")
out.write_text(page.replace("__ROWS__", json.dumps(rows)))
print(f"{out}: {len(rows)} tasks, {sum(r['pick'] for r in rows)} preselected, {sum(1 for r in rows if r['site'])} with a site")
