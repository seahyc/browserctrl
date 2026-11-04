// Late clicks, part b of 2 (shared rig: test/late-input-rig.mjs).
import assert from 'node:assert/strict';
import { t, run, state, why, BUSY, LATE, secs, INPUT, ops, conn } from './late-input-rig.mjs';

t('a late click that never takes still stops, saying how long it waited', async () => {
  const { id, r } = await run(`busy=${BUSY}&on=down&never=1`, 'click "Include breakfast"');
  try {
    assert.equal(r.done, false);
    assert.match(r.stopped.reason, new RegExp(`still unchecked after waiting ${secs(INPUT.LATE_WAIT)} s for a click the page took late; the click did not take`));
    assert.equal(await state(id), '');
  } finally { await ops.closeTab(conn, id); }
});

t('a section a late click never opens still stops, saying how long it waited', async () => {
  const { id, r } = await run(`busy=${BUSY}&on=down&never=1`, 'click "More options"');
  try {
    assert.equal(r.done, false);
    assert.match(r.stopped.reason, new RegExp(`did not open: .* after waiting ${secs(INPUT.LATE_WAIT)} s for a click the page took late`));
  } finally { await ops.closeTab(conn, id); }
});

t('a section whose click was acknowledged late opens 2.5 s later and counts as opened', async () => {
  const { id, r } = await run(`busy=${BUSY}&late=${LATE}&on=down`, 'click "More options"');
  try {
    assert.equal(r.done, true, why(r));
    assert.equal(r.steps[0].expanded, true, why(r));
    assert.match(r.steps[0].how, /acknowledged the click late/);
    assert.equal(await state(id), 'more open');
  } finally { await ops.closeTab(conn, id); }
});
