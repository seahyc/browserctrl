import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as trace from '../lib/trace.mjs';
import { randomUUID } from 'node:crypto';
import {
  startFixtureServer,
  startHeadlessBrowser,
  chromeBinary,
  TEST_PORT,
} from './helpers.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { systemOne, jevKey } from '../lib/jev.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev } from './fake-jev.mjs';
process.env.CDP_AGENT_ID = 'test-vision';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_NOTES = 'off';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-vision-'));
process.env.BROWSERCTRL_TRACES = tmp;
let fixture, browser, conn;
const haveBrowser = Boolean(chromeBinary());
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  conn?.close();
  await browser?.close();
  await fixture?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const t = (name, fn) => test(name, { skip: !haveBrowser }, fn);
const open = async (suffix = '') => {
  const id = (
    await ops.newTab(conn, fixture.url + 'fixtures/vision-icons.html' + suffix)
  ).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};
const boxAt = async (id) =>
  ops.evaluate(
    conn,
    id,
    `(()=>{const r=document.querySelector('button,canvas').getBoundingClientRect();return {left:r.left/innerWidth,right:r.right/innerWidth,top:r.top/innerHeight,bottom:r.bottom/innerHeight}})()`,
  );
const scripted = (box, { visible = 0.96, confidence = 0.94, choice } = {}) =>
  fakeJev({
    choice,
    noul: (q, id) => (id === 'visible' ? visible : 0.04),
    box: () => ({ box, confidence }),
  });
const visionCalls = (j) =>
  j.calls.filter((c) => c.questions.where?.type === 'box');
const run = (id, steps, j) =>
  runSteps(conn, id, steps, { jev: j, noNotes: true });
test('default Jev model is pinned and environment override remains supported', () => {
  assert.equal(jevKey({ TYPESAFE_API_KEY: 'fake' }).model, 'jev-1.14.0');
  assert.equal(
    jevKey({ TYPESAFE_API_KEY: 'fake', TYPESAFE_MODEL: 'jev-1.13.0' }).model,
    'jev-1.13.0',
  );
});
test('systemOne sends assets with opt-in header and redacts bytes in logs', async () => {
  const file = path.join(tmp, 'jev.jsonl');
  process.env.BROWSERCTRL_JEV_LOG = file;
  const j = fakeJev({ model: 'jev-1.14.0' });
  const ref = randomUUID();
  const bytes = Buffer.from('private-image-pixels').toString('base64');
  try {
    await systemOne(
      { key: 'fake', model: 'jev-1.14.0' },
      { screenshot: ref },
      { visible: { type: 'noul', instructions: 'visible?' } },
      {
        fetchImpl: j.fetchImpl,
        assets: {
          [ref]: { type: 'image', format: 'jpeg', data_base64: bytes },
        },
      },
    );
    const sentRef = j.calls[0].state.screenshot;
    assert.match(sentRef, /^[0-9a-f-]{36}$/i);
    assert.ok(j.calls[0].assets?.[sentRef]);
    assert.equal(
      new Headers(j.requests[0].headers).get('TypeSafe-Danger-Zone-Images'),
      'true',
    );
    const log = fs.readFileSync(file, 'utf8');
    assert.ok(log.includes(sentRef));
    assert.ok(!log.includes(bytes));
    await systemOne(
      j.cfg,
      {},
      { visible: { type: 'noul', instructions: 'visible?' } },
      { fetchImpl: j.fetchImpl },
    );
    assert.equal(
      new Headers(j.requests[1].headers).get('TypeSafe-Danger-Zone-Images'),
      null,
    );
  } finally {
    delete process.env.BROWSERCTRL_JEV_LOG;
  }
});
t(
  'unnamed svg button uses one screenshot request with pinned Box model',
  async () => {
    const id = await open();
    try {
      const j = scripted(await boxAt(id));
      j.cfg.model = 'jev-1.13.0';
      const r = await run(id, ['click "the magnifying glass"'], j);
      assert.equal(r.done, true, JSON.stringify(r.stopped));
      assert.equal(
        await ops.evaluate(conn, id, 'state.textContent'),
        'clicked',
      );
      assert.match(r.steps[0].how, /screenshot.*p=.*box confidence=/);
      assert.equal(r.steps[0].unsure, true);
      assert.equal(visionCalls(j).length, 1);
      const c = visionCalls(j)[0];
      assert.equal(c.model, 'jev-1.14.0');
      assert.equal(c.questions.visible.type, 'noul');
      assert.match(c.state.screenshot, /^[0-9a-f-]{36}$/i);
      assert.ok(c.assets[c.state.screenshot]);
    } finally {
      await ops.closeTab(conn, id);
    }
  },
);
t('canvas click uses the visual point and always warns', async () => {
  const id = await open('?mode=canvas');
  try {
    const j = scripted(await boxAt(id));
    const r = await run(id, ['click "the blue square"'], j);
    assert.equal(r.done, true, JSON.stringify(r.stopped));
    assert.equal(
      await ops.evaluate(conn, id, 'state.textContent'),
      'canvas clicked',
    );
    assert.equal(r.steps[0].unsure, true);
    assert.match(formatSteps(r), /⚠/);
  } finally {
    await ops.closeTab(conn, id);
  }
});
for (const [label, opts] of [
  ['not visible', { visible: 0.749 }],
  ['low box confidence', { confidence: 0.599 }],
  ['oversized box', { large: true }],
])
  t(`vision refuses ${label} and reports what it saw`, async () => {
    const id = await open();
    try {
      const j = scripted(
        opts.large ? { left: 0, right: 1, top: 0, bottom: 1 } : await boxAt(id),
        opts,
      );
      const r = await run(id, ['click "the magnifying glass"'], j);
      assert.equal(r.done, false);
      assert.equal(await ops.evaluate(conn, id, 'state.textContent'), 'idle');
      assert.equal(visionCalls(j).length, 1);
      assert.match(r.stopped.reason, /vision|screenshot/i);
    } finally {
      await ops.closeTab(conn, id);
    }
  });
