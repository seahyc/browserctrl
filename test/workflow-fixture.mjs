import http from 'node:http';

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

function page(title, body, script = '') {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
  <main>${body}</main>
  <script>
    const fixtureValues = () => JSON.parse(sessionStorage.getItem('fixtureValues') || '{}');
    const fixtureClicks = () => JSON.parse(sessionStorage.getItem('fixtureClicks') || '{}');
    const fixtureResults = () => JSON.parse(sessionStorage.getItem('fixtureResults') || '[]');
    window.fixtureState = () => ({
      route: location.pathname,
      values: fixtureValues(),
      results: fixtureResults(),
      clickCount: fixtureClicks(),
      forbiddenCount: Number(sessionStorage.getItem('forbiddenCount') || 0),
    });
    ${script}
  </script>
</body>
</html>`;
}

function render(pathname) {
  if (pathname === '/job') {
    return page('Create job', `
      <h1>Create job</h1>
      <label for="job-title">Job title</label>
      <input id="job-title" type="text">
      <label for="description">Description</label>
      <textarea id="description"></textarea>
      <label for="employment">Employment type</label>
      <select id="employment">
        <option value="">Choose one</option>
        <option value="Full-time">Full-time</option>
        <option value="Part-time">Part-time</option>
        <option value="Contract">Contract</option>
      </select>
      <button id="job-next" type="button">Next</button>`, `
      document.querySelector('#job-next').addEventListener('click', () => {
        const clicks = fixtureClicks();
        clicks['job-next'] = (clicks['job-next'] || 0) + 1;
        sessionStorage.setItem('fixtureClicks', JSON.stringify(clicks));
        sessionStorage.setItem('fixtureValues', JSON.stringify({
          ...fixtureValues(),
          title: document.querySelector('#job-title').value,
          description: document.querySelector('#description').value,
          employment: document.querySelector('#employment').value,
        }));
        location.href = '/keywords';
      });`);
  }

  if (pathname === '/keywords') {
    return page('Keywords', `
      <h1>Keywords</h1>
      <label for="keywords">Keywords</label>
      <textarea id="keywords"></textarea>
      <button id="preview" type="button">Preview</button>
      <section id="preview-result" aria-live="polite"></section>`, `
      document.querySelector('#preview').addEventListener('click', () => {
        const clicks = fixtureClicks();
        clicks.preview = (clicks.preview || 0) + 1;
        sessionStorage.setItem('fixtureClicks', JSON.stringify(clicks));
        const values = { ...fixtureValues(), keywords: document.querySelector('#keywords').value };
        sessionStorage.setItem('fixtureValues', JSON.stringify(values));
        sessionStorage.setItem('fixtureResults', JSON.stringify(['Draft ready']));
        const result = document.querySelector('#preview-result');
        const heading = document.createElement('h2');
        heading.textContent = 'Draft ready';
        result.replaceChildren(heading);
        for (const value of [values.title, values.description, values.employment, values.keywords]) {
          const output = document.createElement('p');
          output.textContent = value;
          result.append(output);
        }
      });`);
  }

  if (pathname === '/admin') {
    return page('User directory', `
      <h1>User directory</h1>
      <table>
        <thead><tr><th>Name</th><th>Action</th></tr></thead>
        <tbody>
          <tr><td>Y. Chen</td><td><a href="/admin/person/yc">Details</a></td></tr>
          <tr><td>Alex Tan</td><td><a href="/admin/person/alex">Details</a></td></tr>
          <tr><td>Mei Lim</td><td><a href="/admin/person/mei">Details</a></td></tr>
        </tbody>
      </table>`);
  }

  if (pathname.startsWith('/admin/person/')) {
    const id = pathname.split('/').at(-1);
    const records = {
      yc: ['Y. Chen', 'Engineering Manager'],
      alex: ['Alex Tan', 'Product Designer'],
      mei: ['Mei Lim', 'Data Analyst'],
    };
    const [name, role] = records[id] || ['Unknown user', 'Unknown role'];
    return page('Person details', `
      <h1>Person details</h1>
      <dl><dt>Name</dt><dd>${escapeHtml(name)}</dd><dt>Role</dt><dd>${escapeHtml(role)}</dd></dl>`);
  }

  if (pathname === '/research') {
    return page('Research library', `
      <h1>Research library</h1>
      <ul>
        <li><a href="/research/product">Product</a></li>
        <li><a href="/research/automation">Automation</a></li>
        <li><a href="/research/docs">Docs</a></li>
      </ul>`);
  }

  if (pathname === '/research/automation') {
    return page('Automation research', `
      <h1>Automation research</h1>
      <p>Notes about reliable browser tooling.</p>
      <a href="/research/cdp">CDP</a>`);
  }

  if (pathname === '/research/cdp') {
    return page('CDP research', `
      <h1>CDP research</h1>
      <p>Persistent connection</p>
      <p>Event-driven waits</p>`);
  }

  if (pathname === '/research/product' || pathname === '/research/docs') {
    const category = pathname.endsWith('product') ? 'Product' : 'Docs';
    return page(`${category} research`, `<h1>${category} research</h1><p>Category notes</p>`);
  }

  if (pathname === '/ambiguous') {
    return page('Ambiguous controls', `
      <h1>Ambiguous controls</h1>
      <button type="button" data-testid="primary-next">Next</button>
      <button type="button" data-testid="secondary-next">Next</button>`, `
      for (const button of document.querySelectorAll('button')) {
        button.addEventListener('click', () => {
          const clicks = fixtureClicks();
          const key = button.dataset.testid;
          clicks[key] = (clicks[key] || 0) + 1;
          sessionStorage.setItem('fixtureClicks', JSON.stringify(clicks));
        });
      }`);
  }

  if (pathname === '/validation') {
    return page('Validation example', `
      <h1>Validation example</h1>
      <label for="validation-title">Title</label>
      <input id="validation-title" type="text">
      <button id="validation-next" type="button">Next</button>
      <p id="validation-error" role="alert"></p>`, `
      document.querySelector('#validation-next').addEventListener('click', () => {
        const clicks = fixtureClicks();
        clicks['validation-next'] = (clicks['validation-next'] || 0) + 1;
        sessionStorage.setItem('fixtureClicks', JSON.stringify(clicks));
        const title = document.querySelector('#validation-title').value.trim();
        const values = { ...fixtureValues(), validationTitle: title };
        sessionStorage.setItem('fixtureValues', JSON.stringify(values));
        document.querySelector('#validation-error').textContent = title ? 'Saved for review' : 'Title is required';
      });`);
  }

  if (pathname === '/blocked') {
    return page('Blocked action', `
      <h1>Blocked action</h1>
      <button id="send" type="button">Send</button>`, `
      document.querySelector('#send').addEventListener('click', () => {
        const next = Number(sessionStorage.getItem('forbiddenCount') || 0) + 1;
        sessionStorage.setItem('forbiddenCount', String(next));
      });`);
  }

  if (pathname === '/delay') {
    return page('Delayed results', `
      <h1>Delayed results</h1>
      <button id="load-results" type="button">Load results</button>
      <section id="results" aria-live="polite"></section>`, `
      document.querySelector('#load-results').addEventListener('click', () => {
        setTimeout(() => {
          document.querySelector('#results').textContent = 'Results ready';
          sessionStorage.setItem('fixtureResults', JSON.stringify(['Results ready']));
        }, 120);
      });`);
  }

  return page('Not found', '<h1>Not found</h1>');
}

export async function startFixture() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.writeHead(url.pathname === '/favicon.ico' ? 204 : 200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(url.pathname === '/favicon.ico' ? '' : render(url.pathname));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

export function plans(origin) {
  return [
    {
      id: 'job-draft',
      startPath: '/job',
      goal: 'Create a job draft preview',
      stages: [
        {
          expect: { textIncludes: 'Create job' },
          actions: [
            { kind: 'fill', target: { role: 'textbox', name: 'Job title' }, value: 'Platform Engineer' },
            { kind: 'fill', target: { role: 'textbox', name: 'Description' }, value: 'Build reliable developer tools' },
            { kind: 'select', target: { role: 'select', name: 'Employment type' }, value: 'Full-time' },
            { kind: 'click', target: { role: 'button', name: 'Next' }, after: { urlEquals: `${origin}/keywords` } },
          ],
        },
        {
          expect: { textIncludes: 'Keywords' },
          actions: [
            { kind: 'fill', target: { role: 'textbox', name: 'Keywords' }, value: 'Node.js, CDP, automation' },
            { kind: 'click', target: { role: 'button', name: 'Preview' }, after: { textIncludes: 'Draft ready' } },
          ],
        },
      ],
      success: { textIncludes: 'Draft ready' },
      oracle: {
        route: '/keywords',
        values: { title: 'Platform Engineer', description: 'Build reliable developer tools', employment: 'Full-time', keywords: 'Node.js, CDP, automation' },
        results: ['Draft ready'],
        clickCount: { 'job-next': 1, preview: 1 },
      },
    },
    {
      id: 'admin-person',
      startPath: '/admin',
      goal: 'Open the Engineering Manager details',
      stages: [{
        expect: { textIncludes: 'User directory' },
        actions: [{
          kind: 'click',
          target: { role: 'link', name: 'Details', href: `${origin}/admin/person/yc` },
          after: { urlEquals: `${origin}/admin/person/yc` },
        }],
      }],
      success: { textIncludes: 'Engineering Manager' },
      oracle: { route: '/admin/person/yc' },
    },
    {
      id: 'research-cdp',
      startPath: '/research',
      goal: 'Find the CDP automation research',
      stages: [
        {
          expect: { textIncludes: 'Research library' },
          actions: [{ kind: 'click', target: { role: 'link', name: 'Automation' }, after: { urlEquals: `${origin}/research/automation` } }],
        },
        {
          expect: { textIncludes: 'Automation research' },
          actions: [{ kind: 'click', target: { role: 'link', name: 'CDP' }, after: { urlEquals: `${origin}/research/cdp` } }],
        },
      ],
      success: { textIncludes: 'Persistent connection' },
      oracle: { route: '/research/cdp' },
    },
    {
      id: 'delayed-results',
      startPath: '/delay',
      goal: 'Load the delayed results',
      stages: [{
        expect: { textIncludes: 'Delayed results' },
        actions: [{ kind: 'click', target: { role: 'button', name: 'Load results' }, after: { textIncludes: 'Results ready' } }],
      }],
      success: { textIncludes: 'Results ready' },
      oracle: { route: '/delay', results: ['Results ready'] },
    },
  ];
}
