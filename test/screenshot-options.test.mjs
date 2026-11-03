import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {screenshot, parseViewport, parseScale, parseMasks} from '../lib/ops.mjs';

test('shot option parsers accept the documented forms and reject the rest', () => {
  assert.deepEqual(parseViewport('1440x900'), {width: 1440, height: 900});
  assert.deepEqual(parseViewport('390 × 844'), {width: 390, height: 844});
  assert.equal(parseViewport(undefined), null);
  assert.throws(() => parseViewport('1440'), /WIDTHxHEIGHT/);
  assert.throws(() => parseViewport('50x50'), /out of range/);
  assert.equal(parseScale('2'), 2);
  assert.equal(parseScale(undefined), null);
  assert.throws(() => parseScale('9'), /between 0.5 and 4/);
  assert.deepEqual(parseMasks('.name; img.avatar, .photo ;'), ['.name', 'img.avatar, .photo']);
  assert.deepEqual(parseMasks(['.a', '.b;.c']), ['.a', '.b', '.c']);
  assert.deepEqual(parseMasks(undefined), []);
});

function fakeConn({counts = {'.name': 2}, captureFails = false} = {}) {
  const calls = [];
  const conn = {async send(target, method, params) {
    calls.push({method, params});
    if (method === 'Page.captureScreenshot') {
      if (captureFails) throw new Error('capture failed');
      return {data: Buffer.from('owned test image').toString('base64')};
    }
    if (method === 'Runtime.evaluate') {
      const e = params.expression;
      if (e.includes('data-browserctrl-mask') && e.includes('counts')) return {result: {value: counts}};
      return {result: {value: e.includes('getBoundingClientRect') ? {x: 10, y: 20, width: 100, height: 50} : 1}};
    }
    return {};
  }};
  return {conn, calls};
}

for (const fails of [false, true]) test(`viewport, scale and masks are applied before and removed after a capture that ${fails ? 'fails' : 'succeeds'}`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-shot-opts-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const {conn, calls} = fakeConn({captureFails: fails});
  const pending = screenshot(conn, 'owned-tab', {path: path.join(dir, 's.png'), viewport: {width: 1440, height: 900}, scale: 2, mask: ['.name']});
  if (fails) await assert.rejects(pending, /capture failed/);
  else assert.deepEqual((await pending).masked, {'.name': 2});
  const names = calls.map(c => c.method === 'Runtime.evaluate'
    ? (c.params.expression.includes('removeAttribute') ? 'unmask' : c.params.expression.includes('counts') ? 'mask' : 'eval') : c.method);
  const at = n => names.indexOf(n);
  assert.deepEqual(calls.find(c => c.method === 'Emulation.setDeviceMetricsOverride').params, {width: 1440, height: 900, deviceScaleFactor: 2, mobile: false});
  assert.ok(at('Emulation.setDeviceMetricsOverride') < at('mask') && at('mask') < at('Page.captureScreenshot'), names.join(','));
  assert.ok(at('unmask') > at('Page.captureScreenshot') && at('Emulation.clearDeviceMetricsOverride') > at('Page.captureScreenshot'), names.join(','));
});

test('--require-mask refuses to capture when a mask matches nothing, and still cleans up', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-shot-req-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const {conn, calls} = fakeConn({counts: {'.name': 3, '.missing': 0}});
  const file = path.join(dir, 's.png');
  await assert.rejects(screenshot(conn, 'owned-tab', {path: file, mask: ['.name', '.missing'], requireMask: true}), /matched nothing for \.missing; nothing was captured/);
  assert.equal(fs.existsSync(file), false);
  assert.ok(!calls.some(c => c.method === 'Page.captureScreenshot'));
  assert.ok(calls.some(c => c.method === 'Runtime.evaluate' && c.params.expression.includes('removeAttribute')));
});

test('element crops add --pad around the element', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-shot-pad-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const {conn, calls} = fakeConn();
  await screenshot(conn, 'owned-tab', {path: path.join(dir, 's.png'), selector: '.modal', pad: 16});
  const cap = calls.find(c => c.method === 'Page.captureScreenshot').params;
  assert.deepEqual(cap.clip, {x: 0, y: 4, width: 126, height: 82, scale: 1});
});
