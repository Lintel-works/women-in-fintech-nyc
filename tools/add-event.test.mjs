import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { eventPathFor, coverPathFor } from '../api/add-event.js';

/* The only other code in this project that can write to the repository.
   Everything local and pure runs before the first network call, for the
   reason api/publish.js records: a bad image should never cost a GitHub round
   trip, and an author with a too-large photo should never be told "GitHub is
   down" when GitHub was never asked. */

import { generateKeyPairSync, createSign } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const ENV = {
  CLERK_PEM_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
  CLERK_AUTHORIZED_PARTIES: 'https://nycfintechwomen.com',
  GITHUB_TOKEN: 'ghtoken',
  GITHUB_OWNER: 'owner',
  GITHUB_REPO: 'repo',
  GITHUB_BRANCH: 'main'
};

/* Mints a token the way Clerk does -- RS256, azp matching the configured
   origin -- so the handler's real verification path runs rather than a stub. */
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

/* A fake GitHub. Records every call, serves the live-file read from
   `liveFiles` (and "exists" from `existingPaths`), and reconstructs each
   commit's files from the blobs and tree it was sent, so a test can assert on
   what was committed rather than on the call choreography. */
function fakeGithub({ existingPaths = [], liveFiles = {} }) {
  const calls = [];
  const commits = [];
  const blobs = new Map();
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method, body });
    const { pathname } = new URL(String(url));

    const contents = pathname.match(/\/contents\/(.+)$/);
    if (contents) {
      const path = decodeURIComponent(contents[1]);
      if (path in liveFiles) {
        return reply(200, { content: Buffer.from(liveFiles[path]).toString('base64') });
      }
      if (existingPaths.includes(path)) {
        return reply(200, { content: Buffer.from('{}').toString('base64') });
      }
      return reply(404, {});
    }
    if (pathname.includes('/git/ref/heads/')) return reply(200, { object: { sha: 'HEAD' } });
    if (pathname.includes('/git/commits/')) return reply(200, { tree: { sha: 'BASE' } });
    if (pathname.endsWith('/git/blobs')) {
      const sha = `BLOB${blobs.size}`;
      blobs.set(sha, body);
      return reply(201, { sha });
    }
    if (pathname.endsWith('/git/trees')) {
      commits.push({
        files: body.tree.map((entry) => entry.sha === null
          ? { path: entry.path, delete: true }
          : { path: entry.path, content: blobs.get(entry.sha).content, encoding: blobs.get(entry.sha).encoding })
      });
      return reply(201, { sha: 'TREE' });
    }
    if (pathname.endsWith('/git/commits')) return reply(201, { sha: 'NEWCOMMIT' });
    if (pathname.includes('/git/refs/heads/')) return reply(200, {});
    throw new Error(`unexpected fetch to ${url}`);
  };
  return { fetchImpl, calls, commits };
}

async function post(payload, { token = true, method = 'POST', existingPaths, liveFiles } = {}) {
  const github = fakeGithub({ existingPaths, liveFiles });
  const savedFetch = globalThis.fetch;
  const savedEnv = {};
  for (const key of Object.keys(ENV)) { savedEnv[key] = process.env[key]; process.env[key] = ENV[key]; }
  globalThis.fetch = github.fetchImpl;
  const res = {
    statusCode: null, body: null, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  try {
    await handler({ method, headers: token ? { authorization: bearer() } : {}, body: payload }, res);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(ENV)) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
  }
  return {
    response: { status: res.statusCode, json: res.body },
    commits: github.commits,
    calls: github.calls
  };
}

const future = '2026-12-01T18:00:00-05:00';

const body = (extra) => Object.assign({
  event: {
    name: 'Fintech Forward with SVB',
    startAt: future,
    endAt: '2026-12-01T20:30:00-05:00',
    url: 'https://www.svb.com/events/fintech-forward',
    city: 'nyc',
    place: 'SVB, 1 Hudson Yards',
    locationType: 'offline',
    tags: ['Partner event']
  }
}, extra || {});

