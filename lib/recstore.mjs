// Where recordings live on disk. Shared by the recorder (which owns the
// lifecycle) and the daemon (which receives events over the CDP binding),
// so neither has to import the other.
import fs from 'fs';
import path from 'path';
import { CDP_HOME } from './state.mjs';

export const ROOT = path.join(CDP_HOME, 'recordings');
export const dir = id => path.join(ROOT, id);
export const metaPath = id => path.join(dir(id), 'meta.json');
export const eventsPath = id => path.join(dir(id), 'events.jsonl');
export const windowsPath = id => path.join(dir(id), 'windows.jsonl');
export const marksPath = id => path.join(dir(id), 'marks.jsonl');
export const videoPath = id => path.join(dir(id), 'screen.mp4');
// (video time, wall time) samples straight from ffmpeg: the video's real clock.
export const clockPath = id => path.join(dir(id), 'video-clock.jsonl');

export function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

export function appendEvents(id, rows) {
  if (!rows?.length || !fs.existsSync(dir(id))) return 0;
  fs.appendFileSync(eventsPath(id), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return rows.length;
}
