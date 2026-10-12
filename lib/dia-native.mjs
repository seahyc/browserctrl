// Compatibility exports. Native transport belongs to the platform adapter;
// planning and grouping belong to the browser-independent core.
import {getNativeTabAdapter} from './adapters/index.mjs';
export {planNativeGroup, groupNativeTabs} from './tab-control.mjs';
export const listNativeTabs = options => getNativeTabAdapter('dia', options).listTabs();
export const focusNativeTab = (id, options) => getNativeTabAdapter('dia', options).focusTab(id);
