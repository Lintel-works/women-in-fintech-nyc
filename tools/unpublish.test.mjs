import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/unpublish.js';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { serializePost } from '../lib/post-file.mjs';

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

function makeRequest({ method = 'POST', authorization, body } = {}) {
  return { method, headers: authorization ? { authorization } : {}, body };
}

/* Mints a token the way Clerk does -- RS256, short-lived, azp matching the
   configured origin -- so the handler's real verification path is exercised
   rather than stubbed. `email: null` omits the claim, as Clerk's default
   session token does. */
function bearer({ email = 'jane@example.com', role, exp } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    sub: 'user_123',
    azp: 'https://nycfintechwomen.com',
    exp: exp === undefined ? now + 60 : exp,
    nbf: now - 5
  };
  if (email !== null) payload.email = email;
  if (role) payload.public_metadata = { role };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const input = `${b64(header)}.${b64(payload)}`;
  const sig = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `Bearer ${input}.${sig}`;
}

/* api/unpublish.js calls getFileContent()/commitWithRetry() with no injected
   fetchImpl, so the only way to script the GitHub API from a test is to stub
   the global fetch -- the same technique tools/publish.test.mjs uses to prove
   preparePublish() makes no network call at all. */
function stubFetch(responses) {
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

test('no bearer token is refused with 401 and makes no GitHub call', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const request = makeRequest({ body: { type: 'post', slug: 'october-recap' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 401);
    // Distinct from an expired token: nothing was presented, so nothing expired.
    assert.match(response.body.message, /not signed in/i);
    assert.doesNotMatch(response.body.message, /expired/i);
  } finally {
    restore();
  }
}));

test('a token with a bad signature is refused with 401 and makes no GitHub call', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const [header, body] = bearer().replace(/^Bearer /, '').split('.');
    const request = makeRequest({
      authorization: `Bearer ${header}.${body}.not-a-real-signature`,
      body: { type: 'post', slug: 'october-recap' }
    });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 401);
  } finally {
    restore();
  }
}));

test('an expired token is refused with 401 saying so, with no GitHub call', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const now = Math.floor(Date.now() / 1000);
    const request = makeRequest({
      authorization: bearer({ exp: now - 600 }),
      body: { type: 'post', slug: 'october-recap' }
    });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 401);
    assert.match(response.body.message, /expired/i);
  } finally {
    restore();
  }
}));

/* Clerk's default session token has no email claim; see the matching test in
   tools/publish-handler.test.mjs. */
test('a token with no email claim is a configuration fault, not an author', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const request = makeRequest({
      authorization: bearer({ email: null }),
      body: { type: 'post', slug: 'october-recap' }
    });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 503);
    assert.match(response.body.message, /not set up/i);
  } finally {
    restore();
  }
}));

