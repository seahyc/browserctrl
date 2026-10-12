// Recheck ownership and pause at execution time, after earlier input finishes.
export async function runQueuedInput(queues, targetId, assertAllowed, action) {
  const previous = queues.get(targetId) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => {
    assertAllowed();
    return action();
  });
  queues.set(targetId, task);
  try { return await task; }
  finally { if (queues.get(targetId) === task) queues.delete(targetId); }
}
