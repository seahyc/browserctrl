import fs from 'node:fs';
if (process.argv[1]?.endsWith('/daemon-run.mjs') && process.env.BROWSERCTRL_TEST_CLOCK) {
  const clock = process.env.BROWSERCTRL_TEST_CLOCK;
  const realNow = Date.now;
  Date.now = () => { try { return Number(fs.readFileSync(clock, 'utf8')) || realNow(); } catch { return realNow(); } };
  const realInterval = globalThis.setInterval;
  let reap;
  globalThis.setInterval = (fn, delay, ...args) => {
    if (String(fn).includes('rec.idleRecordings')) reap = () => fn(...args);
    return realInterval(fn, delay, ...args);
  };
  process.on('SIGUSR2', () => { if (reap) Promise.resolve(reap()).catch(() => {}); });
}
