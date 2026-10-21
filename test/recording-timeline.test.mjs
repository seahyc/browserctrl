import test from 'node:test';
import assert from 'node:assert/strict';
import { panelTimeline } from '../lib/recording-timeline.mjs';

test('old recordings stay on the source panel', () => {
  assert.deepEqual(panelTimeline([{ at: 100, action: 'read' }, { at: 200, action: 'stop recording' }], 'source'), [
    { at: 0, tab: 'source', label: '', url: '' },
  ]);
});

test('owned item panels follow opens and close back to their source', () => {
  const steps = Array.from({ length: 3 }, (_, i) => [
    { at: 100 + i * 100, event: 'tab-open', tab: `child${i}`, sourceTab: 'source', label: `item ${i + 1} of 3`, url: `https://fixture.test/${i}` },
    { at: 120 + i * 100, tab: `child${i}`, path: `1.item[${i + 1}]`, action: 'do: extract "price"' },
    { at: 140 + i * 100, event: 'tab-close', tab: `child${i}`, sourceTab: 'source' },
  ]).flat();
  assert.deepEqual(panelTimeline(steps, 'source'), [
    { at: 0, tab: 'source', label: '', url: '' },
    ...Array.from({ length: 3 }, (_, i) => [
      { at: 100 + i * 100, tab: `child${i}`, label: `item ${i + 1} of 3`, url: `https://fixture.test/${i}` },
      { at: 140 + i * 100, tab: 'source', label: '', url: '' },
    ]).flat(),
  ]);
});

test('rejected try candidates return before the next candidate opens', () => {
  const timeline = panelTimeline([
    { at: 20, event: 'tab-open', tab: 'rejected', label: 'attempt 1', url: 'https://fixture.test/a' },
    { at: 30, tab: 'rejected', path: '1.attempt[1]', status: 'FAILED' },
    { at: 40, event: 'tab-close', tab: 'rejected', sourceTab: 'source' },
    { at: 50, event: 'tab-open', tab: 'picked', label: 'attempt 2', url: 'https://fixture.test/b' },
    { at: 60, tab: 'picked', path: '1.attempt[2]' },
    { at: 70, event: 'tab-close', tab: 'picked', sourceTab: 'source' },
  ], 'source');
  assert.deepEqual(timeline.map(s => [s.at, s.tab]), [[0, 'source'], [20, 'rejected'], [40, 'source'], [50, 'picked'], [70, 'source']]);
});

test('tagged steps switch nested panels and equal-time rows preserve their order', () => {
  const timeline = panelTimeline([
    { at: 20, tab: 'child', label: 'item 1 of 1', url: 'https://fixture.test' },
    { at: 30, event: 'tab-open', tab: 'nested', label: 'attempt 1' },
    { at: 40, event: 'tab-close', tab: 'nested', sourceTab: 'child' },
    { at: 40, event: 'tab-close', tab: 'child', sourceTab: 'source' },
  ], 'source');
  assert.deepEqual(timeline.map(s => [s.at, s.tab]), [[0, 'source'], [20, 'child'], [30, 'nested'], [40, 'child'], [40, 'source']]);
  assert.equal(timeline[3].label, 'item 1 of 1');
});

test('ending an accepted track returns to source without claiming a tab closure', () => {
  assert.deepEqual(panelTimeline([
    { at: 20, event: 'tab-open', tab: 'accepted', label: 'attempt 2' },
    { at: 30, event: 'track-stop', tab: 'accepted', sourceTab: 'source' },
  ], 'source').map(s => [s.at, s.tab]), [[0, 'source'], [20, 'accepted'], [30, 'source']]);
});

test('lifecycle rows do not replace the extraction result caption', async () => {
  const { captionTrack } = await import('../lib/video.mjs');
  const track = captionTrack([
    { at: 2000, action: 'do: extract "price"', result: 'SGD 200' },
    { at: 2100, event: 'tab-close', action: 'closed item 2' },
    { at: 2200, event: 'tab-open', action: 'opened item 3 in a background tab: Hotel 3' },
  ], 1000, 4000);
  assert.equal(track.captions.at(-1).text, 'Read “SGD 200”');
  assert.equal(track.captions.at(-1).to, 3500);
});
