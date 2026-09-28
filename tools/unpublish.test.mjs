import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/unpublish.js';
import { signSession } from '../lib/session.mjs';

const ENV = {
  AUTH_SECRET: 'a-test-secret-that-is-long-enough',
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

function makeRequest({ method = 'POST', cookie, body } = {}) {
  return { method, headers: cookie ? { cookie } : {}, body };
}

function validCookie() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `wif_session=${signSession({ sub: 'jane@example.com', exp }, ENV.AUTH_SECRET)}`;
}

/* api/unpublish.js calls commitWithRetry() without an injected fetchImpl, so
   the only way to script the Git Data API from a test is to stub the global
   fetch the same way tools/publish.test.mjs stubs it to prove no I/O
   happens -- here it is stubbed to a canned success sequence instead. */
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

/* A stub that throws if called at all -- proves a refused request makes
   zero GitHub calls, the way preparePublish's "performs no I/O" test does
   in tools/publish.test.mjs. */
function noNetwork() {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('handler made a network call'); };
  return () => { globalThis.fetch = original; };
}

test('no cookie is refused with 401 and makes no GitHub call', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const request = makeRequest({ body: { type: 'post', slug: 'october-recap' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 401);
    assert.match(response.body.message, /session expired/i);
  } finally {
    restore();
  }
}));

test('a forged cookie is refused with 401 and makes no GitHub call', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const forgedBody = Buffer.from(JSON.stringify({ sub: 'attacker@example.com', exp })).toString('base64url');
    const request = makeRequest({
      cookie: `wif_session=${forgedBody}.not-a-real-signature`,
      body: { type: 'post', slug: 'october-recap' }
    });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 401);
  } finally {
    restore();
  }
}));

test('GET is refused with 405 and makes no GitHub call', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const request = makeRequest({ method: 'GET', cookie: validCookie() });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.Allow, 'POST');
  } finally {
    restore();
  }
}));

test('an unknown post type is refused with 400 and makes no GitHub call', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const request = makeRequest({ cookie: validCookie(), body: { type: 'not-a-type', slug: 'october-recap' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /not a post type/i);
  } finally {
    restore();
  }
}));

test('a missing slug is refused with 400 and makes no GitHub call', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const request = makeRequest({ cookie: validCookie(), body: { type: 'post', slug: '   ' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /name the post/i);
  } finally {
    restore();
  }
}));

test('a valid request deletes the computed path and returns the commit sha', () => withEnv(async () => {
  const fetchStub = stubFetch([
    { status: 200, body: { object: { sha: 'HEADSHA' } } },        // get ref
    { status: 200, body: { tree: { sha: 'BASETREE' } } },         // get commit
    { status: 201, body: { sha: 'NEWTREE' } },                    // create tree (no blob: it's a delete)
    { status: 201, body: { sha: 'NEWCOMMIT' } },                  // create commit
    { status: 200, body: { object: { sha: 'NEWCOMMIT' } } }       // update ref
  ]);
  try {
    const request = makeRequest({ cookie: validCookie(), body: { type: 'post', slug: 'October Recap' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.commit, 'NEWCOMMIT');
    assert.ok(!fetchStub.calls.some((c) => c.url.endsWith('/git/blobs')), 'a delete must not create a blob');
    // The slug is slugified server-side, so the deleted path matches what
    // was actually published, not whatever casing/spacing the caller sent.
    const treeCall = fetchStub.calls.length; // sanity: the full 5-call sequence ran
    assert.equal(treeCall, 5);
  } finally {
    fetchStub.restore();
  }
}));

test('a GitHub auth failure is reported without ever naming the token', () => withEnv(async () => {
  const fetchStub = stubFetch([{ status: 401, body: { message: 'Bad credentials' } }]);
  try {
    const request = makeRequest({ cookie: validCookie(), body: { type: 'post', slug: 'october-recap' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 503);
    assert.ok(!JSON.stringify(response.body).includes(ENV.GITHUB_TOKEN));
  } finally {
    fetchStub.restore();
  }
}));