test('GET is refused with 405 and makes no GitHub call', () => withEnv(async () => {
  const restore = noNetwork();
  try {
    const request = makeRequest({ method: 'GET', authorization: bearer() });
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
    const request = makeRequest({ authorization: bearer(), body: { type: 'not-a-type', slug: 'october-recap' } });
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
    const request = makeRequest({ authorization: bearer(), body: { type: 'post', slug: '   ' } });
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
    const request = makeRequest({ authorization: bearer(), body: { type: 'post', slug: 'never-published' } });
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
    const request = makeRequest({ authorization: bearer(), body: { type: 'post', slug: 'October Recap' } });
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

/* The point of this whole change: the commit is authored by the verified
   email claim, lower-cased, never by the opaque Clerk user id. */
test('the commit is authored by the lower-cased email claim, not the user id', () => withEnv(async () => {
  const post = serializePost({ type: 'post', slug: 'october-recap', title: 'October Recap', blocks: [] });
  const fetchStub = stubFetch([
    contentsResponse(post),
    { status: 200, body: { object: { sha: 'HEADSHA' } } },
    { status: 200, body: { tree: { sha: 'BASETREE' } } },
    { status: 201, body: { sha: 'NEWTREE' } },
    { status: 201, body: { sha: 'NEWCOMMIT' } },
    { status: 200, body: { object: { sha: 'NEWCOMMIT' } } }
  ]);
  try {
    const request = makeRequest({
      authorization: bearer({ email: 'Jane@Example.COM' }),
      body: { type: 'post', slug: 'october-recap' }
    });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 200);
    const commitCall = fetchStub.calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/commits'));
    assert.equal(commitCall.body.author.email, 'jane@example.com');
    assert.equal(commitCall.body.author.name, 'jane');
    assert.match(commitCall.body.message, /by jane@example\.com\./);
    assert.doesNotMatch(JSON.stringify(commitCall.body), /user_123/);
  } finally {
    fetchStub.restore();
  }
}));

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
    const request = makeRequest({ authorization: bearer(), body: { type: 'post', slug: 'october-recap' } });
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
    const request = makeRequest({ authorization: bearer(), body: { type: 'post', slug: 'october-recap' } });
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
    const request = makeRequest({ authorization: bearer(), body: { type: 'post', slug: 'october-recap' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 503);
    assert.ok(!JSON.stringify(response.body).includes(ENV.GITHUB_TOKEN));
  } finally {
    fetchStub.restore();
  }
}));

// FIX 5 (final wave): fff and post share one src/posts/ namespace,
// addressed only by slug. validatePublish already checks `type` coming IN;
// nothing used to check it going OUT, so {type:'post', slug:'shira-amrany'}
// deleted the FFF post at that slug with zero type mismatch in sight.
test('unpublishing the wrong type for a real post is refused as not-found, and commits nothing', () => withEnv(async () => {
  const fffPost = serializePost({ type: 'fff', slug: 'shira-amrany', name: 'Shira Amrany', blocks: [] });
  const fetchStub = stubFetch([contentsResponse(fffPost)]); // getFileContent only
  try {
    const request = makeRequest({ authorization: bearer(), body: { type: 'post', slug: 'shira-amrany' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 404, 'a type mismatch must not be distinguishable from not-found');
    assert.match(response.body.message, /no published post/i);
    assert.equal(fetchStub.calls.length, 1, 'must stop after reading the file -- no commit calls');
  } finally {
    fetchStub.restore();
  }
}));

test('unpublishing the matching type still deletes normally', () => withEnv(async () => {
  const fffPost = serializePost({ type: 'fff', slug: 'shira-amrany', name: 'Shira Amrany', blocks: [] });
  const fetchStub = stubFetch([
    contentsResponse(fffPost),
    { status: 200, body: { object: { sha: 'HEADSHA' } } },
    { status: 200, body: { tree: { sha: 'BASETREE' } } },
    { status: 201, body: { sha: 'NEWTREE' } },
    { status: 201, body: { sha: 'NEWCOMMIT' } },
    { status: 200, body: { object: { sha: 'NEWCOMMIT' } } }
  ]);
  try {
    const request = makeRequest({ authorization: bearer(), body: { type: 'fff', slug: 'shira-amrany' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 200);
  } finally {
    fetchStub.restore();
  }
}));

// FIX 4 (final wave): the cover cleanup must find a PNG cover, not just a
// JPEG one -- extending Ruling 22's protection to the extension api/publish.js
// can now actually write (Ruling 24: keep-original honours a PNG).
test('a PNG cover at the conventional path is deleted too', () => withEnv(async () => {
  const post = serializePost({
    type: 'post', slug: 'october-recap', title: 'October Recap',
    coverPath: 'images/post-october-recap.png',
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
    const request = makeRequest({ authorization: bearer(), body: { type: 'post', slug: 'october-recap' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 200);
    const treeCall = fetchStub.calls.find((c) => c.url.endsWith('/git/trees'));
    const paths = treeCall.body.tree.map((entry) => entry.path);
    assert.deepEqual(paths.sort(), ['src/images/post-october-recap.png', 'src/posts/october-recap.html'].sort());
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
    const request = makeRequest({ authorization: bearer(), body: { type: 'post', slug: 'october-recap' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 503);
    assert.ok(!JSON.stringify(response.body).includes(ENV.GITHUB_TOKEN));
  } finally {
    fetchStub.restore();
  }
}));

// FIX 3 (final wave): with no GITHUB_TOKEN override, the handler must mint an
// installation token from the App credentials before its first GitHub Data
// API call -- proving the App path is actually wired in, not just present as
// unused code in lib/github-auth.mjs.
const APP_ENV = {
  CLERK_PEM_PUBLIC_KEY: CLERK_PEM,
  CLERK_AUTHORIZED_PARTIES: 'https://nycfintechwomen.com',
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: '',   // set per-test below with a real generated PEM
  GITHUB_INSTALLATION_ID: '999',
  GITHUB_OWNER: 'owner',
  GITHUB_REPO: 'repo',
  GITHUB_BRANCH: 'main'
};

function withAppEnv(fn) {
  const saved = {};
  for (const key of Object.keys(APP_ENV)) { saved[key] = process.env[key]; process.env[key] = APP_ENV[key]; }
  delete process.env.GITHUB_TOKEN;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(APP_ENV)) process.env[key] = saved[key];
      process.env.GITHUB_TOKEN = ENV.GITHUB_TOKEN;
    });
}

test('with no GITHUB_TOKEN override, an installation token is minted before the first GitHub call', () => withAppEnv(async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' });

  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).includes('/access_tokens')) {
      return { ok: true, status: 201, json: async () => ({ token: 'ghs_minted' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) }; // getFileContent: not found is fine here
  };
  try {
    const request = makeRequest({ authorization: bearer(), body: { type: 'post', slug: 'october-recap' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(calls[0].includes('/access_tokens'), true, 'the token must be minted before any other GitHub call');
    assert.equal(response.statusCode, 404); // getFileContent 404 -> not-found
  } finally {
    globalThis.fetch = original;
  }
}));

test('a malformed App private key is reported distinctly from a GitHub-rejected credential', () => withAppEnv(async () => {
  process.env.GITHUB_APP_PRIVATE_KEY = 'not a real pem';
  const restore = noNetwork();
  try {
    const request = makeRequest({ authorization: bearer(), body: { type: 'post', slug: 'october-recap' } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 503);
    assert.match(response.body.message, /key could not be read/);
  } finally {
    restore();
  }
}));
