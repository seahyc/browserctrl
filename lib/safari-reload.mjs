import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {safariCall} from './safari.mjs';

export async function safariReload(tab, {waitUntil = 'load', timeoutMs = 30000, call = safariCall} = {}) {
  if (!['load','domcontentloaded','networkidle','none'].includes(waitUntil)) throw new Error('Unsupported reload wait mode');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new Error('Reload timeout must be greater than 0 and at most 120000ms');
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) throw new Error('Safari reload timed out; it was not replayed. Inspect the tab before continuing.');
    return ms;
  };
  const marker = `__browserctrl_reload_${randomUUID().replaceAll('-','')}`;
  const started = await call('evaluate_javascript', {expression: `globalThis[${JSON.stringify(marker)}] = true; setTimeout(() => location.reload(), 0); return {reloading: true};`}, {tab, timeoutMs: remaining(), activityMethod: 'Page.reload'});
  remaining();
  if (started.isError) throw new Error('Safari reload outcome is uncertain; it was not replayed.');
  if (waitUntil === 'none') return {reloaded: true, waited: 'none'};
  let count = -1, stableSince = performance.now();
  while (true) {
    const result = await call('evaluate_javascript', {expression: `return {oldDocument: !!globalThis[${JSON.stringify(marker)}], state: document.readyState, url: location.href, title: document.title, focused: document.hasFocus(), resources: performance.getEntriesByType('resource').length};`}, {tab, timeoutMs: remaining()});
    remaining();
    if (!result.isError) {
      const observation = JSON.parse(result.content.find(c => c.type === 'text').text);
      const ready = !observation.oldDocument && (observation.state === 'complete' || (waitUntil === 'domcontentloaded' && observation.state === 'interactive'));
      if (observation.oldDocument) {count = -1; stableSince = performance.now();}
      if (observation.resources !== count) {count = observation.resources; stableSince = performance.now();}
      if (ready && (waitUntil !== 'networkidle' || performance.now() - stableSince >= 500)) return {...observation, reloaded: true, waited: waitUntil};
    }
    await delay(Math.min(100, remaining()));
  }
}
