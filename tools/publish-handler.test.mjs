import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import handler from '../api/publish.js';
import { signSession } from '../lib/session.mjs';

const ENV = {
  AUTH_SECRET: 'a-test-secret-that-is-long-enough',
  GITHUB_TOKEN: 'ghtoken',
  GITHUB_OWNER: 'owner',
  GITHUB_REPO: 'repo',
  GITHUB_BRANCH: 'main'
};

function withEnv(env, fn) {
  const keys = Object.keys(env);
  const saved = {};
  for (const key of keys) { saved[key] = process.env[key]; process.env[key] = env[key]; }
  // Any App-only keys not in this particular env must not leak in from a
  // previous test in the same process.
  const appOnly = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID', 'GITHUB_TOKEN'];
  const savedAppOnly = {};
  for (const key of appOnly) {
    if (!(key in env)) { savedAppOnly[key] = process.env[key]; delete process.env[key]; }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) process.env[key] = saved[key];
      for (const key of appOnly) {
        if (key in savedAppOnly) {
          if (savedAppOnly[key] === undefined) delete process.env[key];
          else process.env[key] = savedAppOnly[key];
        }
      }
    });
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

function validCookie(secret = ENV.AUTH_SECRET) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `wif_session=${signSession({ sub: 'jane@example.com', exp }, secret)}`;
}

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

function noNetwork() {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('handler made a network call'); };
  return () => { globalThis.fetch = original; };
}

// Full create sequence: pathExists (404 -> does not exist), ref, commit,
// [blob if an image], tree, commit, ref-update.
function createSequence({ withImageBlob } = {}) {
  const seq = [
    { status: 404, body: {} }, // pathExists
    { status: 200, body: { object: { sha: 'HEADSHA' } } },
    { status: 200, body: { tree: { sha: 'BASETREE' } } }
  ];
  seq.push({ status: 201, body: { sha: 'BLOB-POST' } }); // post text blob
  if (withImageBlob) seq.push({ status: 201, body: { sha: 'BLOB-IMAGE' } });
  seq.push({ status: 201, body: { sha: 'NEWTREE' } });
  seq.push({ status: 201, body: { sha: 'NEWCOMMIT' } });
  seq.push({ status: 200, body: { object: { sha: 'NEWCOMMIT' } } });
  return seq;
}

test('no cookie is refused with 401 and makes no GitHub call', () => withEnv(ENV, async () => {
  const restore = noNetwork();
  try {
    const request = makeRequest({ body: { type: 'post', mode: 'create', fields: { title: 'X' }, blocks: [] } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 401);
  } finally {
    restore();
  }
}));

test('GET is refused with 405', () => withEnv(ENV, async () => {
  const restore = noNetwork();
  try {
    const request = makeRequest({ method: 'GET', cookie: validCookie() });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 405);
  } finally {
    restore();
  }
}));

test('an invalid payload is refused with 400 before any GitHub call', () => withEnv(ENV, async () => {
  const restore = noNetwork();
  try {
    const request = makeRequest({ cookie: validCookie(), body: { type: 'post', mode: 'create', fields: {}, blocks: [] } });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 400);
  } finally {
    restore();
  }
}));

test('a valid publish with no image commits one file and returns the URL', () => withEnv(ENV, async () => {
  const fetchStub = stubFetch(createSequence());
  try {
    const request = makeRequest({
      cookie: validCookie(),
      body: { type: 'post', mode: 'create', fields: { title: 'October Recap' }, blocks: [] }
    });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.url, '/post-october-recap.html');
  } finally {
    fetchStub.restore();
  }
}));

