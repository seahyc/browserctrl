// The feature bench's local "sites": an admin console (audit log, instances, billing,
// reports, settings), a stays search and a job board. All data comes from a seeded
// generator, so every task has one exact answer; answers() computes them from the same data
// and server.mjs --selftest checks them against tasks.json.
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pickOf = (r) => (xs) => xs[Math.floor(r() * xs.length)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pad = (n, w = 2) => String(n).padStart(w, '0');

// ------------------------------------------------------------------ data ---
export const AUDIT_PAGE = 20;
export function auditRows() {
  const r = rng(20261024), p = pickOf(r);
  const users = ['alice', 'bob', 'carol', 'ops-bot', 'ci-runner', 'dmitri'];
  const actions = ['GetObject', 'PutObject', 'DeleteObject', 'ListBucket', 'CreateAccessKey', 'UpdatePolicy'];
  const buckets = ['atlas-logs', 'atlas-media', 'borealis-backups', 'cygnus-data', 'shared-artifacts'];
  const rows = [];
  let t = Date.UTC(2026, 9, 23, 23, 50);
  for (let i = 0; i < 600; i++) {
    t -= Math.floor(20 + r() * 100) * 60_000;
    const d = new Date(t);
    const status = r() < 0.78 ? 'Success' : r() < 0.6 ? 'Denied' : 'Failed';
    rows.push({
      time: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
      user: p(users), action: p(actions), resource: `${p(buckets)}/${Math.floor(r() * 9000 + 1000)}`, status,
      ip: `10.${Math.floor(r() * 50)}.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}`,
    });
  }
  return rows;
}

export function instances() {
  const r = rng(77), p = pickOf(r);
  const names = [];
  for (const role of ['web', 'api', 'worker', 'db']) for (const env of ['prod', 'staging']) for (let i = 1; i <= 5; i++) names.push(`${role}-${env}-${pad(i)}`);
  names.splice(14, 0, 'web-prod-07', 'web-prod-07-canary');
  const ip = (a) => `${a}.${Math.floor(r() * 250 + 2)}.${Math.floor(r() * 250 + 2)}`;
  return names.map((name, i) => ({
    name, id: `i-0${(0x3a1f00 + i * 7919).toString(16)}${Math.floor(r() * 4096).toString(16).padStart(3, '0')}`,
    zone: p(['ap-southeast-1a', 'ap-southeast-1b', 'ap-southeast-1c']), type: p(['ecs.g7.large', 'ecs.g7.xlarge', 'ecs.c7.2xlarge', 'ecs.r7.large']),
    status: r() < 0.85 ? 'Running' : 'Stopped', created: `2026-${pad(1 + Math.floor(r() * 9))}-${pad(1 + Math.floor(r() * 28))}`,
    publicIp: `47.${ip(Math.floor(r() * 200 + 20))}`, primaryIp: `10.${ip(Math.floor(r() * 60))}`, secondaryIp: `10.${ip(Math.floor(r() * 60 + 60))}`,
    eni1: `eni-${Math.floor(r() * 0xffffff).toString(16).padStart(6, '0')}`, eni2: `eni-${Math.floor(r() * 0xffffff).toString(16).padStart(6, '0')}`,
    sg: `sg-${Math.floor(r() * 0xfffff).toString(16)}`, vpc: p(['vpc-main', 'vpc-data', 'vpc-edge']),
  }));
}

export const RATES = { USD: 1, EUR: 1.08, GBP: 1.27, SGD: 0.74 };
export const NIGHTS = 3;
// price: what the card shows; total: the stay's cost in USD (ranges count their upper end).
export const STAYS = [
  { name: 'Casa Alfama', show: '$139 / night', cur: 'USD', per: 'night', amount: 139, rating: 4.6 },
  { name: 'Lapa Flat', show: '$79 / night', cur: 'USD', per: 'night', amount: 79, rating: 4.2, soldOut: true },
  { name: 'Hotel Tejo', show: '€360 total for 3 nights', cur: 'EUR', per: 'stay', amount: 360, rating: 4.4 },
  { name: 'Estrela House', show: '$89 / night + $70 cleaning fee', cur: 'USD', per: 'night', amount: 89, fee: 70, rating: 4.1 },
  { name: 'Rio View Suites', show: '£95 per night', cur: 'GBP', per: 'night', amount: 95, rating: 4.7 },
  { name: 'Baixa Hostel Private Room', show: 'S$480 for your stay', cur: 'SGD', per: 'stay', amount: 480, rating: 3.9 },
  { name: 'Belém Garden', show: '$105–$125 / night', cur: 'USD', per: 'night', amount: 125, low: 105, rating: 4.5 },
  { name: 'Alfama Nest', show: '€99 / night', cur: 'EUR', per: 'night', amount: 99, rating: 4.3 },
  { name: 'Graça Terrace', show: '$329 total', cur: 'USD', per: 'stay', amount: 329, rating: 4.8 },
  { name: 'Chiado Rooms', show: 'USD 112 per night', cur: 'USD', per: 'night', amount: 112, rating: 4.0 },
  { name: 'Sunset Bairro', show: '€305 for 3 nights', cur: 'EUR', per: 'stay', amount: 305, rating: 4.4 },
  { name: 'Mouraria Studio', show: '£250–£280 total', cur: 'GBP', per: 'stay', amount: 280, low: 250, rating: 4.2 },
];
export const stayTotal = (s) => (s.per === 'night' ? s.amount * NIGHTS : s.amount) * RATES[s.cur] + (s.fee || 0) * RATES[s.cur];

export function jobs() {
  const r = rng(4471), p = pickOf(r);
  const titles = ['Backend Engineer', 'Data Engineer', 'Product Designer', 'Site Reliability Engineer', 'Frontend Engineer', 'ML Engineer', 'Engineering Manager', 'QA Engineer', 'Security Engineer', 'Mobile Engineer'];
  const companies = ['Northwind', 'Globex', 'Initech', 'Umbrella Labs', 'Hooli', 'Stark Data', 'Wayne Systems', 'Acme Cloud', 'Vandelay', 'Soylent AI'];
  // [list label, arrangement on the detail page, visa]: the list says "Remote" for both
  // fully remote and remote-within-a-country posts; only the detail page tells them apart.
  const plan = [
    ['Hybrid · Singapore', 'Hybrid: 3 days a week in the Singapore office', true],
    ['Remote', 'Fully remote, work from anywhere', false],
    ['On-site · Berlin', 'On-site in Berlin', true],
    ['Remote', 'Remote within the United States only', true],
    ['Remote', 'Fully remote, work from anywhere', false],
    ['Hybrid · London', 'Hybrid: 2 days a week in London', true],
    ['Remote', 'Remote within the EU only', true],
    ['On-site · Austin', 'On-site in Austin', false],
    ['Remote', 'Fully remote, work from anywhere', false],
    ['Remote', 'Remote within the United States only', true],
    ['Hybrid · Toronto', 'Hybrid: 3 days a week in Toronto', true],
    ['Remote', 'Fully remote, work from anywhere', false],
    ['Remote', 'Remote within Canada only', true],
    ['On-site · Singapore', 'On-site in Singapore', true],
    ['Remote', 'Fully remote, work from anywhere', true], // the answer: 15th in the list
    ['Remote', 'Fully remote, work from anywhere', true],
    ['Hybrid · Sydney', 'Hybrid: 2 days a week in Sydney', true],
    ['Remote', 'Fully remote, work from anywhere', false],
    ['On-site · Paris', 'On-site in Paris', false],
    ['Remote', 'Remote within the United States only', false],
    ['Remote', 'Fully remote, work from anywhere', true],
    ['Hybrid · Berlin', 'Hybrid: 3 days a week in Berlin', false],
    ['Remote', 'Remote within the EU only', true],
    ['On-site · Tokyo', 'On-site in Tokyo', true],
    ['Remote', 'Fully remote, work from anywhere', false],
  ];
  return plan.map(([label, arrangement, visa], i) => ({
    id: `JOB-${4100 + Math.floor(r() * 800) * 1 + i * 13}`, title: p(titles), company: p(companies), label, arrangement, visa,
    posted: `${i < 3 ? 'today' : `${Math.floor(i / 3)} day${Math.floor(i / 3) === 1 ? '' : 's'} ago`}`, salary: `$${110 + Math.floor(r() * 90)}k–$${200 + Math.floor(r() * 80)}k`,
  }));
}

export const PROJECTS = ['atlas', 'borealis', 'cygnus'];
export const MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10'];
export function billing(project, month) {
  const r = rng(PROJECTS.indexOf(project) * 100 + MONTHS.indexOf(month) + 9);
  const items = ['Compute', 'Block storage', 'Object storage', 'Data transfer', 'Load balancing', 'Managed database', 'Support plan']
    .map((name) => ({ name, cost: Math.round((80 + r() * 2400) * 100) / 100 }));
  const total = Math.round(items.reduce((s, i) => s + i.cost, 0) * 100) / 100;
  return { items, total };
}

export function usageCsvRows(month = '2026-10') {
  const r = rng(month.split('-').reduce((a, b) => a * 13 + Number(b), 0)), p = pickOf(r);
  const services = { compute: ['vcpu-hours', 'gpu-hours'], storage: ['standard-gb-month', 'archive-gb-month', 'requests-1k'], network: ['egress-gb', 'nat-hours'], database: ['instance-hours', 'storage-gb-month'] };
  const rows = [];
  const days = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate();
  for (let d = 1; d <= days; d++) for (const project of PROJECTS) for (let k = 0; k < 3; k++) {
    const service = p(Object.keys(services));
    rows.push({ date: `${month}-${pad(d)}`, project, service, sku: p(services[service]), quantity: Math.round(r() * 5000) / 10, cost: Math.round(r() * 9000) / 100 });
  }
  return rows;
}

export const RETENTION = [['Access logs', '400 days'], ['Audit logs', '1095 days (3 years)'], ['VPC flow logs', '90 days'], ['Application logs', '30 days'], ['Billing records', '2555 days (7 years)']];

export function answers() {
  const audit = auditRows();
  const inst = instances().find((i) => i.name === 'web-prod-07');
  const stays = STAYS.filter((s) => !s.soldOut).map((s) => ({ ...s, total: stayTotal(s) })).sort((a, b) => a.total - b.total);
  const job = jobs().find((j) => j.visa && /^Fully remote/.test(j.arrangement));
  const storage = usageCsvRows('2026-10').filter((x) => x.service === 'storage').reduce((s, x) => s + x.cost, 0);
  return {
    'feat-audit-export': audit.filter((x) => x.user === 'ops-bot' && x.status === 'Denied').length,
    'feat-instance-pane': inst.primaryIp,
    'feat-stays-cheapest': stays[0].name,
    'feat-jobs-detail': job.id,
    'feat-billing-dialog': billing('borealis', '2026-08').total,
    'feat-settings-resume': 400,
    'feat-usage-csv': Math.round(storage * 100) / 100,
    _stays: stays.map((s) => `${s.name} ${s.total.toFixed(2)}`),
    _distractors: { instance: [inst.publicIp, inst.secondaryIp, instances().find((i) => i.name === 'web-prod-07-canary').primaryIp] },
  };
}

// ----------------------------------------------------------------- pages ---
const CSS = `
*{box-sizing:border-box}body{margin:0;font:14px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2329;background:#f5f6f7}
header{background:#1d2b3a;color:#fff;padding:10px 20px;display:flex;gap:16px;align-items:center}header b{font-size:16px}
.wrap{display:flex;min-height:calc(100vh - 44px)}nav.side{width:200px;background:#fff;border-right:1px solid #e3e5e8;padding:12px 0}
nav.side a{display:block;padding:8px 20px;color:#1f2329;text-decoration:none}nav.side a.on{background:#e8f0fe;color:#1a56db;font-weight:600}
main{flex:1;padding:20px 28px;min-width:0}h1{font-size:20px;margin:0 0 6px}p.sub{color:#646a73;margin:0 0 16px}
table{border-collapse:collapse;width:100%;background:#fff}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #eceef0;white-space:nowrap}th{background:#fafbfc;font-weight:600;color:#4e5969}
button,select{font:inherit;padding:6px 12px;border:1px solid #c9cdd4;border-radius:4px;background:#fff;cursor:pointer}button.primary{background:#1a56db;color:#fff;border-color:#1a56db}
button:disabled{opacity:.45;cursor:default}.pager{display:flex;gap:10px;align-items:center;margin:12px 0}
.pane{position:fixed;top:0;right:0;width:460px;height:100vh;background:#fff;box-shadow:-4px 0 16px rgba(0,0,0,.15);padding:18px 22px;overflow:auto}
.tabs{display:flex;gap:4px;border-bottom:1px solid #e3e5e8;margin:12px 0}.tabs button{border:none;border-bottom:2px solid transparent;border-radius:0;background:none}.tabs button.on{border-bottom-color:#1a56db;color:#1a56db}
dl{display:grid;grid-template-columns:160px 1fr;gap:6px 12px;margin:0}dt{color:#646a73}dd{margin:0}
.modal-back{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:50}.modal{background:#fff;border-radius:8px;padding:22px 26px;width:420px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px}.card{background:#fff;border:1px solid #e3e5e8;border-radius:10px;padding:14px}
.card .img{height:110px;border-radius:6px;background:linear-gradient(135deg,#9ec5fe,#cfe2ff);margin-bottom:10px}.price{font-weight:700;font-size:16px}.muted{color:#646a73}
.spinner{color:#646a73;padding:20px 0}.acc{background:#fff;border:1px solid #e3e5e8;border-radius:6px;margin:10px 0}.acc>button{width:100%;text-align:left;border:none;padding:12px 14px;font-weight:600}
.acc>div{padding:0 14px 14px}a{color:#1a56db}.joblist li{background:#fff;border:1px solid #e3e5e8;border-radius:8px;padding:12px 16px;margin:8px 0;list-style:none}
`;
const page = (title, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
const NAV = [['/console/', 'Overview'], ['/console/instances', 'Instances'], ['/console/audit', 'Audit log'], ['/console/billing', 'Billing'], ['/console/reports', 'Reports'], ['/console/settings', 'Settings']];
const consolePage = (title, active, body, script) => page(`${title} · Nimbus Console`,
  `<header><b>Nimbus Console</b><span>Account: demo-corp</span><span style="margin-left:auto">Region: Singapore</span></header><div class="wrap"><nav class="side">${NAV.map(([h, t]) => `<a href="${h}"${t === active ? ' class="on"' : ''}>${t}</a>`).join('')}</nav><main>${body}</main></div>`, script);

function overview() {
  return consolePage('Overview', 'Overview', `<h1>Overview</h1><p class="sub">Welcome back. Resources across all projects in the Singapore region.</p>
<table><tr><th>Resource</th><th>Count</th><th>Status</th></tr><tr><td>Instances</td><td>42</td><td>38 running, 4 stopped</td></tr><tr><td>Buckets</td><td>5</td><td>OK</td></tr><tr><td>Databases</td><td>3</td><td>OK</td></tr><tr><td>Open alerts</td><td>2</td><td>Warning</td></tr></table>
<p>Use the menu on the left to manage instances, review the audit log, see billing, export reports or change settings.</p>`);
}

function auditPage() {
  return consolePage('Audit log', 'Audit log', `<h1>Audit log</h1><p class="sub">Every API call made in this account in the last 30 days, newest first. <span id="count"></span></p>
<table id="log"><thead><tr><th>Time (UTC)</th><th>User</th><th>Action</th><th>Resource</th><th>Source IP</th><th>Status</th></tr></thead><tbody></tbody></table>
<div class="pager"><button id="prev">Previous</button><span id="where">Loading…</span><button id="next">Next</button></div>`,
  `let page=1,pages=1;const tb=document.querySelector('#log tbody');
async function load(){document.getElementById('where').textContent='Loading…';tb.style.opacity=.4;
const r=await (await fetch('/console/api/audit?page='+page)).json();await new Promise(ok=>setTimeout(ok,250+Math.random()*350));pages=r.pages;
tb.innerHTML=r.rows.map(x=>'<tr><td>'+x.time+'</td><td>'+x.user+'</td><td>'+x.action+'</td><td>'+x.resource+'</td><td>'+x.ip+'</td><td>'+x.status+'</td></tr>').join('');tb.style.opacity=1;
document.getElementById('count').textContent=r.total+' events.';document.getElementById('where').textContent='Page '+page+' of '+pages;
document.getElementById('prev').disabled=page<=1;document.getElementById('next').disabled=page>=pages;}
document.getElementById('next').onclick=()=>{if(page<pages){page++;load();}};document.getElementById('prev').onclick=()=>{if(page>1){page--;load();}};load();`);
}

function instancesPage() {
  const rows = instances();
  return consolePage('Instances', 'Instances', `<h1>Instances</h1><p class="sub">${rows.length} instances. Select an instance to see its details.</p>
<table><thead><tr><th>Name</th><th>Instance ID</th><th>Status</th><th>Zone</th><th>Type</th><th>Created</th></tr></thead><tbody>
${rows.map((x) => `<tr><td><a href="#" data-id="${x.id}" class="inst">${x.name}</a></td><td>${x.id}</td><td>${x.status}</td><td>${x.zone}</td><td>${x.type}</td><td>${x.created}</td></tr>`).join('\n')}
</tbody></table><div id="pane"></div>`,
  `const pane=document.getElementById('pane');let cur=null,tab='Overview';
function render(){if(!cur){pane.innerHTML='';return;}const x=cur;const tabs=['Overview','Network','Tags'];
let body='';if(tab==='Overview')body='<dl><dt>Instance ID</dt><dd>'+x.id+'</dd><dt>Status</dt><dd>'+x.status+'</dd><dt>Type</dt><dd>'+x.type+'</dd><dt>Zone</dt><dd>'+x.zone+'</dd><dt>Public IP</dt><dd>'+x.publicIp+'</dd><dt>VPC</dt><dd>'+x.vpc+'</dd></dl>';
else if(tab==='Network')body='<h3>Network interfaces</h3><table><tr><th>Interface</th><th>Role</th><th>Private IP</th><th>Security group</th></tr><tr><td>'+x.eni2+'</td><td>Secondary</td><td>'+x.secondaryIp+'</td><td>'+x.sg+'</td></tr><tr><td>'+x.eni1+'</td><td>Primary</td><td>'+x.primaryIp+'</td><td>'+x.sg+'</td></tr></table>';
else body='<dl><dt>env</dt><dd>'+x.name.split('-')[1]+'</dd><dt>role</dt><dd>'+x.name.split('-')[0]+'</dd><dt>owner</dt><dd>platform-team</dd></dl>';
pane.innerHTML='<div class="pane" role="complementary" aria-label="Instance details"><button id="close" style="float:right">Close</button><h2>'+x.name+'</h2><div class="tabs">'+tabs.map(t=>'<button class="tab'+(t===tab?' on':'')+'">'+t+'</button>').join('')+'</div>'+body+'</div>';
pane.querySelector('#close').onclick=()=>{cur=null;render();};pane.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{tab=b.textContent;render();});}
document.querySelectorAll('a.inst').forEach(a=>a.onclick=async(e)=>{e.preventDefault();pane.innerHTML='<div class="pane"><div class="spinner">Loading instance…</div></div>';
const x=await (await fetch('/console/api/instance?id='+a.dataset.id)).json();await new Promise(ok=>setTimeout(ok,600));cur=x;tab='Overview';render();});`);
}

function billingPage() {
  return consolePage('Billing', 'Billing', `<h1>Billing</h1><p class="sub">Monthly cost summaries by project. Choose a project and a month, then show the summary.</p>
<div style="display:flex;gap:12px;align-items:center;margin-bottom:16px"><label>Project <select id="project">${PROJECTS.map((p) => `<option>${p}</option>`).join('')}</select></label>
<label>Month <select id="month">${MONTHS.map((m) => `<option${m === '2026-10' ? ' selected' : ''}>${m}</option>`).join('')}</select></label><button class="primary" id="show">Show summary</button></div>
<div id="summary"></div><div id="modal"></div>`,
  `let noticed=false;const modal=document.getElementById('modal');
function notice(){if(noticed)return;noticed=true;modal.innerHTML='<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="nt"><h3 id="nt">Notice</h3><p>Billing data for September 2026 is being recalculated after a pricing correction. Summaries for other months are final.</p><div style="text-align:right"><button id="ok">Got it</button></div></div></div>';
document.getElementById('ok').onclick=()=>{modal.innerHTML='';};}
document.querySelectorAll('select').forEach(s=>s.addEventListener('change',()=>setTimeout(notice,900)));setTimeout(notice,6000);
async function show(){const p=document.getElementById('project').value,m=document.getElementById('month').value;document.getElementById('summary').innerHTML='<div class="spinner">Calculating…</div>';
const r=await (await fetch('/console/api/billing?project='+p+'&month='+m)).json();await new Promise(ok=>setTimeout(ok,500));
document.getElementById('summary').innerHTML='<h2>'+p+' · '+m+'</h2><table><tr><th>Line item</th><th>Cost (USD)</th></tr>'+r.items.map(i=>'<tr><td>'+i.name+'</td><td>$'+i.cost.toFixed(2)+'</td></tr>').join('')+'<tr><th>Total</th><th>$'+r.total.toLocaleString('en-US',{minimumFractionDigits:2})+'</th></tr></table>';}
document.getElementById('show').onclick=show;show();`);
}

function reportsPage() {
  const rows = usageCsvRows('2026-10');
  const by = {};
  for (const x of rows) by[x.service] = (by[x.service] || 0) + x.cost;
  return consolePage('Reports', 'Reports', `<h1>Reports</h1><p class="sub">Usage exports list every billed line for a month (one row per project, service and SKU per day).</p>
<h3>October 2026 at a glance</h3><table><tr><th>Service</th><th>Approximate cost</th></tr>${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([s, c]) => `<tr><td>${s}</td><td>about $${(Math.round(c / 100) / 10).toFixed(1)}k</td></tr>`).join('')}</table>
<h3 style="margin-top:24px">Usage export</h3><div style="display:flex;gap:12px;align-items:center"><label>Month <select id="m">${MONTHS.map((m) => `<option${m === '2026-09' ? ' selected' : ''}>${m}</option>`).join('')}</select></label><button class="primary" id="exp">Export CSV</button><span id="st" class="muted"></span></div>`,
  `document.getElementById('exp').onclick=()=>{const m=document.getElementById('m').value;const st=document.getElementById('st');st.textContent='Preparing export…';document.getElementById('exp').disabled=true;
setTimeout(()=>{st.textContent='usage-'+m+'.csv is ready; your download has started.';document.getElementById('exp').disabled=false;const a=document.createElement('a');a.href='/console/export/usage-'+m+'.csv';document.body.appendChild(a);a.click();a.remove();},2000);};`);
}

function settingsPage() {
  return consolePage('Settings', 'Settings', `<h1>Settings</h1><div style="display:flex;gap:24px"><div style="width:180px" id="sub">
<button class="sec" data-s="General">General</button><br><br><button class="sec" data-s="Members">Members</button><br><br><button class="sec" data-s="Data &amp; privacy">Data &amp; privacy</button><br><br><button class="sec" data-s="Integrations">Integrations</button></div><div style="flex:1" id="body"></div></div>`,
  `const RET=${JSON.stringify(RETENTION)};const body=document.getElementById('body');
const S={General:'<h2>General</h2><dl><dt>Account name</dt><dd>demo-corp</dd><dt>Default region</dt><dd>Singapore</dd><dt>Time zone</dt><dd>UTC</dd><dt>Default log retention for new log types</dt><dd>30 days</dd></dl>',
Members:'<h2>Members</h2><table><tr><th>Name</th><th>Role</th></tr><tr><td>alice</td><td>Owner</td></tr><tr><td>bob</td><td>Admin</td></tr><tr><td>carol</td><td>Viewer</td></tr></table>',
Integrations:'<h2>Integrations</h2><p>Slack: connected. PagerDuty: not connected.</p>'};
function show(s){if(s!=='Data & privacy'){body.innerHTML=S[s];return;}body.innerHTML='<div class="spinner">Loading data settings…</div>';
setTimeout(()=>{body.innerHTML='<h2>Data &amp; privacy</h2><div class="acc"><button class="acc-h" aria-expanded="false">Data exports</button><div hidden><p>Exports are kept for 7 days after they are created.</p></div></div><div class="acc"><button class="acc-h" aria-expanded="false">Retention policies</button><div hidden></div></div><div class="acc"><button class="acc-h" aria-expanded="false">Encryption</button><div hidden><p>All data is encrypted at rest with service-managed keys.</p></div></div>';
body.querySelectorAll('.acc-h').forEach(h=>h.onclick=()=>{const d=h.nextElementSibling;const open=d.hidden;d.hidden=!open;h.setAttribute('aria-expanded',open);
if(open&&h.textContent==='Retention policies'&&!d.dataset.loaded){d.innerHTML='<div class="spinner">Loading policies…</div>';setTimeout(()=>{d.dataset.loaded=1;d.innerHTML='<table><tr><th>Log type</th><th>Retention</th></tr>'+RET.map(r=>'<tr><td>'+r[0]+'</td><td>'+r[1]+'</td></tr>').join('')+'</table>';},1800);}});},1500);}
document.querySelectorAll('.sec').forEach(b=>b.onclick=()=>show(b.dataset.s));show('General');`);
}

function staysPage() {
  return page('Stays in Lisbon · Wanderly', `<header><b>Wanderly</b><span>Stays</span></header><main><h1>Stays in Lisbon</h1>
<p class="sub">Thu, Nov 12 – Sun, Nov 15, 2026 · ${NIGHTS} nights · 2 guests. Prices are shown in each host's own currency; some hosts quote per night, others for the whole stay.</p>
<p class="muted">Exchange rates used for payment: 1 EUR = ${RATES.EUR} USD · 1 GBP = ${RATES.GBP} USD · 1 SGD = ${RATES.SGD} USD.</p>
<div class="grid">${STAYS.map((s) => `<div class="card"><div class="img"></div><h3 style="margin:0 0 4px">${esc(s.name)}</h3><div class="muted">★ ${s.rating} · Lisbon</div>
<div class="price">${esc(s.show)}</div>${s.soldOut ? '<div style="color:#c0392b;font-weight:600">Sold out for your dates</div>' : '<div class="muted">Available</div>'}<button style="margin-top:8px">View</button></div>`).join('\n')}</div></main>`);
}

function jobsPage() {
  return page('Jobs · Hireboard', `<header><b>Hireboard</b><span>Engineering jobs</span></header><main><h1>Engineering jobs</h1><p class="sub">${jobs().length} open roles, most recent first.</p>
<ul class="joblist" style="padding:0">${jobs().map((j) => `<li><a href="/jobs/${j.id}"><b>${esc(j.title)}</b></a> · ${esc(j.company)} · ${esc(j.label)} · <span class="muted">${j.posted}</span></li>`).join('\n')}</ul></main>`);
}
function jobPage(id) {
  const j = jobs().find((x) => x.id === id);
  if (!j) return null;
  return page(`${j.title} at ${j.company} · Hireboard`, `<header><b>Hireboard</b><span>Engineering jobs</span></header><main><p><a href="/jobs">← All jobs</a></p><h1>${esc(j.title)}</h1><p class="sub">${esc(j.company)} · ${j.id}</p>
<dl><dt>Job ID</dt><dd>${j.id}</dd><dt>Work arrangement</dt><dd>${esc(j.arrangement)}</dd><dt>Visa sponsorship</dt><dd>${j.visa ? 'Available' : 'Not available'}</dd><dt>Salary</dt><dd>${j.salary}</dd><dt>Posted</dt><dd>${j.posted}</dd></dl>
<h3>About the role</h3><p>You will join a small team building ${esc(j.company)}'s platform. We value clear writing, careful reviews and shipping small changes often.</p><button>Apply</button></main>`);
}

// ---------------------------------------------------------------- routes ---
export function route(url) {
  const u = new URL(url, 'http://x');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  const html = (body) => ({ status: 200, type: 'text/html; charset=utf-8', body });
  const json = (o) => ({ status: 200, type: 'application/json', body: JSON.stringify(o) });
  if (p === '/' || p === '/console') return html(overview());
  if (p === '/console/audit') return html(auditPage());
  if (p === '/console/instances') return html(instancesPage());
  if (p === '/console/billing') return html(billingPage());
  if (p === '/console/reports') return html(reportsPage());
  if (p === '/console/settings') return html(settingsPage());
  if (p === '/stays') return html(staysPage());
  if (p === '/jobs') return html(jobsPage());
  if (p.startsWith('/jobs/')) { const b = jobPage(p.slice(6)); if (b) return html(b); }
  if (p === '/console/api/audit') {
    const rows = auditRows(), n = Math.max(1, Math.min(Math.ceil(rows.length / AUDIT_PAGE), Number(u.searchParams.get('page')) || 1));
    return json({ page: n, pages: Math.ceil(rows.length / AUDIT_PAGE), total: rows.length, rows: rows.slice((n - 1) * AUDIT_PAGE, n * AUDIT_PAGE) });
  }
  if (p === '/console/api/instance') { const x = instances().find((i) => i.id === u.searchParams.get('id')); if (x) return json(x); }
  if (p === '/console/api/billing') {
    const pr = u.searchParams.get('project'), m = u.searchParams.get('month');
    if (PROJECTS.includes(pr) && MONTHS.includes(m)) return json(billing(pr, m));
  }
  const csv = p.match(/^\/console\/export\/usage-(\d{4}-\d{2})\.csv$/);
  if (csv && MONTHS.includes(csv[1])) {
    const rows = usageCsvRows(csv[1]);
    return { status: 200, type: 'text/csv', headers: { 'content-disposition': `attachment; filename="usage-${csv[1]}.csv"` },
      body: 'date,project,service,sku,quantity,cost_usd\n' + rows.map((x) => `${x.date},${x.project},${x.service},${x.sku},${x.quantity},${x.cost.toFixed(2)}`).join('\n') + '\n' };
  }
  if (p === '/favicon.ico') return { status: 204, type: 'text/plain', body: '' };
  return { status: 404, type: 'text/html; charset=utf-8', body: page('Not found', '<main><h1>Not found</h1><p>There is no page at this address on this site.</p></main>') };
}
