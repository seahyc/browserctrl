import {createDiaMacAdapter} from './dia-macos.mjs';

export function getNativeTabAdapter(browser, {platform = process.platform, ...options} = {}) {
  if (browser === 'dia' && platform === 'darwin') return createDiaMacAdapter({platform, ...options});
  throw new Error(`No native tab adapter for ${browser} on ${platform}. Use extension tab APIs for background control.`);
}
