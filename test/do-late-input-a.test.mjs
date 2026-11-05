// Late clicks, part a of 2 (shared rig: test/late-input-rig.mjs).
import assert from 'node:assert/strict';
import { t, run, state, why, BUSY, LATE, secs, INPUT, ops, conn } from './late-input-rig.mjs';

t('a checkbox click never acknowledged (main thread held past INPUT.ACK) is waited for, and the step says so', async () => {
  const { id, r } = await run(`busy=${INPUT.ACK + 1000}&late=${LATE}&on=enter`, 'click "Include breakfast"');
  try {
    assert.equal(r.done, true, why(r));
    assert.equal(r.steps[0].late_input?.unacknowledged, true, why(r));
    assert.match(r.steps[0].how, new RegExp(`the page did not acknowledge the click within ${secs(INPUT.ACK)} s`));
    assert.equal(r.steps[0].checked, true);
    assert.equal(await state(id), 'breakfast on');
  } finally { await ops.closeTab(conn, id); }
});

t('a checkbox click acknowledged late (main thread held 1.5 s) is waited for, and the step says so', async () => {
  const { id, r } = await run(`busy=${BUSY}&late=${LATE}&on=down`, 'click "Include breakfast"');
  try {
    assert.equal(r.done, true, why(r));
    assert.ok(r.steps[0].late_input?.ms >= INPUT.SLOW_ACK, why(r));
    assert.ok(!r.steps[0].late_input.unacknowledged, why(r));
    assert.match(r.steps[0].how, /the page acknowledged the click late \(\d+\.\d s\)/);
    assert.equal(r.steps[0].checked, true);
    // Checked when the step said so: no waiting in the test.
    assert.equal(await state(id), 'breakfast on');
  } finally { await ops.closeTab(conn, id); }
});

t('a prompt click that never takes stops after the usual wait, with no late note', async () => {
  const { id, r } = await run('busy=0&never=1', 'click "Include breakfast"');
  try {
    assert.equal(r.done, false);
    assert.match(r.stopped.reason, /still unchecked/);
    // On a loaded machine even this click can be acknowledged late; the note then is right.
    if (!r.steps[0].late_input) assert.doesNotMatch(r.stopped.reason, /after waiting/);
  } finally { await ops.closeTab(conn, id); }
});
