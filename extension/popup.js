// Popup: the multi-select tab handover. This is the interaction the injected
// path cannot offer, because it needs browser-level UI rather than page UI.
const BRIDGE = 'http://127.0.0.1:17222';

async function marks() {
  try {
    return await (await fetch(`${BRIDGE}/api/marks`)).json();
  } catch {
    return [];
  }
}

async function render() {
  const [tabs, marked] = await Promise.all([chrome.tabs.query({}), marks()]);
  const markedByUrl = new Map(marked.map(m => [m.url, m]));
  const list = document.getElementById('list');
  list.innerHTML = '';
  for (const t of tabs) {
    const isMarked = markedByUrl.has(t.url);
    const row = document.createElement('div');
    row.className = 'row' + (isMarked ? ' marked' : '');
    row.innerHTML =
      `<input type="checkbox" ${isMarked ? 'checked' : ''}>` +
      '<div class="meta"><div class="t"></div><div class="u"></div>' +
      '<input type="text" placeholder="Note for the agent (optional)"></div>';
    row.querySelector('.t').textContent = t.title || '(untitled)';
    row.querySelector('.u').textContent = t.url;
    const note = row.querySelector('input[type=text]');
    note.value = markedByUrl.get(t.url)?.note || '';
    const box = row.querySelector('input[type=checkbox]');
    const apply = async checked => {
      await fetch(`${BRIDGE}/api/marks/by-url`, {
        method: checked ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: t.url, title: t.title, note: note.value || null }),
      });
      row.className = 'row' + (checked ? ' marked' : '');
      count();
    };
    box.addEventListener('change', () => apply(box.checked));
    note.addEventListener('change', () => box.checked && apply(true));
    list.appendChild(row);
  }
  count();
}

async function count() {
  let annotations = [];
  try {
    annotations = await (await fetch(`${BRIDGE}/api/annotations`)).json();
  } catch {
    document.getElementById('count').textContent = 'bridge not running: run `cdp bridge`';
    return;
  }
  const m = await marks();
  document.getElementById('count').textContent = `${m.length} marked · ${annotations.length} annotations waiting`;
}

document.getElementById('open-tray').addEventListener('click', () => {
  chrome.tabs.create({ url: `${BRIDGE}/tray` });
});

async function activeAction(kind, button) {
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'Working…';
  const result = await chrome.runtime.sendMessage({ kind });
  if (result?.ok) window.close();
  else {
    button.textContent = result?.error || 'Could not complete that action';
    setTimeout(() => { button.textContent = label; button.disabled = false; }, 2500);
  }
}

document.getElementById('annotate').addEventListener('click', e => activeAction('toggle-active-annotate', e.currentTarget));
document.getElementById('hand-tab').addEventListener('click', e => activeAction('hand-active-tab', e.currentTarget));

render();
