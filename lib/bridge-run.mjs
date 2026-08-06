#!/usr/bin/env node
// Entry point for the detached bridge process: `node lib/bridge-run.mjs [port]`.
import { start, BRIDGE_PORT } from './bridge.mjs';

const port = parseInt(process.argv[2], 10) || BRIDGE_PORT;
start(port).catch(err => {
  process.stderr.write(`bridge failed: ${err.message}\n`);
  process.exit(1);
});
