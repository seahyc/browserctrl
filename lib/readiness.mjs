import { setTimeout as delay } from 'node:timers/promises';

// Observe the page without selecting it, changing focus, or navigating it.
export async function waitForBackgroundReady(conn, targetId, {
  waitUntil = 'load', timeoutMs = 15000, selector, text, url,
} = {}) {
  if (!['load', 'domcontentloaded'].includes(waitUntil)) {
    throw new Error('waitUntil must be load or domcontentloaded');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
    throw new Error('timeoutMs must be greater than 0 and at most 120000');
  }
  for (const [name, value] of Object.entries({ selector, text, url })) {
    if (value !== undefined && typeof value !== 'string') throw new Error(`${name} must be a string`);
  }
  const expression = `(() => {
    const options = ${JSON.stringify({ waitUntil, selector, text, url })};
    const loaded = options.waitUntil === 'load'
      ? document.readyState === 'complete'
      : ['interactive', 'complete'].includes(document.readyState);
    let visible = true;
    if (options.selector !== undefined) {
      const element = document.querySelector(options.selector);
      if (!element) visible = false;
      else {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        visible = rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && style.visibility !== 'collapse';
      }
    }
    return {
      ready: loaded && visible
        && (options.text === undefined || (document.body?.innerText || '').includes(options.text))
        && (options.url === undefined || location.href.includes(options.url)),
      url: location.href, title: document.title, focused: document.hasFocus()
    };
  })()`;
  const deadline = performance.now() + timeoutMs;
  const timeoutError = () => new Error(`Background readiness timed out after ${timeoutMs}ms`);
  while (true) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw timeoutError();
    let timer;
    let response;
    try {
      response = await Promise.race([
        conn.send(targetId, 'Runtime.evaluate', { expression, returnByValue: true },
          Math.max(1, Math.ceil(remaining)), { light: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), remaining); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (response?.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'JS exception');
    }
    if (performance.now() >= deadline) throw timeoutError();
    const observation = response?.result?.value;
    if (!observation || typeof observation.ready !== 'boolean') throw new Error('Page readiness observation was unavailable');
    if (observation.ready) return { ...observation, ready: true, waitUntil };
    const pause = deadline - performance.now();
    if (pause <= 0) throw timeoutError();
    await delay(Math.min(100, pause));
  }
}
