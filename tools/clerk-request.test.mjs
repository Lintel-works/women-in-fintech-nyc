import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { authenticateClerkRequest } from '../lib/clerk-request.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ENV = {
  CLERK_PEM_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
  CLERK_AUTHORIZED_PARTIES: 'https://nycfintechwomen.com'
};

function request({ email = 'Jane@Example.com', role } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: 'user_123', azp: 'https://nycfintechwomen.com', exp: now + 60, nbf: now - 5 };
  if (email !== null) payload.email = email;
  if (role) payload.public_metadata = { role };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}`;
  const sig = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return { headers: { authorization: `Bearer ${input}.${sig}` } };
}

// The caller needs the whole payload (isAdmin) without verifying twice.
test('success returns the verified payload and a normalised email', () => {
  const result = authenticateClerkRequest(request({ role: 'admin' }), ENV);
  assert.equal(result.refusal, null);
  assert.equal(result.email, 'jane@example.com');
  assert.equal(result.session.sub, 'user_123');
  assert.deepEqual(result.session.public_metadata, { role: 'admin' });
});

test('a missing public key is a 503 with a generic message', () => {
  const { refusal } = authenticateClerkRequest(request(), { ...ENV, CLERK_PEM_PUBLIC_KEY: '' });
  assert.equal(refusal.status, 503);
  assert.doesNotMatch(refusal.message, /CLERK/);
});

test('an uncoded failure is a 500 that does not leak its text', () => {
  const hostile = { headers: { get authorization() { throw new TypeError('secret internal detail'); } } };
  const { refusal } = authenticateClerkRequest(hostile, ENV);
  assert.equal(refusal.status, 500);
  assert.doesNotMatch(refusal.message, /secret internal detail/);
});
