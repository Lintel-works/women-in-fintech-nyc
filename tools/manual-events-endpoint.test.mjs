import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import handler from '../api/manual-events.js';

/* What the events page lists for editing. Read from the branch rather than
   from this function's own bundle: the bundle is as old as the last deploy,
   and an edit form that opens a stale copy writes back a clobber. */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const ENV = {
  CLERK_PEM_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
  CLERK_AUTHORIZED_PARTIES: 'https://nycfintechwomen.com',
  GITHUB_TOKEN: 'ghtoken',
  GITHUB_OWNER: 'owner',
  GITHUB_REPO: 'repo',
  GITHUB_BRANCH: 'main'
};

function bearer() {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    sub: 'user_123', email: 'jane@example.com',
    azp: 'https://nycfintechwomen.com', exp: now + 60, nbf: now - 5
  })}`;
  const sig = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `Bearer ${input}.${sig}`;
}

const DIR = 'src/_data/manual-events';

/* `files` are committed objects, `rawFiles` are literal text; the directory
   listing also carries a .gitkeep and a sub-directory, as the real one does. */
function fakeGithub({ files = {}, rawFiles = {}, failWith = null, listing = null, failFileWith = null, failFile = null }) {
  const texts = { ...rawFiles };
  for (const [name, entry] of Object.entries(files)) texts[name] = JSON.stringify(entry);
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  return async (url) => {
    if (failWith) return reply(failWith, { message: 'ghp_SECRETTOKEN leaked here' });
    const path = decodeURIComponent(new URL(String(url)).pathname.split('/contents/')[1]);
    if (path === DIR) {
      return reply(200, listing || [
        { name: '.gitkeep', type: 'file' },
        { name: 'sub', type: 'dir' },
        ...Object.keys(texts).map((name) => ({ name, type: 'file' }))
      ]);
    }
    const name = path.slice(DIR.length + 1);
    if (failFileWith && name === failFile) return reply(failFileWith, {});
    if (name in texts) return reply(200, { content: Buffer.from(texts[name]).toString('base64') });
    return reply(404, {});
  };
}

async function get({ token = true, method = 'GET', env = {}, ...github } = {}) {
  const savedFetch = globalThis.fetch;
  const savedEnv = {};
  for (const key of Object.keys(ENV)) { savedEnv[key] = process.env[key]; process.env[key] = ENV[key]; }
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  globalThis.fetch = fakeGithub(github);
  const res = {
    statusCode: null, body: null, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  const savedWarn = console.warn;
  const savedError = console.error;
  const logged = [];
  console.warn = (...args) => logged.push(args.join(' '));
  console.error = () => {};
  try {
    await handler({ method, headers: token ? { authorization: bearer() } : {} }, res);
  } finally {
    console.warn = savedWarn;
    console.error = savedError;
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(ENV)) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
  }
  return { status: res.statusCode, json: res.body, logged };
}

test('a request without a session token is refused', async () => {
  const response = await get({ token: false });
  assert.equal(response.status, 401);
});

test('every event file on the branch is listed, and not the .gitkeep', async () => {
  const response = await get({ files: {
    'a-mixer.json': { name: 'A Mixer', slug: 'a-mixer', startAt: '2099-12-01T18:00:00-05:00', url: 'https://example.com/a' },
    'b-panel.json': { name: 'B Panel', slug: 'b-panel', startAt: '2099-12-02T18:00:00-05:00', url: 'https://example.com/b' }
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.events.map((e) => e.slug).sort(), ['a-mixer', 'b-panel']);
  assert.equal(response.json.events[0].over, false);
  assert.equal(response.json.events[0].broken, false);
});

test('each row carries the whole entry, so opening one needs no second request', async () => {
  const entry = {
    name: 'A Mixer', slug: 'a-mixer', startAt: '2099-12-01T18:00:00-05:00',
    url: 'https://example.com/a', place: 'Soho', tags: ['Mixer']
  };
  const response = await get({ files: { 'a-mixer.json': entry } });
  assert.deepEqual(response.json.events[0].entry, entry);
});

test('an event that has already passed is listed, and marked as over', async () => {
  /* The site hides it, but the FILE is still there, and housekeeping is the
     one job that needs to see it. */
  const response = await get({ files: {
    'old.json': { name: 'Last Year', slug: 'old', startAt: '2020-01-01T18:00:00-05:00', url: 'https://example.com/x' }
  } });
  assert.equal(response.json.events.length, 1);
  assert.equal(response.json.events[0].over, true);
});

test('an entry the site would refuse is listed as broken', async () => {
  const response = await get({ files: { 'bad.json': { name: 'No Link', startAt: '2099-12-01T18:00:00-05:00' } } });
  assert.equal(response.json.events[0].broken, true);
});

test('a file that will not parse is skipped with a warning naming it, and the rest still list', async () => {
  const response = await get({
    files: { 'good.json': { name: 'Good', slug: 'good', startAt: '2099-12-01T18:00:00-05:00', url: 'https://example.com/g' } },
    rawFiles: { 'broken.json': '{ not json' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.events.length, 1);
  assert.ok(response.logged.some((line) => line.includes('broken.json')));
});

test('a file that parses but is not a single event object is skipped', async () => {
  const response = await get({
    files: { 'good.json': { name: 'Good', slug: 'good', startAt: '2099-12-01T18:00:00-05:00', url: 'https://example.com/g' } },
    rawFiles: { 'list.json': '[]', 'nothing.json': 'null' }
  });
  assert.deepEqual(response.json.events.map((e) => e.slug), ['good']);
  assert.ok(response.logged.some((line) => line.includes('list.json')));
  assert.ok(response.logged.some((line) => line.includes('nothing.json')));
});

test('a GitHub failure costs the list, not the page, and leaks nothing', async () => {
  const response = await get({ failWith: 500 });
  assert.equal(response.status, 502);
  assert.ok(response.json.message, 'an author-readable sentence, not a stack');
  assert.ok(!JSON.stringify(response.json).includes('ghp_'));
});

test('a POST is refused', async () => {
  const response = await get({ method: 'POST' });
  assert.equal(response.status, 405);
});

const GOOD = (slug) => ({ name: slug, slug, startAt: '2099-12-01T18:00:00-05:00', url: 'https://example.com/g' });

test('a revoked credential on the listing is a 503, not a 502', async () => {
  const response = await get({ failWith: 403 });
  assert.equal(response.status, 503);
  assert.match(response.json.message, /GitHub access is not working/);
});

test('a credential that fails part-way through the files is a 503, not a short list', async () => {
  const response = await get({
    files: { 'a.json': GOOD('a'), 'b.json': GOOD('b') },
    failFile: 'b.json', failFileWith: 403
  });
  assert.equal(response.status, 503);
  assert.match(response.json.message, /GitHub access is not working/);
  assert.equal(response.json.events, undefined);
});

test('a GitHub 500 part-way through the files is a 502, not a short list', async () => {
  const response = await get({
    files: { 'a.json': GOOD('a'), 'b.json': GOOD('b') },
    failFile: 'b.json', failFileWith: 500
  });
  assert.equal(response.status, 502);
  assert.equal(response.json.events, undefined);
});

test('events keep their sorted order however the fetches finish', async () => {
  const response = await get({ files: { 'c.json': GOOD('c'), 'a.json': GOOD('a'), 'b.json': GOOD('b') } });
  assert.deepEqual(response.json.events.map((e) => e.slug), ['a', 'b', 'c']);
});

test('an unauthenticated caller learns nothing about configuration', async () => {
  const saved = process.env.GITHUB_OWNER;
  const response = await get({ token: false, env: { GITHUB_OWNER: '' } });
  assert.equal(response.status, 401);
  assert.equal(process.env.GITHUB_OWNER, saved);
});

test('no GitHub credential at all is a 503 "not set up", not a 502', async () => {
  const response = await get({ env: { GITHUB_TOKEN: '' }, files: {} });
  assert.equal(response.status, 503);
  assert.match(response.json.message, /not set up/);
});

test('an unusable App private key is a 503 naming the key, not a 502', async () => {
  const appEnv = { GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2', GITHUB_APP_PRIVATE_KEY: 'not a real pem' };
  const saved = {};
  for (const key of Object.keys(appEnv)) saved[key] = process.env[key];
  try {
    const response = await get({ env: { GITHUB_TOKEN: '', ...appEnv }, files: {} });
    assert.equal(response.status, 503);
    assert.match(response.json.message, /key could not be read/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
