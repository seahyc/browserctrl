import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankLines, ranking } from '../lib/do/rank-lines.mjs';
const grid = Array.from({ length: 785 }, (_, i) => ({ text: `${i % 27 + 1} Mar 2027 - Site E${100 + i} is available`, i }));
test('rank the complete grid locally, retaining source lines and page indices', () => {
  const rows = rankLines(grid, 'earliest available date');
  assert.equal(rows.length, 785);
  assert.equal(rows[0].key, '2027-03-01');
  assert.equal(rows[0].order, 0);
  assert.equal(rows[1].order, 27);
  assert.equal(rankLines(grid, 'latest available date')[0].key, '2027-03-27');
});
test('first and last without a value type use original page order', () => {
  const lines = [{ text: 'Available cabin B', i: 9 }, { text: 'Available cabin A', i: 2 }];
  assert.equal(rankLines(lines, 'first available cabin')[0].text, 'Available cabin A');
  assert.equal(rankLines(lines, 'last available cabin')[0].text, 'Available cabin B');
  assert.equal(ranking('first available date').type, 'date');
  assert.equal(rankLines(['Cabin B', 'Cabin A'], 'first listed')[0].text, 'Cabin B');
});
test('rank prices and numbers locally and reject missing or ambiguous keys', () => {
  assert.equal(rankLines(['Rate $50.59', 'Rate $20.00'], 'cheapest rate')[0].key, 20);
  assert.equal(rankLines(['Score 9', 'Score 3'], 'highest score')[0].key, 9);
  assert.deepEqual(rankLines(['Nothing here'], 'earliest available date'), []);
  assert.deepEqual(rankLines(['Rate $20 or $30'], 'lowest rate'), []);
  assert.throws(() => rankLines(['Rate $20', 'Rate €30'], 'lowest rate'), /incompatible/);
});
