// Before a test run: kill headless test Chromes whose test process is gone. Only browsers
// on a throwaway cdp-test-profile-* profile and reparented to init (ppid 1) are touched,
// so a suite another session is running right now keeps its browser.
import { execFileSync } from 'child_process';
import fs from 'fs';

if (process.platform !== 'win32') {
  let ps = '';
  try { ps = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }); } catch {}
  for (const line of ps.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || m[2] !== '1' || !/--headless/.test(m[3]) || /--type=/.test(m[3])) continue;
    const dir = m[3].match(/--user-data-dir=(\S*\/cdp-test-profile-[A-Za-z0-9]+)/)?.[1];
    if (!dir) continue;
    try { process.kill(-Number(m[1]), 'SIGKILL'); } catch { try { process.kill(Number(m[1]), 'SIGKILL'); } catch {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    console.log(`swept orphaned test Chrome ${m[1]} (${dir})`);
  }
}
