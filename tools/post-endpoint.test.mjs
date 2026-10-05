/* GET /api/post — one published post's source, for the editor's post list.
 *
 * The harness is tools/unpublish.test.mjs's, because this endpoint reads the
 * same env, authenticates the same way and calls the same getFileContent().
 * The tests that matter here are the ones where it must differ: it is a GET,
 * it never commits, and the slug it is handed builds a repository path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/post.js';
import { generateKeyPairSync, createSign } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CLERK_PEM = publicKey.export({ type: 'spki', format: 'pem' });

const ENV = {
  CLERK_PEM_PUBLIC_KEY: CLERK_PEM,
  CLERK_AUTHORIZED_PARTIES: 'https://nycfintechwomen.com',
  GITHUB_TOKEN: 'ghtoken',
  GITHUB_OWNER: 'owner',
  GITHUB_REPO: 'repo',
  GITHUB_BRANCH: 'main'
};

function withEnv(fn) {
  const saved = {};
  for (const key of Object.keys(ENV)) { saved[key] = process.env[key]; process.env[key] = ENV[key]; }
  return Promise.resolve()
    .then(fn)
    .finally(() => { for (const key of Object.keys(ENV)) process.env[key] = saved[key]; });
}

function makeResponse() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

function makeRequest({ method = 'GET', authorization, query } = {}) {
  return { method, headers: authorization ? { authorization } : {}, query };
}

function bearer({ email = 'jane@example.com', exp } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    sub: 'user_123',
    azp: 'https://nycfintechwomen.com',
    exp: exp === undefined ? now + 60 : exp,
    nbf: now - 5
  };
  if (email !== null) payload.email = email;
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const input = `${b64(header)}.${b64(payload)}`;
  const sig = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `Bearer ${input}.${sig}`;
}

function stubFetch(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

function noNetwork() {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('handler made a network call'); };
  return () => { globalThis.fetch = original; };
}

function contentsResponse(text) {
  return { status: 200, body: { content: Buffer.from(text).toString('base64') + '\n', encoding: 'base64' } };
}

const SOURCE = '---\nname: "Shira Amrany"\nslug: "shira-amrany"\ntype: "fff"\n---\n';

test('a signed-in author gets the post source back', () => withEnv(async () => {
  const fetchStub = stubFetch([contentsResponse(SOURCE)]);
  try {
    const request = makeRequest({ authorization: bearer(), query: { type: 'fff', slug: 'shira-amrany' } });
    const response = makeResponse();
    await handler(request, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.source, SOURCE, 'the decoded source is what the editor parses back');
    assert.equal(response.body.slug, 'shira-amrany');
    assert.equal(response.body.type, 'fff');
    assert.equal(fetchStub.calls.length, 1, 'opening one post must cost exactly one GitHub call');
    // getFileContent encodes each path segment and rejoins with "/", so the
    // separators survive and only the segments are escaped.
    assert.match(fetchStub.calls[0].url, /\/contents\/src\/posts\/shira-amrany\.html\?ref=main$/);
  } finally {
    fetchStub.restore();
  }
}));

test('no bearer token is refused with 401 and makes no GitHub call', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const response = makeResponse();
    await handler(makeRequest({ query: { type: 'fff', slug: 'shira-amrany' } }), response);
    assert.equal(response.statusCode, 401);
  } finally {
    restore();
  }
}));

test('an expired token is refused and makes no GitHub call', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const now = Math.floor(Date.now() / 1000);
    const response = makeResponse();
    await handler(
      makeRequest({ authorization: bearer({ exp: now - 10 }), query: { type: 'fff', slug: 'shira-amrany' } }),
      response
    );
    assert.equal(response.statusCode, 401);
  } finally {
    restore();
  }
}));

test('POST is refused with 405 and makes no GitHub call', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const response = makeResponse();
    await handler(makeRequest({ method: 'POST', authorization: bearer(), query: { type: 'fff', slug: 'x' } }), response);
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.Allow, 'GET');
  } finally {
    restore();
  }
}));

test('an unknown post type is refused with 400 and makes no GitHub call', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const response = makeResponse();
    await handler(makeRequest({ authorization: bearer(), query: { type: 'nonsense', slug: 'x' } }), response);
    assert.equal(response.statusCode, 400);
  } finally {
    restore();
  }
}));

test('a missing slug is refused with 400 and makes no GitHub call', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const response = makeResponse();
    await handler(makeRequest({ authorization: bearer(), query: { type: 'fff' } }), response);
    assert.equal(response.statusCode, 400);
  } finally {
    restore();
  }
}));

/* The slug interpolates into a repository path, so traversal has to die at
   the slugify() call rather than at GitHub's door. A slug that is nothing but
   traversal slugifies to empty and is refused outright; one that survives must
   still only ever address src/posts/. */
test('a traversing slug cannot escape src/posts/', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const response = makeResponse();
    await handler(
      makeRequest({ authorization: bearer(), query: { type: 'fff', slug: '../../../../etc/passwd' } }),
      response
    );
    assert.notEqual(response.statusCode, 200, 'a traversing slug must never return a file');
  } finally {
    restore();
  }
}));

/* The index describes the last deploy, so a post unpublished since then is
   still listed. Opening it is an ordinary race, and the drawer needs to be
   able to tell that apart from a broken endpoint. */
test('a post that is no longer published answers 404, not an error', () => withEnv(async () => {
  const fetchStub = stubFetch([{ status: 404, body: {} }]);
  try {
    const response = makeResponse();
    await handler(makeRequest({ authorization: bearer(), query: { type: 'fff', slug: 'gone' } }), response);
    assert.equal(response.statusCode, 404);
    assert.match(response.body.message, /no longer published/i);
  } finally {
    fetchStub.restore();
  }
}));

test('it never writes: the only GitHub call is a GET', () => withEnv(async () => {
  const fetchStub = stubFetch([contentsResponse(SOURCE)]);
  try {
    await handler(
      makeRequest({ authorization: bearer(), query: { type: 'fff', slug: 'shira-amrany' } }),
      makeResponse()
    );
    assert.deepEqual(fetchStub.calls.map((c) => c.method), ['GET']);
  } finally {
    fetchStub.restore();
  }
}));
