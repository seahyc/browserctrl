import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-video-capability-'));
process.env.BROWSERCTRL_HOME = testHome;
const recorder = await import('../lib/recorder.mjs');
const recstore = await import('../lib/recstore.mjs');
after(() => fs.rmSync(testHome, { recursive: true, force: true }));

test('unsupported operating systems are rejected before probing ffmpeg', () => {
  let probes = 0;
  const result = recorder.videoSupport({
    platform: 'linux',
    probe: () => { probes += 1; return true; },
  });

  assert.deepEqual(result, {
    supported: false,
    reason: 'Screen video capture is available only on macOS.',
  });
  assert.equal(probes, 0);
});

test('macOS without ffmpeg reports a video capability reason', () => {
  const result = recorder.videoSupport({ platform: 'darwin', probe: () => false });

  assert.deepEqual(result, {
    supported: false,
    reason: 'ffmpeg is not installed or cannot be started.',
  });
});

test('macOS with ffmpeg reports video capture support', () => {
  const result = recorder.videoSupport({ platform: 'darwin', probe: () => true });

  assert.deepEqual(result, { supported: true, reason: null });
});

test('arming twice starts one injected capture and disarm stops it', () => {
  let starts = 0;
  let child;
  const startCapture = (_id, _meta, handles) => {
    starts += 1;
    child = {
      exitCode: null,
      killed: false,
      kill() {
        this.killed = true;
        this.exitCode = 0;
      },
    };
    handles.ffmpeg = child;
  };

  const first = recorder.arm({ port: 9999 }, { startCapture });
  const second = recorder.arm({ port: 9999 }, { startCapture });
  assert.equal(starts, 1);
  assert.deepEqual(first, second);
  assert.equal(recorder.disarm().armed, false);
  assert.equal(child.killed, true);
  assert.equal(recorder.disarm().armed, false);
  assert.equal(recorder.prewarmStatus().armed, false);
  assert.equal(fs.existsSync(recstore.dir('_prewarm')), false);
});

test('a synchronous capture startup failure removes prewarm state', () => {
  assert.throws(
    () => recorder.arm({ port: 9999 }, { startCapture: () => { throw new Error('capture failed'); } }),
    /capture failed/,
  );
  assert.equal(recorder.prewarmStatus().armed, false);
  assert.equal(fs.existsSync(recstore.dir('_prewarm')), false);
});
