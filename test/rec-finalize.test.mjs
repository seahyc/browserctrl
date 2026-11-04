import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {test} from 'node:test';
import {finish} from '../lib/rec.mjs';

test('sealed finalization retries a rename-before-unlink failure without duplicating events', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-rec-finalize-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const raw = path.join(dir, 'rrweb.ndjson'), br = `${raw}.br`;
  const events = '{"event":"first"}\n{"event":"last"}\n';
  fs.writeFileSync(raw, events);
  fs.writeFileSync(br, zlib.brotliCompressSync(Buffer.from(events)));
  finish(dir, {sealed: true});
  assert.equal(zlib.brotliDecompressSync(fs.readFileSync(br)).toString(), events);
  assert.equal(fs.existsSync(raw), false);
  finish(dir, {sealed: true});
  assert.equal(zlib.brotliDecompressSync(fs.readFileSync(br)).toString(), events);
});

test('failed atomic publication preserves the complete raw stream for retry', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-rec-finalize-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const raw = path.join(dir, 'rrweb.ndjson'), br = `${raw}.br`;
  const events = '{"event":"retained"}\n';
  fs.writeFileSync(raw, events);
  fs.mkdirSync(br);
  assert.throws(() => finish(dir, {sealed: true}));
  assert.equal(fs.readFileSync(raw, 'utf8'), events);
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  fs.rmdirSync(br);
  finish(dir, {sealed: true});
  assert.equal(zlib.brotliDecompressSync(fs.readFileSync(br)).toString(), events);
});
