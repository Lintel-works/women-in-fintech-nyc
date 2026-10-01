import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorNameFromSub } from '../lib/session.mjs';

// FIX 7 (final wave): a sub with no local part -- one starting with "@", or
// "@" alone -- used to make authorNameFromSub return "". An empty git commit
// author name is a 422 from GitHub's own API, which lib/github.mjs maps to
// 'stale_head', which commitWithRetry retries once and still fails: the
// author would see "Someone else just published" forever, for a bug that has
// nothing to do with anyone else publishing.
test('authorNameFromSub uses the local part of an email', () => {
  assert.equal(authorNameFromSub('jane@example.com'), 'jane');
});

test('authorNameFromSub falls back to the whole sub when there is no local part', () => {
  assert.equal(authorNameFromSub('@example.com'), '@example.com');
  assert.equal(authorNameFromSub('@'), '@');
});

test('authorNameFromSub returns a sub with no @ unchanged', () => {
  assert.equal(authorNameFromSub('jane'), 'jane');
});
