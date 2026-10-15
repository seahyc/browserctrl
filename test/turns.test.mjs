// Pieces that save agent turns: how a step changed the address, the main list's links
// for a drill-down, and the lean items view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urlChange, mainLinks } from '../lib/steps.mjs';
import { formatItems } from '../lib/items.mjs';

test('a step that sets a filter shows as added and removed parameters', () => {
  assert.equal(urlChange('https://x.io/list?page=2', 'https://x.io/list/?state=closed'), '+state=closed -page');
  assert.equal(urlChange('https://x.io/a', 'https://x.io/b?q=1'), '→ /b +q=1');
  assert.equal(urlChange('https://x.io/a', 'https://x.io/a'), null);
});

const page = { url: 'https://x.io/s', title: 't', scroll: { y: 0, h: 1, vh: 1 }, groups: [
  { id: 'g1', region: 'nav', chrome: true, count: 3, items: [{ id: 'i1', text: 'Home', link: '/' }] },
  { id: 'g2', region: 'main', count: 4, items: [
    { id: 'i2', text: 'Spotlight · Chair A · S$10', link: '/p/a' },
    { id: 'i3', text: 'Chair B · S$20', link: '/p/b' },
    { id: 'i4', text: 'Chair C · S$30', link: '/p/c', hints: ['card-sponsored'] },
    { id: 'i5', text: 'Chair D · S$40', link: '/p/d' },
  ] },
  { id: 'g3', region: 'aside', count: 3, items: [{ id: 'i6', text: 'Related one' }, { id: 'i7', text: 'Related two' }, { id: 'i8', text: 'Related three' }] },
] };

test('the drill-down takes the main list in order and skips ads', () => {
  assert.deepEqual(mainLinks(page, 2, page.url), ['https://x.io/p/b', 'https://x.io/p/d']);
});

test('the lean view shows the main list in full and folds the rest; grep filters items', () => {
  const lean = formatItems(page, { main: true });
  assert.match(lean, /Chair B/);
  assert.match(lean, /Related one \| Related two .*--group g3/);
  const only = formatItems(page, { grep: 'S\\$40' });
  assert.match(only, /Chair D/);
  assert.doesNotMatch(only, /Chair B/);
});
