import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, SESSION_TTL_SECONDS, authorNameFromSub, readCookie } from '../lib/session.mjs';

const SECRET = 'a-test-secret-that-is-long-enough';

test('a signed session verifies and returns its payload', () => {
  const exp = 1800000000;
  const token = signSession({ sub: 'jane@example.com', exp }, SECRET);
  assert.deepEqual(verifySession(token, SECRET, exp - 10), { sub: 'jane@example.com', exp });
});

test('the session TTL is twelve hours', () => {
  assert.equal(SESSION_TTL_SECONDS, 43200);
});

test('a tampered signature is rejected', () => {
  const token = signSession({ sub: 'jane@example.com', exp: 1800000000 }, SECRET);
  const [body] = token.split('.');
  assert.equal(verifySession(`${body}.not-the-signature`, SECRET, 1799999990), null);
});

test('a payload edited to extend expiry is rejected', () => {
  const token = signSession({ sub: 'jane@example.com', exp: 1000 }, SECRET);
  const forged = Buffer.from(JSON.stringify({ sub: 'jane@example.com', exp: 9999999999 })).toString('base64url');
  assert.equal(verifySession(`${forged}.${token.split('.')[1]}`, SECRET, 2000), null);
});

test('a session signed with another secret is rejected', () => {
  const token = signSession({ sub: 'jane@example.com', exp: 1800000000 }, 'a-different-secret');
  assert.equal(verifySession(token, SECRET, 1799999990), null);
});

test('an expired session is rejected', () => {
  const token = signSession({ sub: 'jane@example.com', exp: 1000 }, SECRET);
  assert.equal(verifySession(token, SECRET, 1001), null);
});

test('malformed tokens are rejected without throwing', () => {
  for (const bad of ['', '.', 'nodot', '.leading', 'trailing.', null, undefined, 42, {}]) {
    assert.equal(verifySession(bad, SECRET, 1000), null, `accepted ${JSON.stringify(bad)}`);
  }
});

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

test('readCookie finds one cookie among several', () => {
  assert.equal(readCookie('a=1; wif_session=abc.def; b=2', 'wif_session'), 'abc.def');
});

test('readCookie returns null when the cookie is absent', () => {
  assert.equal(readCookie('a=1; b=2', 'wif_session'), null);
  assert.equal(readCookie(undefined, 'wif_session'), null);
});

test('readCookie preserves "=" characters inside the value (base64url session bodies never use it, but this must not truncate)', () => {
  assert.equal(readCookie('wif_session=part1=part2', 'wif_session'), 'part1=part2');
});
