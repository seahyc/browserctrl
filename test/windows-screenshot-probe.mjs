// Diagnostic preflight for headless screenshot behavior on Windows CI.
// Each case owns its browser process, profile, fixture server, target, and daemon.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../lib/daemon.mjs';
import { release as releaseClaim } from '../lib/claims.mjs';
import * as ops from '../lib/ops.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary } from './helpers.mjs';

const variants = ['default', 'focus', 'viewport', 'activate'];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function deadline(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function browserWindow(conn, targetId) {
  try {
    const { windowId } = await conn.browser('Browser.getWindowForTarget', { targetId }, 1500);
    if (!Number.isInteger(windowId)) return null;
    return await conn.browser('Browser.getWindowBounds', { windowId }, 1500);
  } catch {
    return null;
  }
}

async function runVariant(variant, outputDirectory) {
  const result = { variant, passed: false, bytes: null, metadata: null, error: null };
  let fixture;
  let browser;
  let conn;
  let targetId;

  try {
    fixture = await startFixtureServer();
    const port = await freePort();
    browser = await startHeadlessBrowser(port);
    if (!browser) throw new Error('No supported headless browser binary was found');

    conn = await connect(port);
    const tab = await ops.newTab(conn, fixture.url);
    targetId = tab.targetId;
    await ops.waitForReady(conn, targetId, { waitUntil: 'load', timeoutMs: 10000 });

    if (variant === 'focus') {
      await conn.send(targetId, 'Emulation.setFocusEmulationEnabled', { enabled: true }, 3000);
    } else if (variant === 'viewport') {
      await conn.send(targetId, 'Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false,
      }, 3000);
    } else if (variant === 'activate') {
      await conn.browser('Target.activateTarget', { targetId }, 3000);
      await conn.send(targetId, 'Page.bringToFront', {}, 3000);
    }

    const evaluated = await conn.send(targetId, 'Runtime.evaluate', {
      expression: '({visibility:document.visibilityState,focused:document.hasFocus(),width:innerWidth,height:innerHeight,dpr:devicePixelRatio})',
      returnByValue: true,
    }, 3000);
    result.metadata = {
      ...(evaluated.result?.value || {}),
      browserWindow: await browserWindow(conn, targetId),
    };

    const capture = await deadline(
      conn.send(targetId, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
      }, 3000),
      3000,
      'Page.captureScreenshot',
    );
    const image = Buffer.from(capture.data, 'base64');
    const outputPath = path.join(outputDirectory, `${variant}.png`);
    fs.writeFileSync(outputPath, image);
    result.passed = true;
    result.bytes = image.length;
    result.path = outputPath;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (conn) {
      try { await deadline(conn.stop(), 2500, 'daemon stop'); } catch {}
      try { conn.close(); } catch {}
    }
    if (browser) {
      try { await browser.close(); } catch {}
    }
    if (targetId && browser) {
      try { releaseClaim(browser.port, targetId, { steal: true }); } catch {}
    }
    try { await fixture?.close(); } catch {}
  }

  return result;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log(JSON.stringify({ skipped: true, reason: 'Windows screenshot probe runs only on Windows.' }));
    return;
  }

  const outputDirectory = path.join(
    process.env.RUNNER_TEMP || os.tmpdir(),
    'browserctrl-screenshot-probe',
  );
  fs.mkdirSync(outputDirectory, { recursive: true });

  if (!chromeBinary()) {
    console.log(JSON.stringify({
      diagnosticOnly: true,
      allFailed: true,
      interpretation: 'No screenshot variant ran; this is diagnostic output, not a passing result.',
      results: variants.map(variant => ({
        variant,
        passed: false,
        bytes: null,
        metadata: null,
        error: 'No supported headless browser binary was found',
      })),
    }));
    return;
  }

  const results = [];
  for (const variant of variants) results.push(await runVariant(variant, outputDirectory));
  const report = {
    diagnosticOnly: true,
    allFailed: results.every(result => !result.passed),
    interpretation: results.every(result => !result.passed)
      ? 'No screenshot variant succeeded; this diagnostic result is not a CI pass signal.'
      : 'At least one screenshot variant succeeded; this diagnostic result does not replace the full test suite.',
    results,
  };
  fs.writeFileSync(path.join(outputDirectory, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.log(JSON.stringify({ diagnosticOnly: true, fatal: error instanceof Error ? error.message : String(error) }));
  });
}