// FIX 4 (final wave): a PNG cover with "keep original" must publish as a
// .png at the conventional path, not silently as .jpg.
test('a PNG image publishes to the coverPathFor(...).png path', () => withEnv(ENV, async () => {
  const fetchStub = stubFetch(createSequence({ withImageBlob: true }));
  try {
    const base64 = Buffer.from('fake png bytes').toString('base64');
    const request = makeRequest({
      cookie: validCookie(),
      body: {
        type: 'post', mode: 'create', fields: { title: 'October Recap' }, blocks: [],
        image: { base64, ext: 'png' }
      }
    });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 200);
    const treeCall = fetchStub.calls.find((c) => c.url.endsWith('/git/trees'));
    const paths = treeCall.body.tree.map((e) => e.path);
    assert.ok(paths.includes('src/images/post-october-recap.png'), paths.join(', '));
    assert.ok(!paths.includes('src/images/post-october-recap.jpg'), paths.join(', '));
  } finally {
    fetchStub.restore();
  }
}));

test('an image extension outside jpg/png is refused with 400, no GitHub call', () => withEnv(ENV, async () => {
  const restore = noNetwork();
  try {
    const base64 = Buffer.from('fake webp bytes').toString('base64');
    const request = makeRequest({
      cookie: validCookie(),
      body: {
        type: 'post', mode: 'create', fields: { title: 'October Recap' }, blocks: [],
        image: { base64, ext: 'webp' }
      }
    });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /jpg or png/i);
  } finally {
    restore();
  }
}));

test('a create onto an existing path names changing the title or the slug, not "open the existing post"', () => withEnv(ENV, async () => {
  const fetchStub = stubFetch([{ status: 200, body: {} }]); // pathExists: true
  try {
    const request = makeRequest({
      cookie: validCookie(),
      body: { type: 'post', mode: 'create', fields: { title: 'October Recap' }, blocks: [] }
    });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 409);
    assert.ok(!/open the existing post/.test(response.body.message), 'must not promise a fix that cross-type posts refuse');
    assert.match(response.body.message, /slug field/);
  } finally {
    fetchStub.restore();
  }
}));

// FIX 3 (final wave): with no GITHUB_TOKEN override, the handler must mint an
// installation token before its first GitHub Data API call, and only once.
test('with no GITHUB_TOKEN override, exactly one installation token is minted before any other call', () => withEnv({
  AUTH_SECRET: ENV.AUTH_SECRET,
  GITHUB_OWNER: ENV.GITHUB_OWNER,
  GITHUB_REPO: ENV.GITHUB_REPO,
  GITHUB_BRANCH: ENV.GITHUB_BRANCH,
  GITHUB_APP_ID: '1',
  GITHUB_INSTALLATION_ID: '999'
}, async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' });

  const calls = [];
  const original = globalThis.fetch;
  let minted = 0;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/access_tokens')) {
      minted += 1;
      return { ok: true, status: 201, json: async () => ({ token: 'ghs_minted' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) }; // pathExists: not there
  };
  try {
    const request = makeRequest({
      cookie: validCookie(),
      body: { type: 'post', mode: 'create', fields: { title: 'October Recap' }, blocks: [] }
    });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(minted, 1, 'exactly one token minted for this request');
    assert.ok(calls[0].includes('/access_tokens'), 'the mint call must be the first GitHub call');
    // pathExists sees 404 (not-exists), so a create proceeds; the stub then
    // 404s every subsequent call too, so commitWithRetry fails generically.
    // The status code is incidental here -- what this test proves is the
    // mint order and count above.
    assert.equal(response.statusCode, 502);
  } finally {
    globalThis.fetch = original;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  }
}));

test('a malformed App private key is reported distinctly from a GitHub-rejected credential', () => withEnv({
  AUTH_SECRET: ENV.AUTH_SECRET,
  GITHUB_OWNER: ENV.GITHUB_OWNER,
  GITHUB_REPO: ENV.GITHUB_REPO,
  GITHUB_BRANCH: ENV.GITHUB_BRANCH,
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'not a real pem',
  GITHUB_INSTALLATION_ID: '999'
}, async () => {
  const restore = noNetwork();
  try {
    const request = makeRequest({
      cookie: validCookie(),
      body: { type: 'post', mode: 'create', fields: { title: 'October Recap' }, blocks: [] }
    });
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 503);
    assert.match(response.body.message, /key could not be read/);
  } finally {
    restore();
  }
}));
