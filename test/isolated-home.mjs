// Tests that delete or rewrite runtime files (vault journals and markers, daemon sockets)
// must never touch a real installation's folders. Import this first in such a file: it stops
// the run unless test/helpers.mjs gave the process its own temporary BROWSERCTRL_HOME.
import os from 'node:os';
import path from 'node:path';

const home = process.env.BROWSERCTRL_HOME ? path.resolve(process.env.BROWSERCTRL_HOME) : '';
const temp = [os.tmpdir(), '/tmp', '/private/tmp'].map(d => path.resolve(d));
if (!home || !path.basename(home).startsWith('bc-test-') || !temp.includes(path.dirname(home))) {
  throw new Error('This test rewrites runtime files: run it with `node --import ./test/helpers.mjs --test …` (npm test does) so it gets a temporary BROWSERCTRL_HOME');
}
