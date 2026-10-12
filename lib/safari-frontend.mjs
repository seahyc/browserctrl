// Translate the small shared command set to Apple's native MCP tools.
// Safari keeps its own node UIDs; Chromium snapshot refs are never reused here.
export function safariCLI(cmd, positional, flags) {
  const tab = positional[1];
  const node = flags.ref;
  const target = node ? { node: String(node) } : flags.selector ? null :
    flags.x !== undefined && flags.y !== undefined ? { point: { x: Number(flags.x), y: Number(flags.y) } } : {};
  const interact = (type, extra = {}) => {
    if (flags.selector) throw new Error('Safari interactions use node UIDs from read, not CSS selector targets. Use safari call for Apple’s full tool interface.');
    if (node && /^ref_/.test(node)) throw new Error('Safari uses node UIDs from its own read result, not Chromium ref_N values.');
    return { name: 'page_interactions', args: { interactions: [{ type, purpose: `browserctrl ${cmd}`, ...target, ...extra }] }, tab };
  };
  switch (cmd) {
    case 'tabs': return { name: 'list_tabs', args: {} };
    case 'open':
      if (flags.anonymous) throw new Error('Safari uses its own automation session; Chromium anonymous contexts are unsupported.');
      return { name: 'create_tab', args: { ...(tab ? { url: tab } : {}) } };
    case 'close': return { name: 'close_tab', args: { handle: tab }, tab };
    case 'wake': return { name: 'switch_tab', args: { handle: tab }, tab };
    case 'nav': return { name: 'navigate_to_url', args: { url: positional[2], tab_uuid: tab }, tab };
    case 'read': case 'text': case 'html': return { name: 'get_page_content', args: { format: cmd === 'text' ? 'plainText' : cmd === 'html' ? 'html' : 'textTree', region: 'entire_page' }, tab };
    case 'eval': return { name: 'evaluate_javascript', args: { expression: `return (${positional.slice(2).join(' ')});` }, tab };
    case 'shot':
      if (flags.ref || flags.selector) throw new Error('Safari currently supports viewport or full-page screenshots, not element crops.');
      return { name: 'screenshot', args: { full_page: Boolean(flags.full), ...(positional[2] ? { savePath: positional[2] } : {}) }, tab };
    case 'console': return { name: 'browser_console_messages', args: { clear: Boolean(flags.clear), limit: Number(flags.limit || 50), tab_handle: tab }, tab };
    case 'network': return { name: 'list_network_requests', args: { tab_handle: tab, ...(flags.failed ? { filter: { status_min: 400 } } : {}) }, tab };
    case 'click': return interact('click');
    case 'hover': return interact('hover');
    case 'type': return interact('type', { value: positional.slice(2).join(' ') });
    case 'fill': return interact('type', { value: String(flags.value ?? ''), replaceAll: true });
    case 'key': return interact('keyPress', { value: positional[2] });
    case 'select': return interact('selectMenuItem', { text: flags.label ?? flags.value });
    case 'scroll': return interact('scroll', { scrollDelta: { x: 0, y: Number(flags.dy || 400) } });
    default: throw new Error(`Safari does not support the shared command "${cmd}". Use browserctrl safari tools --browser safari to see Apple’s supported operations. Tab groups, dormant Dia tabs, raw CDP, uploads and recording are Chromium-only.`);
  }
}

export function safariMCP(name, args) {
  const positional = [null, args.tab];
  const flags = { ...args, ref: args.ref, full: args.full };
  const commands = { browser_tabs: 'tabs', browser_open: 'open', browser_close: 'close', browser_read: 'read', browser_navigate: 'nav', browser_eval: 'eval', browser_screenshot: 'shot', browser_diagnostics: args.failedOnly ? 'network' : 'console' };
  if (name === 'browser_open') positional[1] = args.url;
  if (name === 'browser_navigate') positional[2] = args.url;
  if (name === 'browser_eval') positional[2] = args.js;
  if (name === 'browser_screenshot') positional[2] = args.path;
  if (name === 'browser_act') {
    if (args.steps?.length) throw new Error('For Safari batches use browser_safari tool=page_interactions with Apple interaction objects.');
    const cmd = { click: 'click', hover: 'hover', type: 'type', fill: 'fill', key: 'key', select: 'select', scroll: 'scroll' }[args.action];
    if (!cmd) throw new Error(`Safari action ${args.action} is unsupported. Use browser_safari for Apple’s full interface.`);
    if (cmd === 'type') positional[2] = args.text;
    if (cmd === 'key') positional[2] = args.key;
    flags.dy = args.dy;
    return safariCLI(cmd, positional, flags);
  }
  if (!commands[name]) throw new Error(`Safari does not support ${name}. Use browser_safari for Apple’s supported operations.`);
  return safariCLI(commands[name], positional, flags);
}
