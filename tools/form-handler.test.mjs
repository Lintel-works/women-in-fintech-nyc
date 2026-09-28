import { test } from 'node:test';
import assert from 'node:assert/strict';

const ENV = {
  FORM_FROM_EMAIL: 'site@nycfintechwomen.com',
  FORM_TO_EMAIL: 'team@nycfintechwomen.com',
  BREVO_API_KEY: 'test-key'
};

function res() {
  const r = { code: null, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  return r;
}

const good = () => ({
  kind: 'co-founder',
  name: 'Jane Doe',
  email: 'jane@example.com',
  role: 'Product Lead',
  vision: 'A tool for reconciling payouts.',
  looking: 'An engineer who has shipped payments.',
  elapsedMs: 9000
});

/* Each test gets a fresh module instance so process.env changes take effect,
   and a counter proving whether the provider was reached at all. */
let n = 0;
async function run(body, env = ENV, sendStatus = 201) {
  n += 1;
  for (const k of ['FORM_PROVIDER', 'BREVO_API_KEY', 'RESEND_API_KEY', 'FORM_FROM_EMAIL', 'FORM_TO_EMAIL', 'FORM_BCC_EMAIL']) {
    delete process.env[k];
  }
  Object.assign(process.env, env);

  let sends = 0;
  globalThis.fetch = async () => {
    sends += 1;
    return { ok: sendStatus < 400, status: sendStatus, json: async () => ({}), text: async () => '' };
  };

  const url = new URL('../api/form.js', import.meta.url).href + '?i=' + n;
  const handler = (await import(url)).default;
  const r = res();
  await handler({ method: 'POST', body, headers: {} }, r);
  return { r, sends };
}

test('a valid submission is sent and acknowledged', async () => {
  const { r, sends } = await run(good());
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(sends, 1);
});

test('a non-POST is refused', async () => {
  n += 1;
  Object.assign(process.env, ENV);
  const url = new URL('../api/form.js', import.meta.url).href + '?i=' + n;
  const handler = (await import(url)).default;
  const r = res();
  await handler({ method: 'GET', body: {}, headers: {} }, r);
  assert.equal(r.code, 405);
  assert.equal(r.headers.allow, 'POST');
});

/* The whole point of this endpoint: a failure must never look like a success,
   because the bug it replaces did exactly that. */
test('a provider failure returns non-2xx and never says ok', async () => {
  for (const [status, expected] of [[401, 503], [500, 502]]) {
    const { r, sends } = await run(good(), ENV, status);
    assert.equal(r.code, expected, `status ${status}`);
    assert.notDeepEqual(r.body, { ok: true });
    assert.match(r.body.message, /could not send|not set up/i);
    assert.equal(sends, 1);
  }
});

test('an unconfigured site says so distinctly and makes no call', async () => {
  const { r, sends } = await run(good(), { FORM_FROM_EMAIL: 'a@b.c', FORM_TO_EMAIL: 'd@e.f' });
  assert.equal(r.code, 503);
  assert.match(r.body.message, /not set up/i);
  assert.equal(sends, 0, 'attempted a send with no provider configured');
});

test('an invalid submission is refused with a readable reason and no send', async () => {
  const body = good();
  delete body.email;
  const { r, sends } = await run(body);
  assert.equal(r.code, 400);
  assert.match(r.body.message, /email/i);
  assert.equal(sends, 0);
});

test('an unknown form kind is refused without sending', async () => {
  const { r, sends } = await run({ ...good(), kind: 'newsletter' });
  assert.equal(r.code, 400);
  assert.equal(sends, 0);
});

/* Silent on purpose: a bot that learns it was caught stops filling the trap. */
test('a filled honeypot looks like success but sends nothing', async () => {
  const { r, sends } = await run({ ...good(), website: 'http://spam.example' });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(sends, 0);
});

test('an impossibly fast submission looks like success but sends nothing', async () => {
  const { r, sends } = await run({ ...good(), elapsedMs: 40 });
  assert.equal(r.code, 200);
  assert.equal(sends, 0);
});

test('a missing or nonsense elapsedMs does not block a real person', async () => {
  for (const elapsedMs of [undefined, null, 'abc', -1]) {
    const body = good();
    if (elapsedMs === undefined) delete body.elapsedMs; else body.elapsedMs = elapsedMs;
    const { r, sends } = await run(body);
    assert.equal(r.code, 200, `blocked on elapsedMs=${elapsedMs}`);
    assert.equal(sends, 1);
  }
});

test('no credential appears in any response body', async () => {
  for (const status of [401, 500, 201]) {
    const { r } = await run(good(), ENV, status);
    assert.ok(!JSON.stringify(r.body).includes('test-key'));
  }
});

test('a hostile body does not throw', async () => {
  for (const body of [null, undefined, 'a string', 42, []]) {
    const { r } = await run(body);
    assert.ok(r.code >= 400, `no status for ${JSON.stringify(body)}`);
  }
});
