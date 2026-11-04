// Verify recorder teardown before releasing the row that blocks protected input.
// All calls are made while the daemon holds its recording-transition barrier.
import fs from 'node:fs';
import path from 'node:path';
import * as world from './world.mjs';

export async function stopManagedRecording({ targetId, row, send, patch, remove, finish, reason, isTainted = () => false, waitMs = 5000 }) {
  if (isTainted(targetId)) throw Error('recording_target_tainted');
  if (!row?.managed || row.teardownUnverified || row.startFailed || !row.scriptId || typeof row.recordingId !== 'string' || !row.recordingId) throw Error('recording_teardown_unverified');
  const before = await send('Page.getFrameTree', {});
  const frame = before?.frameTree?.frame;
  if (!frame?.id || !frame.loaderId) throw Error('recording_teardown_unverified');
  const prior = row.teardown;
  if (prior && (prior.frameId !== frame.id || prior.loaderId !== frame.loaderId || prior.stopped !== true)) throw Error('recording_teardown_unverified');
  if (!prior) {
    await send('Page.removeScriptToEvaluateOnNewDocument', {identifier: row.scriptId});
    const stopped = await world.evaluateInWorld(send, `rec-stop:${targetId}`, `(() => {
      if (!window.__bcRec || typeof window.__bcRec.stop !== 'function') return false;
      window.__bcRec.stop();
      return !window.__bcRec;
    })()`);
    if (stopped !== true) throw Error('recording_teardown_unverified');
    if (!patch(targetId, row.recordingId, {teardown: {frameId: frame.id, loaderId: frame.loaderId, stopped: true}})) throw Error('recording_changed');
  }
  // The page binding is asynchronous; retain the blocking row until its final
  // event batch has been durably received, before compressing or removing it.
  if (!prior?.drained) {
    const deadline = Date.now() + waitMs;
    while (!fs.existsSync(path.join(row.dir, 'rrweb.end'))) {
      if (Date.now() >= deadline) throw Error('recording_drain_unverified');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const after = await send('Page.getFrameTree', {});
  if (after?.frameTree?.frame?.id !== frame.id ||
      after?.frameTree?.frame?.loaderId !== frame.loaderId) throw Error('recording_teardown_unverified');
  // Persist acknowledgement before finish consumes rrweb.end, so a failed
  // finalization can retry without waiting for an event that cannot recur.
  if (!prior?.drained && !patch(targetId, row.recordingId, {teardown: {
    frameId: frame.id, loaderId: frame.loaderId, stopped: true, drained: true,
  }})) throw Error('recording_changed');
  // Keep the row as a directory reservation until finalization succeeds.
  const result = finish(row.dir, {sealed: true});
  const metaPath = path.join(row.dir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  fs.writeFileSync(metaPath, JSON.stringify({...meta, stopReason: reason}, null, 1));
  if (!remove(targetId, row.recordingId)) throw Error('recording_changed');
  return result;
}


// The exact page target is gone, so its document and every attached recorder hook
// are gone too. The last page batch may be incomplete; preserve what arrived.
export async function recoverClosedRecording({targetId, row, absent, remove, finish}) {
  if (!row?.managed || typeof row.recordingId !== 'string' || !row.recordingId) throw Error('recording_teardown_unverified');
  if (!(await absent(targetId))) throw Error('recording_target_still_present');
  if (row.startPhase === 'reserved') return recoverUnusedRecording({targetId, row, remove});
  const result = finish(row.dir, {sealed: true});
  const metaPath = path.join(row.dir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  fs.writeFileSync(metaPath, JSON.stringify({...meta, stopReason: 'target_closed', finalBatch: 'unverified'}, null, 1));
  if (!remove(targetId, row.recordingId)) throw Error('recording_changed');
  return {...result, finalBatch: 'unverified'};
}


// A reserved-only start has not issued any browser recorder command.
export function recoverUnusedRecording({targetId, row, remove}) {
  if (!row?.managed || row.startPhase !== 'reserved' || row.scriptId ||
      typeof row.recordingId !== 'string' || !row.recordingId) throw Error('recording_teardown_unverified');
  // Setup may have failed before touching this directory. Preserve any older
  // artifacts rather than treating them as this never-installed recording.
  if (!remove(targetId, row.recordingId)) throw Error('recording_changed');
  return {recording: row.dir, finalBatch: 'not_started'};
}
