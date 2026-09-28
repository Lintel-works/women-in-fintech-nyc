import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  normalisePrivateKey,
  signAppJwt,
  mintInstallationToken,
  resolveGithubToken
} from '../lib/github-auth.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

test('a literal \\n sequence (how Vercel carries a pasted PEM) becomes a real newline', () => {
  const escaped = '-----BEGIN KEY-----\\nABC\\nDEF\\n-----END KEY-----\\n';
  assert.equal(normalisePrivateKey(escaped), '-----BEGIN KEY-----\nABC\nDEF\n-----END KEY-----\n');
});

test('a key that already has real newlines is left untouched', () => {
  assert.equal(normalisePrivateKey(PEM), PEM);
});

test('signAppJwt produces a JWT verifiable with the matching public key', () => {
  const jwt = signAppJwt({ appId: '12345', privateKey: PEM, now: 1_700_000_000 });
  const [headerPart, payloadPart, signaturePart] = jwt.split('.');
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  assert.equal(header.alg, 'RS256');
  assert.equal(payload.iss, '12345');
  assert.equal(payload.iat, 1_700_000_000 - 60);
  assert.equal(payload.exp, 1_700_000_000 + 540);
  assert.ok(payload.exp - payload.iat <= 600, 'exp must stay within GitHub App JWT\'s 10-minute ceiling');

  const verifier = createVerify('RSA-SHA256').update(`${headerPart}.${payloadPart}`);
  const ok = verifier.verify(publicKey, Buffer.from(signaturePart, 'base64url'));
  assert.equal(ok, true, 'the signature must verify against the App\'s own public key');
});

test('a malformed private key fails with code "key", distinct from a GitHub rejection', () => {
  assert.throws(
    () => signAppJwt({ appId: '1', privateKey: 'not a real pem' }),
    (error) => error.code === 'key' && /key could not be read/.test(error.message)
  );
});

test('mintInstallationToken mints once and returns the token GitHub sends back', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.authorization });
    return { ok: true, status: 201, json: async () => ({ token: 'ghs_minted' }) };
  };
  const token = await mintInstallationToken({
    appId: '1', privateKey: PEM, installationId: '999', fetchImpl
  });
  assert.equal(token, 'ghs_minted');
  assert.equal(calls.length, 1, 'exactly one mint call');
  assert.match(calls[0].url, /\/app\/installations\/999\/access_tokens$/);
  assert.match(calls[0].authorization, /^Bearer /);
});

test('mintInstallationToken reports a GitHub-rejected JWT as code "auth"', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(
    mintInstallationToken({ appId: '1', privateKey: PEM, installationId: '999', fetchImpl }),
    (error) => error.code === 'auth'
  );
});

test('resolveGithubToken mints via the App when no override is set', async () => {
  const calls = [];
  const fetchImpl = async () => {
    calls.push(1);
    return { ok: true, status: 201, json: async () => ({ token: 'ghs_from_app' }) };
  };
  const token = await resolveGithubToken(
    { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_INSTALLATION_ID: '999' },
    fetchImpl
  );
  assert.equal(token, 'ghs_from_app');
  assert.equal(calls.length, 1, 'minted exactly once');
});

test('resolveGithubToken uses GITHUB_TOKEN as an override and warns loudly', async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    const fetchImpl = async () => { throw new Error('must not mint when an override is set'); };
    const token = await resolveGithubToken({ GITHUB_TOKEN: 'ghp_override' }, fetchImpl);
    assert.equal(token, 'ghp_override');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /GITHUB_TOKEN/);
  } finally {
    console.warn = originalWarn;
  }
});

test('resolveGithubToken returns null when nothing is configured', async () => {
  const token = await resolveGithubToken({}, async () => { throw new Error('must not fetch'); });
  assert.equal(token, null);
});
