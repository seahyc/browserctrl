// Video export of a recording: plain-words captions, frames on the recording's own clock,
// captions at step times, side by side with a "Done in" badge, and a GIF preview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { plainCaption, captionTrack, renderVideo, endBadge, withTraceResults } from '../lib/video.mjs';
import { chromeBinary } from './helpers.mjs';

const haveTools = chromeBinary() && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('step lines become plain words', () => {
  assert.equal(plainCaption('do: fill "Where" = "Cleveland"'), 'Typing “Cleveland” into Where');
  assert.equal(plainCaption('do: date 2026-10-17'), 'Picking Oct 17, 2026 in the calendar');
  assert.equal(plainCaption('do: click "Lowest Price" => "sorted by price"'), 'Clicking “Lowest Price”');
  assert.equal(plainCaption('do: click! "Add to bag"'), 'Clicking “Add to bag”');
  assert.equal(plainCaption('do: click ref_25'), 'Clicking the item it picked on the page');
  assert.equal(plainCaption('do: select "Age of child" = "6"'), 'Choosing “6” for Age of child');
  assert.equal(plainCaption('do: key Enter'), 'Pressing Enter');
  assert.equal(plainCaption('fill ref_61 = "christenson@gmail.com"'), 'Typing “christenson@gmail.com”');
  assert.equal(plainCaption('nav https://www.apartments.com/condos/houston-tx/'), 'Going to apartments.com');
  assert.equal(plainCaption('read'), 'Reading the page');
  assert.equal(plainCaption('items'), 'Reading the page');
  assert.equal(plainCaption('start recording'), null);
  assert.equal(plainCaption('stop recording'), null);
});

test('captions start while the step runs, end before the next one, and gaps are thinking', () => {
  const t0 = 1_000_000;
  const { captions, thinkingFrom, thinkingTo } = captionTrack([
    { at: t0, action: 'start recording' },
    { at: t0 + 10_000, action: 'do: click "Search"', status: 'SUCCESS' },
    { at: t0 + 11_000, action: 'do: key Enter', status: 'SUCCESS' },
    { at: t0 + 30_000, action: 'read', status: 'FAILED' },
  ], t0, 40_000);
  assert.deepEqual(captions.map(c => [c.from, c.to, c.text]), [
    [8_500, 10_000, 'Clicking “Search”'],
    [10_000, 13_500, 'Pressing Enter'],
    [28_500, 32_500, 'Reading the page (didn’t work)'],
  ]);
  assert.equal(thinkingFrom, 8_500);
  assert.equal(thinkingTo, 30_000);
});

