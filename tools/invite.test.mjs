import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import handler from '../api/invite.js';

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

const req = (authorization, body) => ({ method: 'POST', headers: { authorization }, body });

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

const OK = { status: 200, body: { id: 'inv_1' } };

test('an author cannot invite', async () => {
  await withEnv(ENV, () => withFetch([], async (stub) => {
    const response = makeResponse();
    await handler(req(bearer(), { email: 'new@example.com' }), response);
    assert.equal(response.statusCode, 403);
    assert.equal(stub.calls.length, 0, 'a non-admin must never reach Clerk');
  }));
});

test('an unauthenticated caller is refused with 401 and never reaches Clerk', async () => {
  await withEnv(ENV, () => withFetch([], async (stub) => {
    const response = makeResponse();
    await handler(req('', { email: 'new@example.com' }), response);
    assert.equal(response.statusCode, 401);
    assert.equal(stub.calls.length, 0);
  }));
});

test('an admin invites and the request reaches Clerk correctly', async () => {
  await withEnv(ENV, () => withFetch([OK], async (stub) => {
    const response = makeResponse();
    await handler(req(bearer('admin'), { email: ' New@Example.com ' }), response);
    assert.equal(response.statusCode, 204);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'https://api.clerk.com/v1/invitations');
    assert.equal(stub.calls[0].method, 'POST');
    assert.match(stub.calls[0].headers.Authorization, /^Bearer sk_test_x$/);
    assert.equal(stub.calls[0].body.email_address, 'new@example.com', 'trimmed and lowercased');
    assert.equal(stub.calls[0].body.redirect_url, ENV.CLERK_INVITE_REDIRECT_URL);
  }));
});

test('a malformed email is refused before Clerk is called', async () => {
  for (const email of ['', '   ', 'nope', 'a@', '@b.com']) {
    await withEnv(ENV, () => withFetch([], async (stub) => {
      const response = makeResponse();
      await handler(req(bearer('admin'), { email }), response);
      assert.equal(response.statusCode, 400, `${JSON.stringify(email)} must be refused`);
      assert.equal(stub.calls.length, 0, 'a bad address must not spend one of the 100 hourly invitations');
    }));
  }
});

test('an already-invited address reports plainly', async () => {
  await withEnv(ENV, () => withFetch([{ status: 422, body: { errors: [{ code: 'duplicate_record' }] } }], async () => {
    const response = makeResponse();
    await handler(req(bearer('admin'), { email: 'dupe@example.com' }), response);
    assert.equal(response.statusCode, 409);
    assert.match(response.body.message, /already/i);
  }));
});

test("Clerk's 100-per-hour invitation limit surfaces as retryable", async () => {
  await withEnv(ENV, () => withFetch([{ status: 429, body: {}, retryAfter: '900' }], async () => {
    const response = makeResponse();
    await handler(req(bearer('admin'), { email: 'x@example.com' }), response);
    assert.equal(response.statusCode, 429);
    assert.match(response.body.message, /try again/i);
    assert.equal(response.headers['Retry-After'], '900');
  }));
});

/* Clerk being down is not Clerk being unconfigured. Reporting a 500 as "not
   set up" sends the operator to the environment variables, which are fine. */
test('Clerk being unreachable is a temporary failure, not a misconfiguration', async () => {
  for (const reply of [{ networkError: true }, { status: 500, body: {} }]) {
    await withEnv(ENV, () => withFetch([reply], async () => {
      const response = makeResponse();
      await handler(req(bearer('admin'), { email: 'x@example.com' }), response);
      assert.equal(response.statusCode, 502);
      assert.match(response.body.message, /try again/i);
      assert.doesNotMatch(response.body.message, /not set up/i);
    }));
  }
});

test('a Clerk 401 or 403 is a configuration fault, not a retryable glitch', async () => {
  for (const status of [401, 403]) {
    await withEnv(ENV, () => withFetch([{ status, body: {} }], async () => {
      const response = makeResponse();
      await handler(req(bearer('admin'), { email: 'x@example.com' }), response);
      assert.equal(response.statusCode, 503);
      assert.match(response.body.message, /not set up/i);
      assert.doesNotMatch(response.body.message, /try again/i);
    }));
  }
});

test('an unauthenticated caller cannot learn whether the secret key is set', async () => {
  await withEnv({ ...ENV, CLERK_SECRET_KEY: '' }, () => withFetch([], async () => {
    const response = makeResponse();
    await handler(req('', { email: 'x@example.com' }), response);
    assert.equal(response.statusCode, 401);
  }));
});

test('a missing CLERK_SECRET_KEY is a configuration fault, worded for inviting', async () => {
  await withEnv({ ...ENV, CLERK_SECRET_KEY: '' }, () => withFetch([], async (stub) => {
    const response = makeResponse();
    await handler(req(bearer('admin'), { email: 'x@example.com' }), response);
    assert.equal(response.statusCode, 503);
    assert.match(response.body.message, /inviting/i);
    assert.equal(stub.calls.length, 0);
  }));
});

test('a missing public key is a 503 worded for inviting, not for publishing', async () => {
  await withEnv({ ...ENV, CLERK_PEM_PUBLIC_KEY: '' }, () => withFetch([], async (stub) => {
    const response = makeResponse();
    await handler(req(bearer('admin'), { email: 'x@example.com' }), response);
    assert.equal(response.statusCode, 503);
    assert.doesNotMatch(response.body.message, /publishing/i);
    assert.equal(stub.calls.length, 0);
  }));
});

test('GET is refused with 405', async () => {
  const response = makeResponse();
  await handler({ method: 'GET', headers: {} }, response);
  assert.equal(response.statusCode, 405);
});