test('a request without a session token is refused', async () => {
  const { response, calls } = await post(body(), { token: false });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test('a valid event is committed as its own file', async () => {
  const { response, commits } = await post(body());
  assert.equal(response.status, 200);
  assert.equal(response.json.slug, 'fintech-forward-with-svb');
  const paths = commits[0].files.map((f) => f.path);
  assert.deepEqual(paths, ['src/_data/manual-events/fintech-forward-with-svb.json']);
  const written = JSON.parse(commits[0].files[0].content);
  assert.equal(written.slug, 'fintech-forward-with-svb');
  assert.equal(written.name, 'Fintech Forward with SVB');
});

test('the event and its cover land in one commit', async () => {
  const { response, commits } = await post(body({
    image: { base64: Buffer.from('fake jpeg bytes').toString('base64'), ext: 'jpg' }
  }));
  assert.equal(response.status, 200);
  assert.equal(commits.length, 1, 'an event must never be live with a missing cover');
  assert.deepEqual(commits[0].files.map((f) => f.path), [
    'src/_data/manual-events/fintech-forward-with-svb.json',
    'src/images/event-fintech-forward-with-svb.jpg'
  ]);
  const written = JSON.parse(commits[0].files[0].content);
  assert.equal(written.coverPath, 'images/event-fintech-forward-with-svb.jpg');
});

test('coverPath is derived here, never taken from the request', async () => {
  const { commits } = await post(body({
    event: Object.assign(body().event, { coverPath: 'images/something-else.jpg' }),
    image: { base64: Buffer.from('bytes').toString('base64'), ext: 'png' }
  }));
  const written = JSON.parse(commits[0].files[0].content);
  assert.equal(written.coverPath, 'images/event-fintech-forward-with-svb.png');
});

test('create onto an existing slug is refused, not overwritten', async () => {
  const { response, commits } = await post(body(), { existingPaths: [
    'src/_data/manual-events/fintech-forward-with-svb.json'
  ] });
  assert.equal(response.status, 409);
  assert.equal(commits.length, 0);
  assert.match(response.json.message, /already/i);
});

test('update onto a slug with no file is refused', async () => {
  /* It means the event was removed since the author opened it. Writing it
     back would quietly resurrect something somebody deliberately took down. */
  const { response, commits } = await post(body({ mode: 'update' }));
  assert.equal(response.status, 409);
  assert.equal(commits.length, 0);
});

test('update writes over the existing file', async () => {
  const path = 'src/_data/manual-events/fintech-forward-with-svb.json';
  const { response, commits } = await post(
    body({ mode: 'update', event: Object.assign(body().event, { place: 'Moved to the 4th floor' }) }),
    { existingPaths: [path], liveFiles: { [path]: JSON.stringify({ slug: 'fintech-forward-with-svb' }) } });
  assert.equal(response.status, 200);
  assert.deepEqual(commits[0].files.map((f) => f.path), [path]);
  assert.equal(JSON.parse(commits[0].files[0].content).place, 'Moved to the 4th floor');
});

/* Review Focus 2 */
test('the mode check runs on the slugified slug', async () => {
  const { response, commits } = await post(
    body({ event: Object.assign(body().event, { name: 'SVB — Fintech Forward!' }) }),
    { existingPaths: ['src/_data/manual-events/svb-fintech-forward.json'] });
  assert.equal(response.status, 409, 'a punctuation-only difference is the same file');
  assert.equal(commits.length, 0);
});

test('an update with no new image keeps the live cover', async () => {
  const path = 'src/_data/manual-events/fintech-forward-with-svb.json';
  const { commits } = await post(
    body({ mode: 'update' }),
    { existingPaths: [path], liveFiles: { [path]: JSON.stringify({
      slug: 'fintech-forward-with-svb',
      coverPath: 'images/event-fintech-forward-with-svb.jpg'
    }) } });
  const written = JSON.parse(commits[0].files[0].content);
  assert.equal(written.coverPath, 'images/event-fintech-forward-with-svb.jpg',
    'an author fixing a time must not lose the cover by not re-uploading it');
});

test('an update whose new cover changes extension deletes the old one', async () => {
  const path = 'src/_data/manual-events/fintech-forward-with-svb.json';
  const { commits } = await post(
    body({ mode: 'update', image: { base64: Buffer.from('bytes').toString('base64'), ext: 'png' } }),
    { existingPaths: [path], liveFiles: { [path]: JSON.stringify({
      slug: 'fintech-forward-with-svb',
      coverPath: 'images/event-fintech-forward-with-svb.jpg'
    }) } });
  const files = commits[0].files;
  assert.ok(files.some((f) => f.path === 'src/images/event-fintech-forward-with-svb.png' && !f.delete));
  assert.ok(files.some((f) => f.path === 'src/images/event-fintech-forward-with-svb.jpg' && f.delete),
    'or the jpg sits in src/images/ forever with nothing pointing at it');
});

test('an update does not delete a partner-hosted cover', async () => {
  const path = 'src/_data/manual-events/fintech-forward-with-svb.json';
  const { commits } = await post(
    body({ mode: 'update', image: { base64: Buffer.from('bytes').toString('base64'), ext: 'png' } }),
    { existingPaths: [path], liveFiles: { [path]: JSON.stringify({
      slug: 'fintech-forward-with-svb',
      coverUrl: 'https://partner.example.com/cover.jpg'
    }) } });
  assert.ok(!commits[0].files.some((f) => f.delete), 'it is not ours to delete');
});

/* Review Focus 1 */
test('an event that has already finished is refused with its own sentence', async () => {
  const { response, commits } = await post(body({
    event: Object.assign(body().event, {
      startAt: '2020-01-01T18:00:00-05:00',
      endAt: '2020-01-01T20:00:00-05:00'
    })
  }));
  assert.equal(response.status, 400);
  assert.equal(commits.length, 0);
  assert.match(response.json.message, /past|already|finished/i);
});

test('an event the normaliser refuses is refused, naming the field', async () => {
  const { response } = await post(body({
    event: Object.assign(body().event, { url: 'http://insecure.example.com/rsvp' })
  }));
  assert.equal(response.status, 400);
  assert.match(response.json.message, /url/i);
});

test('an oversized cover is refused with no GitHub call', async () => {
  const { response, calls } = await post(body({
    image: { base64: 'A'.repeat(4_200_000), ext: 'jpg' }
  }));
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0, 'GitHub must never be asked about a bad image');
});

/* Review Focus 5 */
test('a data: URI prefix in the base64 is refused with no GitHub call', async () => {
  const { response, calls } = await post(body({
    image: {
      base64: 'data:image/jpeg;base64,' + Buffer.from('bytes').toString('base64'),
      ext: 'jpg'
    }
  }));
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test('a cover that is not a jpg or png is refused with no GitHub call', async () => {
  const { response, calls } = await post(body({
    image: { base64: Buffer.from('bytes').toString('base64'), ext: 'webp' }
  }));
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test('a traversing slug cannot escape the events directory', async () => {
  for (const name of ['../../../etc/passwd', '../../lib/github.mjs']) {
    const { response, commits } = await post(body({
      event: Object.assign(body().event, { slug: name })
    }));
    /* Either refused outright, or slugified into harmlessness -- never a path
       outside src/_data/manual-events/. */
    for (const file of (commits[0] ? commits[0].files : [])) {
      assert.ok(file.path.startsWith('src/_data/manual-events/') ||
                file.path.startsWith('src/images/'), file.path);
      assert.ok(!file.path.includes('..'), file.path);
    }
    assert.ok(response.status === 400 || response.status === 200);
  }
});

test('a GET is refused', async () => {
  const { response } = await post(body(), { method: 'GET' });
  assert.equal(response.status, 405);
});

test('the committed file survives a round trip to a rendered event', async () => {
  const { commits } = await post(body());
  const written = JSON.parse(commits[0].files[0].content);
  const { normalizeManualEvents } = await import('../lib/event-entry.mjs');
  const [event] = normalizeManualEvents([written], new Date('2026-06-01T12:00:00Z'));
  assert.ok(event, 'the endpoint must never write a file the renderer drops');
  assert.equal(event.id, 'manual-fintech-forward-with-svb');
  assert.equal(event.city, 'nyc');
  assert.equal(event.url, 'https://www.svb.com/events/fintech-forward');
});

test('the path helpers agree with what the handler writes', () => {
  assert.equal(eventPathFor('a-slug'), 'src/_data/manual-events/a-slug.json');
  assert.equal(coverPathFor('a-slug', 'png'), 'images/event-a-slug.png');
});