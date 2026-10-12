// Opt-in lifecycle diagnostics. Never persist page contents, URLs, expressions,
// headers, cookies, or protocol error messages. A full log stops at 10 MiB.
import fs from 'node:fs';
const LIMIT = 10 * 1024 * 1024;
const FIELDS = ['targetId', 'browserContextId', 'sessionId', 'openerId', 'type',
  'attached', 'background', 'disposeOnDetach', 'flatten', 'success'];
export function protocolSummary(value = {}) {
  const out = {};
  for (const key of FIELDS) {
    const v = value?.[key];
    if (typeof v === 'boolean' || (typeof v === 'string' && v.length <= 128)) out[key] = v;
  }
  if (value?.targetInfo) out.targetInfo = protocolSummary(value.targetInfo);
  return out;
}
export function createProtocolTrace(file, port) {
  if (!file) return () => {};
  let size;
  try { size = fs.statSync(file).size; } catch { size = 0; }
  return (event, { id, method, sessionId, params, result, errorCode } = {}) => {
    try {
      if (size >= LIMIT) return;
      const line = JSON.stringify({time:new Date().toISOString(),pid:process.pid,port,event,
        id,method,sessionId,params:params && protocolSummary(params),
        result:result && protocolSummary(result),errorCode}) + '\n';
      fs.appendFileSync(file,line,{mode:0o600}); size += Buffer.byteLength(line);
    } catch { /* Diagnostic failure must not change browser operations. */ }
  };
}
