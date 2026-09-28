import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/unpublish.js';
import { signSession } from '../lib/session.mjs';
import { serializePost } from '../lib/post-file.mjs';

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

/* api/unpublish.js calls getFileContent()/commitWithRetry() with no injected
   fetchImpl, so the only way to script the GitHub API from a test is to stub
   the global fetch -- the same technique tools/publish.test.mjs uses to prove
   preparePublish() makes no network call at all. */
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
   zero GitHub calls. */
function noNetwork() {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('handler made a network call'); };
  return () => { globalThis.fetch = original; };
}

/* GitHub's Contents API response shape for a file: `content` is base64,
   wrapped at 60 columns in the real API -- the newline is included here to
   exercise the same decode path getFileContent() uses. */
function contentsResponse(text) {
  return { status: 200, body: { content: Buffer.from(text).toString('base64') + '\n', encoding: 'base64' } };
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

test('unpublishing a path that does not exist is refused with 404 and commits nothing', () => withEnv(async () => {
  const fetchStub = stubFetch([
    { status: 404, body: {} } // getFileContent: the post is not there
  ]);
  try {
    const request = makeRequest({ cookie: validCookie(), body: { type: 'post', slug: 'never-published' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 404);
    assert.match(response.body.message, /no published post/i);
    assert.equal(fetchStub.calls.length, 1, 'must stop after the existence check -- no commit calls');
  } finally {
    fetchStub.restore();
  }
}));

test('a valid request deletes the computed path and returns the commit sha', () => withEnv(async () => {
  const post = serializePost({
    type: 'post', slug: 'october-recap', title: 'October Recap',
    coverPath: 'images/some-other-cover.jpg', // not the conventional path: no image delete expected
    blocks: []
  });
  const fetchStub = stubFetch([
    contentsResponse(post),                                       // getFileContent
    { status: 200, body: { object: { sha: 'HEADSHA' } } },        // get ref
    { status: 200, body: { tree: { sha: 'BASETREE' } } },         // get commit
    { status: 201, body: { sha: 'NEWTREE' } },                    // create tree (delete only: no blob)
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
    assert.equal(fetchStub.calls.length, 6);
  } finally {
    fetchStub.restore();
  }
}));

/* A richer stub that also records request bodies, for the two cases where
   which paths ended up in the tree entry is the thing under test. */
function stubFetchWithBodies(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

test('the cover image path is included in the tree delete when coverPath matches the convention', () => withEnv(async () => {
  const post = serializePost({
    type: 'post', slug: 'october-recap', title: 'October Recap',
    coverPath: 'images/post-october-recap.jpg',
    blocks: []
  });
  const fetchStub = stubFetchWithBodies([
    contentsResponse(post),
    { status: 200, body: { object: { sha: 'HEADSHA' } } },
    { status: 200, body: { tree: { sha: 'BASETREE' } } },
    { status: 201, body: { sha: 'NEWTREE' } },
    { status: 201, body: { sha: 'NEWCOMMIT' } },
    { status: 200, body: { object: { sha: 'NEWCOMMIT' } } }
  ]);
  try {
    const request = makeRequest({ cookie: validCookie(), body: { type: 'post', slug: 'october-recap' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 200);
    const treeCall = fetchStub.calls.find((c) => c.url.endsWith('/git/trees'));
    const paths = treeCall.body.tree.map((entry) => entry.path);
    assert.deepEqual(paths.sort(), ['src/images/post-october-recap.jpg', 'src/posts/october-recap.html'].sort());
    assert.ok(treeCall.body.tree.every((entry) => entry.sha === null), 'every entry in this commit is a delete');
  } finally {
    fetchStub.restore();
  }
}));

test('the cover image is left alone when coverPath does not match the convention', () => withEnv(async () => {
  const post = serializePost({
    type: 'post', slug: 'october-recap', title: 'October Recap',
    coverPath: 'images/a-hand-picked-shared-cover.jpg',
    blocks: []
  });
  const fetchStub = stubFetchWithBodies([
    contentsResponse(post),
    { status: 200, body: { object: { sha: 'HEADSHA' } } },
    { status: 200, body: { tree: { sha: 'BASETREE' } } },
    { status: 201, body: { sha: 'NEWTREE' } },
    { status: 201, body: { sha: 'NEWCOMMIT' } },
    { status: 200, body: { object: { sha: 'NEWCOMMIT' } } }
  ]);
  try {
    const request = makeRequest({ cookie: validCookie(), body: { type: 'post', slug: 'october-recap' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 200);
    const treeCall = fetchStub.calls.find((c) => c.url.endsWith('/git/trees'));
    assert.deepEqual(treeCall.body.tree.map((entry) => entry.path), ['src/posts/october-recap.html']);
  } finally {
    fetchStub.restore();
  }
}));

test('a GitHub auth failure on the existence check is reported without ever naming the token', () => withEnv(async () => {
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

test('a GitHub auth failure on the commit itself is reported without ever naming the token', () => withEnv(async () => {
  const post = serializePost({ type: 'post', slug: 'october-recap', title: 'October Recap', blocks: [] });
  const fetchStub = stubFetch([
    contentsResponse(post),
    { status: 401, body: { message: 'Bad credentials' } }
  ]);
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
