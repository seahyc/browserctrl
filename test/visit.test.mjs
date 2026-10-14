// visit: the line filter that keeps a drill-down's output small.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grepLines } from '../lib/visit.mjs';

test('grep keeps matching lines with their neighbours, in page order, once each', () => {
  const lines = ['Request to merge', 'hotfix/fix-image-url', 'into', 'develop', 'Overview 0', 'Commits 3', 'Changes 2'];
  assert.deepEqual(grepLines(lines, '^into$'), ['hotfix/fix-image-url', 'into', 'develop']);
  assert.deepEqual(grepLines(lines, 'commits|changes', { context: 0 }), ['Commits 3', 'Changes 2']);
  assert.deepEqual(grepLines(lines, 'nothing'), []);
});
