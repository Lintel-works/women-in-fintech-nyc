import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { verifyClerkToken, isAdmin } from '../lib/clerk-jwt.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });
const PARTIES = ['https://nycfintechwomen.com'];

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function makeToken(payloadOverrides = {}, headerOverrides = {}) {
  const header = { alg: 'RS256', typ: 'JWT', ...headerOverrides };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 'user_123',
    email: 'jane@example.com',
    azp: PARTIES[0],
    exp: now + 60,
    nbf: now - 5,
    ...payloadOverrides
  };
  const input = `${b64(header)}.${b64(payload)}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `${input}.${signature}`;
}

const opts = (over = {}) => ({ publicKey: PEM, authorizedParties: PARTIES, ...over });

function codeOf(fn) {
  try { fn(); return null; } catch (error) { return error.code; }
}

test('a valid token returns its payload', () => {
  const payload = verifyClerkToken(makeToken(), opts());
  assert.equal(payload.email, 'jane@example.com');
  assert.equal(payload.sub, 'user_123');
});

test('a missing public key is a configuration fault, not a bad token', () => {
  assert.equal(codeOf(() => verifyClerkToken(makeToken(), opts({ publicKey: '' }))), 'config');
});

test('an expired token is distinguishable from an invalid one', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(codeOf(() => verifyClerkToken(makeToken({ exp: now - 600 }), opts())), 'expired');
});

test('a tampered signature is invalid', () => {
  const token = makeToken();
  const tampered = token.slice(0, -4) + 'AAAA';
  assert.equal(codeOf(() => verifyClerkToken(tampered, opts())), 'invalid');
});

/* Review Focus 1: algorithm confusion. A token asking to be verified with
   HMAC, using the public key as the shared secret, is the classic JWT
   forgery. The alg must be pinned before any verification happens. */
test('a token claiming HS256 or none is rejected without verification', () => {
  for (const alg of ['HS256', 'none', 'RS512']) {
    const token = makeToken({}, { alg });
    assert.equal(codeOf(() => verifyClerkToken(token, opts())), 'invalid', `alg ${alg} must be refused`);
  }
});

/* Review Focus 2: clock skew. Tokens live 60 seconds; a second of skew
   between Vercel and Clerk must not reject a valid token, and leeway must
   not resurrect a genuinely expired one. */
test('small clock skew is tolerated but real expiry is not', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.ok(verifyClerkToken(makeToken({ exp: now - 2 }), opts({ now })), 'two seconds of skew must pass');
  assert.ok(verifyClerkToken(makeToken({ nbf: now + 2 }), opts({ now })), 'nbf two seconds ahead must pass');
  assert.equal(codeOf(() => verifyClerkToken(makeToken({ exp: now - 60 }), opts({ now }))), 'expired');
  assert.equal(codeOf(() => verifyClerkToken(makeToken({ nbf: now + 600 }), opts({ now }))), 'invalid');
});

/* Review Focus 3: a malformed token must never throw uncaught — Vercel would
   render that as a 500 and an author would be told the site is broken. */
test('malformed tokens yield invalid rather than throwing', () => {
  for (const bad of ['', 'a.b', 'a.b.c.d', 'not-base64!.x.y', `${Buffer.from('not json').toString('base64url')}.x.y`, null, undefined]) {
    assert.equal(codeOf(() => verifyClerkToken(bad, opts())), 'invalid', `${String(bad)} must be invalid`);
  }
});

test('a token from another origin is rejected', () => {
  assert.equal(codeOf(() => verifyClerkToken(makeToken({ azp: 'https://evil.example' }), opts())), 'invalid');
});

test('role and email are read from the customized claims', () => {
  const payload = verifyClerkToken(makeToken({ public_metadata: { role: 'admin' } }), opts());
  assert.equal(payload.email, 'jane@example.com');
  assert.equal(payload.public_metadata.role, 'admin');
});

test('empty authorizedParties with a token that has azp is a configuration fault', () => {
  assert.equal(codeOf(() => verifyClerkToken(makeToken(), opts({ authorizedParties: [] }))), 'config');
});

test('a token with no azp claim passes even when authorizedParties is configured', () => {
  const payload = verifyClerkToken(makeToken({ azp: undefined }), opts());
  assert.ok(payload);
  assert.equal(payload.email, 'jane@example.com');
});

test('isAdmin returns true for public_metadata.role === admin', () => {
  const payload = { public_metadata: { role: 'admin' } };
  assert.equal(isAdmin(payload), true);
});

test('isAdmin returns false for a different role', () => {
  const payload = { public_metadata: { role: 'user' } };
  assert.equal(isAdmin(payload), false);
});

test('isAdmin returns false when public_metadata is missing', () => {
  const payload = { sub: 'user_123' };
  assert.equal(isAdmin(payload), false);
});

test('isAdmin returns false for null or undefined payload', () => {
  assert.equal(isAdmin(null), false);
  assert.equal(isAdmin(undefined), false);
});

test('isAdmin returns false when role is in user_metadata instead of public_metadata', () => {
  const payload = { user_metadata: { role: 'admin' } };
  assert.equal(isAdmin(payload), false);
});

test('a PEM with literal \\n sequences verifies a valid token', () => {
  const pemWithLiteral = PEM.replace(/\n/g, '\\n');
  const payload = verifyClerkToken(makeToken(), opts({ publicKey: pemWithLiteral }));
  assert.equal(payload.email, 'jane@example.com');
});
