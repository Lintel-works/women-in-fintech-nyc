import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import handler from '../api/authors.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });

const ENV = {
  CLERK_PEM_PUBLIC_KEY: PEM,
  CLERK_SECRET_KEY: 'sk_test_x',
  CLERK_AUTHORIZED_PARTIES: 'https://nycfintechwomen.com',
  CLERK_INVITE_REDIRECT_URL: 'https://nycfintechwomen.com/admin/'
};

function withEnv(env, fn) {
  const keys = Object.keys(env);
  const saved = {};
  for (const key of keys) { saved[key] = process.env[key]; process.env[key] = env[key]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

/* Mints a token the way Clerk does so the real verification path runs. */
function bearer(role) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const payload = {
    sub: 'user_admin', email: 'admin@example.com',
    azp: 'https://nycfintechwomen.com', exp: now + 60, nbf: now - 5
  };
  if (role) payload.public_metadata = { role };
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}`;
  const sig = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `Bearer ${input}.${sig}`;
}

function makeResponse() {
  return {
    statusCode: null, headers: {}, body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
}

/* Handlers here take (request, response) and nothing else, so the stub
   replaces globalThis.fetch for one test and is always restored. */
function stubFetch(replies) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : null
    });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    if (next.networkError) throw new Error('network down');
    return {
      ok: next.status < 400,
      status: next.status,
      headers: { get: () => next.retryAfter || null },
      json: async () => next.body || {}
    };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

async function withFetch(replies, fn) {
  const stub = stubFetch(replies);
  try { return await fn(stub); } finally { stub.restore(); }
}

const USERS = [
  { id: 'user_admin', email_addresses: [{ email_address: 'admin@example.com' }], public_metadata: { role: 'admin' } },
  { id: 'user_jane', email_addresses: [{ email_address: 'jane@example.com' }], public_metadata: {} }
];
const listReply = { status: 200, body: USERS };
const getReq = (authorization) => ({ method: 'GET', headers: { authorization } });
const postReq = (authorization, body) => ({ method: 'POST', headers: { authorization }, body });
const wrote = (stub) => stub.calls.some((call) => ['DELETE', 'PATCH'].includes(call.method));

test('an author cannot list', async () => {
  await withEnv(ENV, () => withFetch([], async (stub) => {
    const response = makeResponse();
    await handler(getReq(bearer()), response);
    assert.equal(response.statusCode, 403);
    assert.equal(stub.calls.length, 0);
  }));
});

test('an unauthenticated caller is refused with 401 and never reaches Clerk', async () => {
  await withEnv(ENV, () => withFetch([], async (stub) => {
    const response = makeResponse();
    await handler(getReq(''), response);
    assert.equal(response.statusCode, 401);
    assert.equal(stub.calls.length, 0);
  }));
});

test('missing configuration is a 503 worded about managing authors', async () => {
  await withEnv({ ...ENV, CLERK_PEM_PUBLIC_KEY: '' }, () => withFetch([], async () => {
    const response = makeResponse();
    await handler(getReq(bearer('admin')), response);
    assert.equal(response.statusCode, 503);
    assert.match(response.body.message, /author/i);
    assert.doesNotMatch(response.body.message, /publishing/i);
  }));
});

test('an admin sees every author with their role', async () => {
  await withEnv(ENV, () => withFetch([listReply], async () => {
    const response = makeResponse();
    await handler(getReq(bearer('admin')), response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.authors, [
      { id: 'user_admin', email: 'admin@example.com', role: 'admin' },
      { id: 'user_jane', email: 'jane@example.com', role: 'author' }
    ]);
  }));
});

test('promoting an author calls the dedicated metadata endpoint', async () => {
  await withEnv(ENV, () => withFetch([listReply, { status: 200, body: {} }], async (stub) => {
    const response = makeResponse();
    await handler(postReq(bearer('admin'), { action: 'promote', id: 'user_jane' }), response);
    assert.equal(response.statusCode, 204);
    const patch = stub.calls.find((call) => call.method === 'PATCH');
    assert.ok(patch, 'a PATCH must be sent');
    /* Not /v1/users/{id}: as of Clerk API version 2026-05-12 that endpoint
       ignores public_metadata while still returning 200, so the role would
       silently never be set. */
    assert.equal(patch.url, 'https://api.clerk.com/v1/users/user_jane/metadata');
    assert.deepEqual(patch.body, { public_metadata: { role: 'admin' } });
  }));
});

test('demoting an admin clears the role when another admin exists', async () => {
  const twoAdmins = { status: 200, body: [USERS[0], { ...USERS[1], public_metadata: { role: 'admin' } }] };
  await withEnv(ENV, () => withFetch([twoAdmins, { status: 200, body: {} }], async (stub) => {
    const response = makeResponse();
    await handler(postReq(bearer('admin'), { action: 'demote', id: 'user_jane' }), response);
    assert.equal(response.statusCode, 204);
    const patch = stub.calls.find((call) => call.method === 'PATCH');
    assert.equal(patch.url, 'https://api.clerk.com/v1/users/user_jane/metadata');
    assert.deepEqual(patch.body, { public_metadata: { role: null } });
  }));
});

test('removing an ordinary author deletes the user', async () => {
  await withEnv(ENV, () => withFetch([listReply, { status: 200, body: {} }], async (stub) => {
    const response = makeResponse();
    await handler(postReq(bearer('admin'), { action: 'remove', id: 'user_jane' }), response);
    assert.equal(response.statusCode, 204);
    const del = stub.calls.find((call) => call.method === 'DELETE');
    assert.equal(del.url, 'https://api.clerk.com/v1/users/user_jane');
  }));
});

/* The one invariant. Stated as "at least one admin must remain" rather than
   "an admin may not remove themselves", because the handoff case REQUIRES
   self-removal: promote a client admin, then step out. A self-removal guard
   would have blocked exactly that. */
test('the last admin cannot be removed or demoted', async () => {
  for (const action of ['remove', 'demote']) {
    await withEnv(ENV, () => withFetch([listReply], async (stub) => {
      const response = makeResponse();
      await handler(postReq(bearer('admin'), { action, id: 'user_admin' }), response);
      assert.equal(response.statusCode, 409, `${action} of the last admin must be refused`);
      assert.match(response.body.message, /last admin/i);
      assert.ok(!wrote(stub), 'nothing may be written when the invariant would break');
    }));
  }
});

test('an admin may remove or demote themselves once another admin exists', async () => {
  const twoAdmins = { status: 200, body: [USERS[0], { ...USERS[1], public_metadata: { role: 'admin' } }] };
  for (const [action, method] of [['remove', 'DELETE'], ['demote', 'PATCH']]) {
    await withEnv(ENV, () => withFetch([twoAdmins, { status: 200, body: {} }], async (stub) => {
      const response = makeResponse();
      await handler(postReq(bearer('admin'), { action, id: 'user_admin' }), response);
      assert.equal(response.statusCode, 204);
      assert.ok(stub.calls.some((call) => call.method === method && call.url.includes('user_admin')));
    }));
  }
});

test('the invariant reads the list fresh on every write', async () => {
  // Same handler, two writes: the second sees the state the first left, so
  // two admins stepping down in turn cannot both be told it is safe.
  const twoAdmins = [USERS[0], { ...USERS[1], public_metadata: { role: 'admin' } }];
  const oneAdmin = [USERS[0], USERS[1]];
  await withEnv(ENV, () => withFetch([
    { status: 200, body: twoAdmins }, { status: 200, body: {} },
    { status: 200, body: oneAdmin }
  ], async (stub) => {
    const first = makeResponse();
    await handler(postReq(bearer('admin'), { action: 'demote', id: 'user_jane' }), first);
    assert.equal(first.statusCode, 204);
    const second = makeResponse();
    await handler(postReq(bearer('admin'), { action: 'remove', id: 'user_admin' }), second);
    assert.equal(second.statusCode, 409);
    assert.equal(stub.calls.filter((call) => call.method === 'GET').length, 2);
  }));
});

test('an unknown action is refused before anything is read or written', async () => {
  await withEnv(ENV, () => withFetch([], async (stub) => {
    const response = makeResponse();
    await handler(postReq(bearer('admin'), { action: 'drop-table', id: 'user_jane' }), response);
    assert.equal(response.statusCode, 400);
    assert.equal(stub.calls.length, 0);
  }));
});

test('an unknown author is a 404', async () => {
  await withEnv(ENV, () => withFetch([listReply], async (stub) => {
    const response = makeResponse();
    await handler(postReq(bearer('admin'), { action: 'remove', id: 'user_nobody' }), response);
    assert.equal(response.statusCode, 404);
    assert.ok(!wrote(stub));
  }));
});

test('a rejected secret key (401 or 403) is a 503 not-set-up, not a retryable 502', async () => {
  for (const status of [401, 403]) {
    await withEnv(ENV, () => withFetch([{ status }], async () => {
      const response = makeResponse();
      await handler(getReq(bearer('admin')), response);
      assert.equal(response.statusCode, 503, `Clerk ${status} must read as a fault`);
      assert.match(response.body.message, /author/i);
    }));
  }
});

test('Clerk 5xx and network failure are a retryable 502', async () => {
  for (const reply of [{ status: 500 }, { networkError: true }]) {
    await withEnv(ENV, () => withFetch([reply], async () => {
      const response = makeResponse();
      await handler(getReq(bearer('admin')), response);
      assert.equal(response.statusCode, 502);
    }));
  }
});

test('other methods are refused with Allow', async () => {
  await withEnv(ENV, () => withFetch([], async () => {
    const response = makeResponse();
    await handler({ method: 'PUT', headers: {} }, response);
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.Allow, 'GET, POST');
  }));
});
