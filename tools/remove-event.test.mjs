import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/remove-event.js';

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
function fakeGithub({ existingPaths = [], liveFiles = {}, failOn = {}, onFetch = null }) {
  const calls = [];
  const commits = [];
  const blobs = new Map();
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method, body });
    if (onFetch) onFetch(String(url));
    const { pathname } = new URL(String(url));
    const failure = (key) => failOn[key] ? reply(failOn[key], {}) : null;

    if (pathname.endsWith('/access_tokens')) return failure('mint') || reply(201, { token: 'minted' });

    const contents = pathname.match(/\/contents\/(.+)$/);
    if (contents) {
      if (failure('contents')) return failure('contents');
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
      if (failure('trees')) return failure('trees');
      commits.push({
        files: body.tree.map((entry) => entry.sha === null
          ? { path: entry.path, delete: true }
          : { path: entry.path, content: blobs.get(entry.sha).content, encoding: blobs.get(entry.sha).encoding })
      });
      return reply(201, { sha: 'TREE' });
    }
    if (pathname.endsWith('/git/commits')) return reply(201, { sha: 'NEWCOMMIT' });
    if (pathname.includes('/git/refs/heads/')) return failure('refs') || reply(200, {});
    throw new Error(`unexpected fetch to ${url}`);
  };
  return { fetchImpl, calls, commits };
}

