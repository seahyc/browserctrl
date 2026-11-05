// A node --test reporter (test/run.mjs adds it): each test file's time, slowest first, so a file
// that holds a parallel run up (a slow hook, a stall) is named. Also when the runner saw it end,
// which shows a file whose process lingered after its tests.
export default async function* fileTimes(source) {
  const started = Date.now();
  const files = [];
  for await (const event of source) {
    if (event.type !== 'test:summary' || !event.data.file) continue;
    files.push({ file: event.data.file.split('/').pop(), s: event.data.duration_ms / 1000, at: (Date.now() - started) / 1000 });
  }
  files.sort((a, b) => b.s - a.s);
  yield `# slowest files (own time; when the run saw each end):\n`;
  for (const f of files.slice(0, 8)) yield `#   ${f.s.toFixed(1).padStart(6)} s  ${f.file}  (ended at ${f.at.toFixed(0)} s)\n`;
  const last = files.reduce((m, f) => (f.at > m.at ? f : m), { at: 0 });
  if (last.file) yield `# last to end: ${last.file} at ${last.at.toFixed(0)} s\n`;
}