// A 6-second recording: a snapshot at 0, a click step at 2 s that changes the text, a read
// at 4 s. No network: the page is all text.
function fixtureRecording(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-video-rec-'));
  const t0 = 1_800_000_000_000;
  const snapshot = { type: 2, timestamp: t0 + 100, data: { initialOffset: { left: 0, top: 0 }, node: { type: 0, id: 1, childNodes: [
    { type: 2, id: 2, tagName: 'html', attributes: {}, childNodes: [
      { type: 2, id: 3, tagName: 'head', attributes: {}, childNodes: [] },
      { type: 2, id: 4, tagName: 'body', attributes: { style: 'font: 40px sans-serif; padding: 40px' }, childNodes: [
        { type: 3, id: 5, textContent: 'A fixture page before the click' }] }] }] } } };
  const events = [
    { type: 4, timestamp: t0 + 100, data: { href: 'https://example.test/', width: 1280, height: 720 } },
    snapshot,
    { type: 3, timestamp: t0 + 1900, data: { source: 0, texts: [{ id: 5, value: 'The same page after the click' }], attributes: [], removes: [], adds: [] } },
  ];
  fs.writeFileSync(path.join(dir, 'rrweb.ndjson'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const steps = [
    { step: 0, at: t0, action: 'start recording' },
    { step: 1, at: t0 + 2000, action: 'do: click "Search"', status: 'SUCCESS' },
    { step: 2, at: t0 + 4000, action: 'read', status: 'SUCCESS' },
    { step: null, at: t0 + 6000, action: 'stop recording' },
  ];
  fs.writeFileSync(path.join(dir, 'steps.jsonl'), steps.map(s => JSON.stringify(s)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ label, startedAt: t0, endedAt: t0 + 6000 }));
  return dir;
}

const frames = file => parseInt(spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout, 10);

test('a recording renders at its real length with captions at the step times', { skip: !haveTools && 'needs Chrome and ffmpeg' }, async () => {
  const dir = fixtureRecording('Fixture');
  const out = path.join(os.tmpdir(), `bc-video-${process.pid}.mp4`);
  const r = await renderVideo([dir], { out, fps: 5, width: 640, trace: true });
  // 6 s of recording plus the 2 s hold on the last frame, at 5 fps.
  assert.equal(r.recordings[0].frames, 40);
  assert.equal(frames(out), 40);
  assert.ok(Math.abs(r.seconds - 8) < 0.3, `duration ${r.seconds}`);
  const at = ms => r.recordings[0].trace.find(f => f.t >= ms);
  // A step's caption starts up to 1.5 s before it is logged (while it runs): the click
  // logged at 2 s shows from 0.5 s, the read logged at 4 s from 2.5 s.
  assert.equal(at(1000).caption, 'Clicking “Search”');
  assert.equal(at(2200).caption, 'Clicking “Search”');
  assert.equal(at(3000).caption, 'Reading the page');
  assert.equal(at(1000).clock, '0:01');
  assert.equal(at(5000).clock, '0:05');
  // Unchanged frames reuse the last image: far fewer screenshots than frames.
  assert.ok(r.recordings[0].rendered < r.recordings[0].frames / 2, `rendered ${r.recordings[0].rendered}`);
  fs.rmSync(out, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('side by side: the shorter run freezes under a Done badge, and a GIF preview is written', { skip: !haveTools && 'needs Chrome and ffmpeg' }, async () => {
  const a = fixtureRecording('Slow');
  const b = fixtureRecording('Fast');
  const meta = JSON.parse(fs.readFileSync(path.join(b, 'meta.json'), 'utf8'));
  fs.writeFileSync(path.join(b, 'meta.json'), JSON.stringify({ ...meta, endedAt: meta.startedAt + 4100 }));
  fs.writeFileSync(path.join(b, 'steps.jsonl'), fs.readFileSync(path.join(b, 'steps.jsonl'), 'utf8').split('\n').filter(l => l && !l.includes('stop recording')).join('\n') + '\n');
  const out = path.join(os.tmpdir(), `bc-video-sbs-${process.pid}.mp4`);
  const gif = out.replace(/\.mp4$/, '.gif');
  const r = await renderVideo([a, b], { out, gif, gifSpeed: 2, fps: 5, width: 960, labels: ['Without', 'With'], trace: true });
  assert.equal(r.size, '960x314');
  const [slow, fast] = r.recordings;
  assert.equal(slow.frames, fast.frames, 'both panels span the same clock');
  assert.ok(fast.trace.some(f => f.done) && !fast.trace.slice(0, 20).some(f => f.done), 'the faster run shows Done after it ends');
  assert.equal(fast.trace.at(-1).clock, '0:04', 'its clock stops at its own end');
  assert.ok(fs.statSync(gif).size > 0 && fs.statSync(gif).size < 8e6);
  for (const f of [out, gif]) fs.rmSync(f, { force: true });
  for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true });
});

test('extract captions show the question before completion and the value afterward', () => {
  const track = captionTrack([{ at: 3000, action: 'do: extract "latest Python version" as $py', result: 'Python 3.15.0' }], 1000, 4000);
  assert.deepEqual(track.captions.map(c => [c.from, c.to, c.text]), [
    [500, 2000, 'Reading: latest Python version'], [2000, 4500, 'Read “Python 3.15.0”'],
  ]);
  assert.equal(plainCaption('do: answer "All done"'), 'Answer: All done');
  assert.equal(captionTrack([{ at: 3000, action: 'do: answer "${py}"', result: 'Python 3.15.0' }], 1000, 4000).captions[0].text, 'Answer: Python 3.15.0');
});

test('failures display a red stopped reason without inventing missing outcomes', () => {
  const captions = captionTrack([{ at: 3000, action: 'do: extract "version"', status: 'FAILED', result: 'No line clearly answers it' }], 1000, 4000).captions;
  assert.equal(captions.at(-1).text, 'Stopped: No line clearly answers it');
  assert.equal(captions.at(-1).stopped, true);
  assert.equal(captionTrack([{ at: 3000, action: 'do: extract "version"' }], 1000, 4000).captions[0].text, 'Reading: version');
});

test('end badges use the last do outcome, ignoring recording and read bookkeeping', () => {
  assert.deepEqual(endBadge([{ step: 2, action: 'do: extract "version"', status: 'FAILED' }, { action: 'read', status: 'SUCCESS' }, { action: 'stop recording' }], 8284), { stopped: true, text: 'Stopped at step 2 · 0:08' });
  assert.deepEqual(endBadge([{ step: 1, action: 'do: click "retry"', status: 'FAILED' }, { step: 2, action: 'do: click "continue"', status: 'SUCCESS' }], 61000), { stopped: false, text: 'Done in 1:01' });
  assert.equal(endBadge([], 2000).text, 'Done in 0:02');
});

test('recording-local trace outcomes fill missing results within the recorded run', () => {
  const steps = [{ at: 2000, action: 'do: extract "version"' }, { at: 3000, action: 'do: answer "done"', result: 'saved answer' }];
  const results = withTraceResults(steps, [
    { at: 500, do: 'extract "version"', extracted: { value: 'stale' } },
    { at: 2500, do: 'extract "version"', extracted: { value: 'Python 3.15.0' } },
    { at: 3000, do: 'answer "done"', answer: 'trace answer' },
  ], 1000, 4000);
  assert.equal(results[0].result, 'Python 3.15.0');
  assert.equal(results[1].result, 'saved answer');
  assert.equal(withTraceResults(steps, [], 1000, 4000)[0].result, undefined);
});

test('rapid extract then answer retains the read outcome in the answer caption', () => {
  const { captions } = captionTrack([
    { at: 2000, action: 'do: extract "forks" as number as $forks', result: '40300 from “40.3k forks”' },
    { at: 2053, action: 'do: answer "${forks}"', result: '40300 forks' },
  ], 0, 2200);
  assert.equal(captions.at(-1).text, 'Read 40300 from “40.3k forks” · Answer: 40300 forks');
  assert.ok(captions.at(-1).to - captions.at(-1).from > 1000);
});

test('ambiguous repeated trace actions do not invent an association', () => {
  const steps = [{ at: 2000, action: 'do: extract "version"' }];
  assert.equal(withTraceResults(steps, [
    { at: 1500, do: 'extract "version"', extracted: { value: 'one' } },
    { at: 2500, do: 'extract "version"', extracted: { value: 'two' } },
  ], 1000, 4000)[0].result, undefined);
});

test('stopped badge prefers plan step numbers and supports recordings without stills', () => {
  assert.equal(endBadge([{ step: 4, doStep: '2.1', action: 'do: extract "version"', status: 'FAILED' }], 2000).text, 'Stopped at step 2.1 · 0:02');
  assert.equal(endBadge([{ step: null, action: 'read' }, { step: null, action: 'do: extract "version"', status: 'FAILED' }], 2000).text, 'Stopped at step 1 · 0:02');
});

test('a failure after the final do step also stops the end badge', () => {
  assert.deepEqual(endBadge([{ step: 1, action: 'do: click "Go"', status: 'SUCCESS' }, { step: 2, action: 'read', status: 'FAILED' }, { action: 'stop recording' }], 3000), { stopped: true, text: 'Stopped at step 2 · 0:03' });
});
