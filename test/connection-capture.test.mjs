import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureConnections } from '../lib/connection-capture.mjs';
test('bounded capture records safe observer results and identifies unpooled clients', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-capture-test-'));
 try {
 const result = await captureConnections(9223, {seconds: 0.01, directory, observe: async () => ({available:true,connections:[{pid:123,sharedDaemon:false},{pid:456,sharedDaemon:true}],warnings:[]})});
 assert.deepEqual(result.unpooledClientPids,[123]);
 assert.equal(result.snapshots,1);
 assert.equal(fs.statSync(result.file).mode & 0o777,0o600);
 assert.equal(JSON.parse(fs.readFileSync(result.file,'utf8')).port,9223);
 await assert.rejects(captureConnections(9223,{seconds:300,directory}),/at most 60/);
 } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
