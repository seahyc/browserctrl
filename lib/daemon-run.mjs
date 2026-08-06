#!/usr/bin/env node
// Entry point for the detached daemon process: `node lib/daemon-run.mjs <port>`.
import { runDaemon } from './daemon.mjs';

const port = parseInt(process.argv[2], 10);
if (!port) {
  process.stderr.write('usage: daemon-run.mjs <port>\n');
  process.exit(2);
}
runDaemon(port).catch(err => {
  process.stderr.write(`daemon failed: ${err.message}\n`);
  process.exit(1);
});
