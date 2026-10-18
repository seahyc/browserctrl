// One Jev call, drawn as a card: what Jev was given (text only: the page's address, title,
// visible text and the controls a step could act on, as role and name) and what it answered.
// Input is a line of a BROWSERCTRL_JEV_LOG file.
//
// usage: node docs/media/make_jev_card.mjs <call.json> <out.png> [--line N] [--question target]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [src, out] = process.argv.slice(2);
const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const lines = fs.readFileSync(src, 'utf8').trim().split('\n');
const call = JSON.parse(lines[Number(opt('line', 1)) - 1]);
const qid = opt('question', 'target');
const q = call.questions[qid], a = call.answers[qid];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const intent = (q.instructions.match(/intent: "([^"]+)"/) || [])[1] || '';
const cands = Object.entries(q.criteria).filter(([k]) => k !== 'none');
const ranked = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]).slice(0, 4);
const name = (k) => (k === 'none' ? 'none of these' : `${q.criteria[k].role} “${q.criteria[k].name.trim()}”`);
const page = call.state.page;
const text = page.visible_text.replace(/\s+/g, ' ').trim();

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0f1115;color:#e8e8ea;font:15px/1.45 -apple-system,system-ui,sans-serif}
.wrap{display:grid;grid-template-columns:1.55fr 1fr;gap:22px;padding:26px}
h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8b93a7;margin:0 0 10px}
.box{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:16px 18px}
.mono{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9d1e0}
.dim{color:#7d8597}.k{color:#8fb4ff}.ask{font-size:20px;margin:4px 0 14px}
.c{display:flex;gap:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar{height:26px;border-radius:6px;background:#232835;margin:8px 0;position:relative;overflow:hidden}
.bar i{position:absolute;inset:0 auto 0 0;background:#2f8f5b}.bar.pick i{background:#ff2d55}
.bar span{position:relative;padding:0 10px;line-height:26px;font-size:13px;white-space:nowrap}
.big{font-size:44px;font-weight:700;margin:6px 0 0}.note{color:#8b93a7;font-size:13px;margin-top:12px}
</style><div class="wrap">
<div><h2>What Jev was given: text only, no screenshot</h2><div class="box mono">
<div><span class="k">url</span> ${esc(page.url.slice(0, 90))}${page.url.length > 90 ? '…' : ''}</div>
<div><span class="k">title</span> ${esc(page.title)}</div>
<div><span class="k">visible text</span> <span class="dim">${esc(text.slice(0, 330))}… (${text.length} chars)</span></div>
<div style="margin-top:10px"><span class="k">controls a click could use</span> <span class="dim">(${cands.length})</span></div>
${cands.slice(0, 13).map(([k, c]) => `<div class="c"><span class="dim">${k.replace('ref_', '')}</span> ${esc(c.role)} “${esc(c.name.trim().slice(0, 60))}”${c.value ? ` <span class="dim">= ${esc(String(c.value).slice(0, 30))}</span>` : ''}</div>`).join('')}
<div class="dim">… ${cands.length - 13} more</div></div></div>
<div><h2>The question</h2><div class="box"><div class="ask">Which control should a click on <b>“${esc(intent)}”</b> use?</div>
<div class="dim" style="font-size:13px">One of the ${cands.length} controls, or none.</div></div>
<h2 style="margin-top:20px">Jev's answer</h2><div class="box">
${ranked.map(([k, p]) => `<div class="bar ${k === a.choice ? 'pick' : ''}"><i style="width:${Math.max(1, p * 100)}%"></i><span>${Math.round(p * 100)}% · ${esc(name(k).slice(0, 48))}</span></div>`).join('')}
<div class="big">${call.ms} ms</div><div class="note">The agent's model never had to read this list: it wrote <b>click "${esc(intent)}"</b> in a plan, and browserctrl asked Jev only because no control is named exactly that.</div>
</div></div></div>`;

const tmp = path.join(os.tmpdir(), `jev-card-${process.pid}.html`);
fs.writeFileSync(tmp, html);
const cft = path.join(os.homedir(), '.cache/chrome-for-testing/chrome/mac_arm-155.0.8059.84/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const chrome = process.env.CHROME_BIN || (fs.existsSync(cft) ? cft : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
try { fs.rmSync(path.resolve(out), { force: true }); execFileSync(chrome, ['--headless=new', '--hide-scrollbars', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'jev-card-profile-'))}`, `--screenshot=${path.resolve(out)}`, '--window-size=1400,560', '--force-device-scale-factor=2', `file://${tmp}`], { stdio: 'ignore' }); } catch (e) { if (!fs.existsSync(path.resolve(out))) throw e; } // headless Chrome can exit non-zero after writing it
console.log(out);
