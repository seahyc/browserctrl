// Dia owns a native window model above Chromium. Disposing its context while
// that window is live can race replacement-tab creation and terminate Dia.
import {closeDiaPrivateWindow} from './adapters/dia-macos.mjs';
export async function disposeDiaContext(conn, browserContextId, {run} = {}) {
  const {targetInfos} = await conn.browser('Target.getTargets');
  const pages = targetInfos.filter(t => t.browserContextId === browserContextId && t.type === 'page');
  if (pages.length !== 1 || !pages[0].url) {
    throw new Error('Dia private context has no unique live tab. Close its private window normally; context disposal was not attempted.');
  }
  if (targetInfos.some(t => t.type === 'page' && t.browserContextId !== browserContextId && t.url === pages[0].url)) {
    throw new Error('Dia private tab URL is also open in another context. Native window cleanup was not attempted.');
  }
  // Pass the URL as an argument, never interpolate page data into AppleScript.
  // Ambiguous matches and windows containing other tabs are refused.
  await closeDiaPrivateWindow(pages[0].url, {run});
  const deadline = Date.now() + 5000;
  while (true) {
    const {targetInfos: current} = await conn.browser('Target.getTargets');
    if (!current.some(t => t.browserContextId === browserContextId && t.type === 'page')) break;
    if (Date.now() >= deadline) throw new Error('Dia private window did not finish closing; context disposal was not attempted.');
    await new Promise(resolve => setTimeout(resolve,100));
  }
  await conn.browser('Target.disposeBrowserContext', {browserContextId});
}
