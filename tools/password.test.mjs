import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../lib/password.mjs';

test('a password verifies against its own hash', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
});

test('a wrong password does not verify', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('Correct Horse Battery Staple', stored), false);
});

test('two hashes of the same password differ, because the salt is random', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('a malformed stored value is rejected without throwing', () => {
  for (const bad of ['', 'nocolon', ':', 'a:', ':b', null, undefined]) {
    assert.equal(verifyPassword('x', bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the dummy hash api/login.js uses actually reaches scrypt', () => {
  // If this returns before hashing, the unknown-email path is fast and the
  // known-email path is slow, which tells an attacker which emails exist.
  // A valid-shaped dummy is the only thing that makes the timing equal.
  const DUMMY_HASH = '00'.repeat(16) + ':' + '00'.repeat(64);
  const start = process.hrtime.bigint();
  assert.equal(verifyPassword('anything', DUMMY_HASH), false);
  const dummyNs = process.hrtime.bigint() - start;

  const real = hashPassword('some real password');
  const start2 = process.hrtime.bigint();
  verifyPassword('wrong', real);
  const realNs = process.hrtime.bigint() - start2;

  // Both paths do the same scrypt work, so they land within an order of
  // magnitude. A dummy that short-circuits is ~1000x faster and fails here.
  const ratio = Number(realNs) / Number(dummyNs);
  assert.ok(ratio < 10 && ratio > 0.1, `timing differed by ${ratio.toFixed(1)}x — the dummy hash is short-circuiting`);
});
