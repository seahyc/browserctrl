// macOS adapter for Dia's supported scripting dictionary.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute = promisify(execFile);
const LIST = `function run(argv) {
  const d=Application("Dia"), retry=argv[0]==="retry";
  let needsRetry=false;
  const windows=d.windows().map(w=>{
    const tabs=w.tabs().map(t=>{
      const p=t.properties();
      if(!p || typeof p.id!=="string" || !p.id || !("title" in p) || !("url" in p))
        throw Error("Incomplete Dia native tab properties");
      return {id:p.id,title:p.title,url:p.url};
    });
    let activeTabId=null;
    if(tabs.length) {
      try { activeTabId=w.activeTab().id(); }
      catch(e) {
        if(!String(e).includes("-1728")) throw e;
        if(!retry) needsRetry=true;
      }
    }
    return {id:w.id(),activeTabId,tabs};
  });
  return JSON.stringify({windows,needsRetry});
}`;
const FOCUS = `function run(argv) { const d=Application("Dia"); const matches=[]; for(const w of d.windows()) for(const t of w.tabs()) if(t.id()===argv[0]) matches.push(t); if(matches.length!==1) throw Error("Native tab ID is missing or ambiguous"); d.focus(matches[0]); return argv[0]; }`;
async function listTabs({run=execute,platform=process.platform}={}) {
  if(platform!=="darwin") throw Error("Dia native tabs require macOS");
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const args=["-l","JavaScript","-e",LIST];
      if(attempt) args.push("retry");
      const {stdout}=await run("osascript",args,{timeout:30000,maxBuffer:4*1024*1024});
      const result=JSON.parse(stdout);
      if(result.needsRetry && !attempt) continue;
      return result.windows;
    } catch(error) {
      if(attempt || !String(error?.message ?? error).includes("-1728")) throw error;
    }
  }
  throw Error("Dia native inventory changed during both bounded reads");
}
async function focusTab(id,{run=execute,platform=process.platform}={}) {
  if(platform!=="darwin") throw Error("Dia native tabs require macOS");
  if(typeof id!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw Error("An exact native tab UUID is required");
  const {stdout}=await run("osascript",["-l","JavaScript","-e",FOCUS,id],{timeout:10000});
  return {focused:stdout.trim(),native:true};
}

export function createDiaMacAdapter(options = {}) {
  return {
    browser: 'dia',
    platform: 'darwin',
    capabilities: { inventory: true, backgroundInventory: true, focus: true, backgroundMaterialize: false },
    listTabs: () => listTabs(options),
    focusTab: id => focusTab(id, options),
  };
}

const CLOSE_WINDOW = `on run argv
set wantedURL to item 1 of argv
set matches to {}
tell application "Dia"
 repeat with w in windows
  if (count of tabs of w) is 1 then
   if URL of tab 1 of w is wantedURL then set end of matches to id of w
  end if
 end repeat
 if (count of matches) is not 1 then error "Cannot uniquely identify the owned single-tab private window"
 set wid to item 1 of matches
 close window id wid
 return wid
end tell
end run`;
export async function closeDiaPrivateWindow(url, {run = execute} = {}) {
  await run('osascript', ['-e', CLOSE_WINDOW, url], {timeout:10000});
}