async function removeWithApp(payload, options = {}) {
  const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const keys = ['GITHUB_APP_ID', 'GITHUB_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2', GITHUB_APP_PRIVATE_KEY: appKey });
  try {
    return await remove(payload, { ...options, appCredentials: true });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function remove(payload, { token = true, method = 'POST', existingPaths, liveFiles, failOn, onFetch, appCredentials = false } = {}) {
  const github = fakeGithub({ existingPaths, liveFiles, failOn, onFetch });
  const savedFetch = globalThis.fetch;
  const savedEnv = {};
  for (const key of Object.keys(ENV)) { savedEnv[key] = process.env[key]; process.env[key] = ENV[key]; }
  /* With App credentials the handler mints through fetch, so a mis-ordered
     mint becomes visible as a call; with GITHUB_TOKEN set it makes none. */
  if (appCredentials) delete process.env.GITHUB_TOKEN;
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

/* The only irreversible thing an author can do on this page. The page asks
   them to type the address first; this file makes sure that what gets deleted
   is exactly the event named and nothing else. */

test('a request without a session token is refused', async () => {
  const { response } = await remove({ slug: 'a-mixer' }, { token: null });
  assert.equal(response.status, 401);
});

test('a slug with no file is refused rather than reported as removed', async () => {
  const { response, commits, calls } = await remove({ slug: 'never-existed' });
  assert.equal(response.status, 404);
  assert.equal(commits.length, 0);
  assert.deepEqual(calls.filter((call) => call.method !== 'GET'), []);
});

test('the event file is deleted', async () => {
  const path = 'src/_data/manual-events/a-mixer.json';
  const { response, commits } = await remove({ slug: 'a-mixer' }, {
    liveFiles: { [path]: JSON.stringify({ slug: 'a-mixer', name: 'A Mixer' }) }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(commits[0].files, [{ path, delete: true }]);
});

test('a cover this project wrote goes with it, in the same commit', async () => {
  const path = 'src/_data/manual-events/a-mixer.json';
  const { commits } = await remove({ slug: 'a-mixer' }, {
    liveFiles: { [path]: JSON.stringify({
      slug: 'a-mixer', coverPath: 'images/event-a-mixer.jpg'
    }) }
  });
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].files.map((f) => f.path).sort(), [
    'src/_data/manual-events/a-mixer.json',
    'src/images/event-a-mixer.jpg'
  ]);
  assert.ok(commits[0].files.every((f) => f.delete));
});

test('a png cover is cleaned up as reliably as a jpg one', async () => {
  const path = 'src/_data/manual-events/a-mixer.json';
  const { commits } = await remove({ slug: 'a-mixer' }, {
    liveFiles: { [path]: JSON.stringify({ slug: 'a-mixer', coverPath: 'images/event-a-mixer.png' }) }
  });
  assert.ok(commits[0].files.some((f) => f.path === 'src/images/event-a-mixer.png' && f.delete));
});

test('a partner-hosted cover is left alone', async () => {
  const path = 'src/_data/manual-events/a-mixer.json';
  const { commits } = await remove({ slug: 'a-mixer' }, {
    liveFiles: { [path]: JSON.stringify({
      slug: 'a-mixer', coverUrl: 'https://partner.example.com/cover.jpg'
    }) }
  });
  assert.deepEqual(commits[0].files.map((f) => f.path), [path]);
});

test('a hand-set coverPath pointing somewhere else is left alone', async () => {
  /* It may be an image another page uses. Only a path this project's own
     convention produces is safe to delete. */
  const path = 'src/_data/manual-events/a-mixer.json';
  const { commits } = await remove({ slug: 'a-mixer' }, {
    liveFiles: { [path]: JSON.stringify({ slug: 'a-mixer', coverPath: 'images/fff-shira-amrany.jpg' }) }
  });
  assert.deepEqual(commits[0].files.map((f) => f.path), [path]);
});

test('a traversing slug is slugified before it builds any path', async () => {
  const { response, calls } = await remove({ slug: '../../../etc/passwd' });
  assert.equal(response.status, 404);
  const reads = calls.filter((call) => call.url.includes('/contents/'));
  assert.equal(reads.length, 1);
  assert.equal(
    decodeURIComponent(new URL(reads[0].url).pathname.split('/contents/')[1]),
    'src/_data/manual-events/etc-passwd.json'
  );
  for (const call of calls) {
    assert.ok(!call.url.includes('..') && !call.url.includes('etc/passwd'), call.url);
  }
});

test('a traversing slug whose slugified file exists deletes only that file', async () => {
  const path = 'src/_data/manual-events/lib-github-mjs.json';
  const { response, commits } = await remove({ slug: '../../lib/github.mjs' }, {
    liveFiles: { [path]: JSON.stringify({ slug: 'lib-github-mjs' }) }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(commits[0].files.map((f) => f.path), [path]);
});

test('an empty or unusable slug is refused before GitHub is asked anything', async () => {
  for (const slug of [undefined, '', '   ', '../..', '!!!']) {
    const { response, calls } = await remove({ slug });
    assert.equal(response.status, 400, String(slug));
    assert.equal(calls.length, 0, String(slug));
  }
});

test('a token-stage credential rejection tells the author to contact the site owner', async () => {
  const { response, commits } = await removeWithApp({ slug: 'a-mixer' }, { failOn: { mint: 401 } });
  assert.equal(response.status, 503);
  assert.equal(response.json.message, "The site's GitHub access is not working — contact the site owner.");
  assert.equal(commits.length, 0);
});

test('a branch that moved twice is a 409 the author can read', async () => {
  const path = 'src/_data/manual-events/a-mixer.json';
  const { response } = await remove({ slug: 'a-mixer' }, {
    liveFiles: { [path]: '{}' }, failOn: { refs: 422 }
  });
  assert.equal(response.status, 409);
  assert.equal(response.json.message, 'Someone else just published. Try again.');
});

test('a GET is refused', async () => {
  const { response } = await remove({ slug: 'a-mixer' }, { method: 'GET' });
  assert.equal(response.status, 405);
});

test('a live file that will not parse is still removable, and no cover is matched', async () => {
  const path = 'src/_data/manual-events/a-mixer.json';
  const { response, commits } = await remove({ slug: 'a-mixer' }, {
    liveFiles: { [path]: '{ not json' }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(commits[0].files, [{ path, delete: true }]);
});

test("another event's conventional cover is left alone", async () => {
  const path = 'src/_data/manual-events/a-mixer.json';
  const { commits } = await remove({ slug: 'a-mixer' }, {
    liveFiles: { [path]: JSON.stringify({ slug: 'a-mixer', coverPath: 'images/event-other.jpg' }) }
  });
  assert.deepEqual(commits[0].files.map((f) => f.path), [path]);
});

test('a rejected GitHub credential reads as a site problem, with no GitHub detail', async () => {
  const { response, commits } = await remove({ slug: 'a-mixer' }, { failOn: { contents: 401 } });
  assert.equal(response.status, 503);
  assert.equal(commits.length, 0);
  assert.equal(response.json.message, "The site's GitHub access is not working — contact the site owner.");
});

test('a failed commit says nothing was changed', async () => {
  const path = 'src/_data/manual-events/a-mixer.json';
  const { response } = await remove({ slug: 'a-mixer' }, {
    liveFiles: { [path]: '{}' }, failOn: { trees: 500 }
  });
  assert.equal(response.status, 502);
  assert.match(response.json.message, /Nothing was changed/);
});