t('visual match cannot bypass the commit guard', async () => {
  const id = await open('?mode=commit');
  try {
    const j = scripted(await boxAt(id));
    const r = await run(id, ['click "the red trash icon"'], j);
    assert.equal(r.done, false);
    assert.equal(await ops.evaluate(conn, id, 'state.textContent'), 'idle');
    assert.equal(visionCalls(j).length, 1);
    assert.match(r.stopped.reason, /commit|exact name|click!/i);
    const exact = await run(id, ['click! "Delete"'], j);
    assert.equal(exact.done, true, JSON.stringify(exact.stopped));
  } finally {
    await ops.closeTab(conn, id);
  }
});
t(
  'vision off preserves the original stop reason and does not send images',
  async () => {
    const id = await open();
    try {
      process.env.BROWSERCTRL_VISION = 'off';
      const j = scripted(await boxAt(id));
      const r = await run(id, ['click "the magnifying glass"'], j);
      assert.equal(r.done, false);
      assert.equal(visionCalls(j).length, 0);
      assert.doesNotMatch(r.stopped.reason, /screenshot/i);
    } finally {
      delete process.env.BROWSERCTRL_VISION;
      await ops.closeTab(conn, id);
    }
  },
);
t('direct selectors and stale refs never fall back to vision', async () => {
  const id = await open();
  try {
    const j = scripted(await boxAt(id));
    for (const step of [
      'click "#does-not-exist"',
      'click ref_99999',
      'click i99999',
    ]) {
      const r = await run(id, [step], j);
      assert.equal(r.done, false);
    }
    assert.equal(visionCalls(j).length, 0);
  } finally {
    await ops.closeTab(conn, id);
  }
});
t('failed viewport capture returns null without sending images', async () => {
  assert.equal(typeof ops.captureViewport, 'function');
  assert.equal(
    await ops.captureViewport(
      {
        send: async () => {
          throw new Error('suspended');
        },
      },
      'missing',
    ),
    null,
  );
});
t(
  'named visual pick at high confidence needs no uncertainty marker',
  async () => {
    const id = await open('?mode=named');
    try {
      const j = scripted(await boxAt(id));
      const r = await run(id, ['click "the magnifying glass"'], j);
      assert.equal(r.done, true, JSON.stringify(r.stopped));
      assert.match(r.steps[0].how, /screenshot/);
      assert.notEqual(r.steps[0].unsure, true);
      assert.equal(
        await ops.evaluate(conn, id, 'state.textContent'),
        'clicked',
      );
    } finally {
      await ops.closeTab(conn, id);
    }
  },
);
t(
  'capture scales device pixels and vision maps back to CSS coordinates',
  async () => {
    const id = await open();
    try {
      await conn.send(id, 'Emulation.setDeviceMetricsOverride', {
        width: 1200,
        height: 800,
        deviceScaleFactor: 2,
        mobile: false,
      });
      const capture = await ops.captureViewport(conn, id);
      assert.ok(capture);
      assert.equal(capture.devicePixelRatio, 2);
      assert.equal(capture.cssWidth, 1200);
      assert.equal(capture.cssHeight, 800);
      assert.ok(capture.width <= 1568 && capture.height <= 1568);
      assert.ok(capture.width >= 280 && capture.height >= 280);
      const j = scripted(await boxAt(id));
      const r = await run(id, ['click "the magnifying glass"'], j);
      assert.equal(r.done, true, JSON.stringify(r.stopped));
      assert.equal(
        await ops.evaluate(conn, id, 'state.textContent'),
        'clicked',
      );
    } finally {
      await ops.closeTab(conn, id);
    }
  },
);
t('blank capture skips vision and preserves the old stop', async () => {
  const id = await open();
  try {
    await ops.evaluate(
      conn,
      id,
      "document.body.innerHTML='';document.body.style.background='white'",
    );
    assert.equal(await ops.captureViewport(conn, id), null);
    const j = scripted({ left: 0.1, right: 0.2, top: 0.1, bottom: 0.2 });
    const r = await run(id, ['click "the magnifying glass"'], j);
    assert.equal(r.done, false);
    assert.equal(visionCalls(j).length, 0);
    assert.doesNotMatch(r.stopped.reason, /screenshot/i);
  } finally {
    await ops.closeTab(conn, id);
  }
});
t(
  'a low text probability can use vision and hover reaches the icon',
  async () => {
    const id = await open('?mode=named');
    try {
      const j = scripted(await boxAt(id), {
        choice: (q) => ({
          choice: Object.keys(q.criteria).find((k) => k !== 'none') || 'none',
          p: 0.2,
        }),
      });
      const r = await run(id, ['hover "the magnifying glass"'], j);
      assert.equal(r.done, true, JSON.stringify(r.stopped));
      assert.equal(
        await ops.evaluate(conn, id, 'document.body.dataset.hovered'),
        'yes',
      );
      assert.equal(visionCalls(j).length, 1);
    } finally {
      await ops.closeTab(conn, id);
    }
  },
);
test('asset references are fresh for each request', async () => {
  const j = fakeJev();
  const ref = 'source-image';
  const assets = {
    [ref]: {
      type: 'image',
      format: 'jpeg',
      data_base64: Buffer.from('pixels').toString('base64'),
    },
  };
  for (let i = 0; i < 2; i++)
    await systemOne(
      j.cfg,
      { screenshot: ref },
      { visible: { type: 'noul', instructions: `is ${ref} visible?` } },
      { fetchImpl: j.fetchImpl, assets },
    );
  const [a, b] = j.calls;
  assert.notEqual(a.state.screenshot, b.state.screenshot);
  for (const c of [a, b]) {
    assert.match(c.state.screenshot, /^[0-9a-f-]{36}$/i);
    assert.ok(c.assets[c.state.screenshot]);
    assert.ok(c.questions.visible.instructions.includes(c.state.screenshot));
  }
});
t('unnamed consequential icon with vague intent is refused', async () => {
  const id = await open('?mode=visual-commit');
  try {
    const box = await boxAt(id);
    const j = fakeJev({
      noul: (q, key) =>
        key === 'visible' ? 0.96 : key === 'consequential' ? 0.95 : 0.04,
      box: () => ({ box, confidence: 0.94 }),
    });
    const r = await run(id, ['click "the red icon"'], j);
    assert.equal(r.done, false);
    assert.equal(await ops.evaluate(conn, id, 'state.textContent'), 'idle');
    assert.equal(visionCalls(j).length, 1);
    assert.match(r.stopped.reason, /commit|consequen|exact name|click!/i);
  } finally {
    await ops.closeTab(conn, id);
  }
});
t(
  'failed screenshot retains old stop reason and sends no vision request',
  async () => {
    const id = await open();
    try {
      const j = scripted(await boxAt(id));
      const broken = new Proxy(conn, {
        get(target, key) {
          if (key === 'send')
            return (tab, method, ...args) =>
              method === 'Page.captureScreenshot'
                ? Promise.reject(new Error('suspended capture'))
                : target.send(tab, method, ...args);
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const r = await runSteps(broken, id, ['click "the magnifying glass"'], {
        jev: j,
        noNotes: true,
      });
      assert.equal(r.done, false);
      assert.equal(visionCalls(j).length, 0);
      assert.doesNotMatch(r.stopped.reason, /screenshot/i);
    } finally {
      await ops.closeTab(conn, id);
    }
  },
);

for (const container of ['role="region"', 'tabindex="0"']) {
  for (const smallButton of [false, true]) {
    t(`vision ${smallButton ? 'chooses small button in' : 'rejects'} large ${container} container`, async () => {
      const id = await open();
      try {
        await ops.evaluate(conn, id, `(() => {
          const icon = document.querySelector('#icon');
          const container = document.createElement('div');
          container.innerHTML = '<div ${container} style="position:absolute;left:60px;top:60px;width:700px;height:500px;background:white"></div>';
          const parent = container.firstChild;
          document.body.append(parent);
          parent.onmouseover = () => { document.body.dataset.containerHovered = 'yes'; };
          ${smallButton ? 'parent.append(icon);' : "const svg = icon.querySelector('svg'); svg.style.cssText = 'position:absolute;left:80px;top:80px;width:48px;height:48px'; parent.append(svg); icon.remove();"}
        })()`);
        const box = await ops.evaluate(conn, id, `(() => {
          const r = document.querySelector('svg').getBoundingClientRect();
          return {left:r.left/innerWidth,right:r.right/innerWidth,top:r.top/innerHeight,bottom:r.bottom/innerHeight};
        })()`);
        const j = scripted(box);
        const r = await run(id, ['hover "the little book icon next to README"'], j);
        assert.equal(visionCalls(j).length, 1);
        assert.equal(r.done, smallButton, JSON.stringify(r.stopped));
        if (smallButton) {
          assert.equal(await ops.evaluate(conn, id, 'document.body.dataset.hovered'), 'yes');
          assert.equal(await ops.evaluate(conn, id, 'document.querySelector("[data-bc-pin]").tagName'), 'BUTTON');
        } else {
          assert.match(r.stopped.reason, /no visible interactive element.*screenshot box/);
          assert.equal(await ops.evaluate(conn, id, 'document.body.dataset.containerHovered || null'), null);
          assert.equal(await ops.evaluate(conn, id, 'document.querySelector("[data-bc-pin]")'), null);
        }
      } finally {
        await ops.closeTab(conn, id);
      }
    });
  }
}

t('vision details stay inside the run in text and JSON traces', async () => {
  const id = await open();
  try {
    const box = await boxAt(id);
    const r = await run(id, ['hover "the magnifying glass"'], scripted(box));
    assert.equal(r.done, true, JSON.stringify(r.stopped));
    const runs = trace.read(id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].steps.length, 1);
    assert.deepEqual(runs[0].steps[0].vision, r.steps[0].vision);
    const cli = (...args) => execFileSync(process.execPath, [fileURLToPath(new URL('../bin/browserctrl.mjs', import.meta.url)), 'trace', id, ...args], { env: process.env, encoding: 'utf8' });
    const text = cli();
    assert.match(text, /vision: p=0.96, box confidence=0.94/);
    assert.doesNotMatch(text, /run undefined|incomplete/);
    assert.equal((text.match(/  run /g) || []).length, 1);
    const json = JSON.parse(cli('--json'));
    assert.equal(json.length, 1);
    assert.deepEqual(json[0].steps[0].vision.box, box);
    assert.equal(json[0].steps[0].vision.p, 0.96);
    assert.equal(json[0].steps[0].vision.confidence, 0.94);
  } finally {
    await ops.closeTab(conn, id);
  }
});
