import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, brevoProvider, resendProvider } from '../lib/mailer.mjs';

const ENV = {
  FORM_FROM_EMAIL: 'site@nycfintechwomen.com',
  FORM_TO_EMAIL: 'team@nycfintechwomen.com'
};

/* Records the request instead of making one. Same shape the publish handler
   tests use, so the exact body each provider sends is asserted, not assumed. */
function recorder(status = 200) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : null
    });
    return { ok: status < 400, status, json: async () => ({}), text: async () => '' };
  };
  impl.calls = calls;
  return impl;
}

const message = {
  subject: 'Co-founder matching — Jane Doe',
  text: 'Name:\nJane Doe\n',
  replyTo: 'jane@example.com'
};

test('brevo sends the documented body shape', async () => {
  const f = recorder(201);
  await brevoProvider({ ...ENV, BREVO_API_KEY: 'k' }, f).send(message);
  const [call] = f.calls;
  assert.equal(call.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(call.headers['api-key'], 'k');
  assert.equal(call.body.sender.email, ENV.FORM_FROM_EMAIL);
  assert.deepEqual(call.body.to, [{ email: ENV.FORM_TO_EMAIL }]);
  assert.equal(call.body.subject, message.subject);
  assert.equal(call.body.textContent, message.text);
  assert.deepEqual(call.body.replyTo, { email: 'jane@example.com' });
  assert.equal(call.body.bcc, undefined, 'bcc must be omitted when unset');
});

test('resend sends the documented body shape', async () => {
  const f = recorder(200);
  await resendProvider({ ...ENV, RESEND_API_KEY: 'k' }, f).send(message);
  const [call] = f.calls;
  assert.equal(call.url, 'https://api.resend.com/emails');
  assert.equal(call.headers.authorization, 'Bearer k');
  assert.match(call.body.from, /<site@nycfintechwomen\.com>$/);
  assert.deepEqual(call.body.to, [ENV.FORM_TO_EMAIL]);
  assert.equal(call.body.text, message.text);
  assert.equal(call.body.reply_to, 'jane@example.com');
});

/* The submitter is the reply-to and never the from. Sending as them fails
   DMARC for their domain and spam-files the notification. */
test('neither provider ever sends AS the submitter', async () => {
  for (const [make, key] of [[brevoProvider, 'BREVO_API_KEY'], [resendProvider, 'RESEND_API_KEY']]) {
    const f = recorder(200);
    await make({ ...ENV, [key]: 'k' }, f).send(message);
    const sent = JSON.stringify(f.calls[0].body);
    const from = f.calls[0].body.from || f.calls[0].body.sender.email;
    assert.ok(!String(from).includes('jane@example.com'), 'submitter used as sender');
    assert.ok(sent.includes('jane@example.com'), 'submitter missing as reply-to');
  }
});

test('bcc is included only when configured', async () => {
  const f = recorder(201);
  await brevoProvider({ ...ENV, BREVO_API_KEY: 'k', FORM_BCC_EMAIL: 'archive@x.com' }, f).send(message);
  assert.deepEqual(f.calls[0].body.bcc, [{ email: 'archive@x.com' }]);
});

test('a rejected credential surfaces as auth, not a generic failure', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(
      () => brevoProvider({ ...ENV, BREVO_API_KEY: 'k' }, recorder(status)).send(message),
      (e) => e.code === 'auth'
    );
  }
});

test('any other non-2xx surfaces as upstream', async () => {
  await assert.rejects(
    () => resendProvider({ ...ENV, RESEND_API_KEY: 'k' }, recorder(500)).send(message),
    (e) => e.code === 'upstream'
  );
});

test('the API key never appears in a thrown message', async () => {
  const KEY = 'super-secret-key-value';
  for (const status of [401, 500]) {
    await brevoProvider({ ...ENV, BREVO_API_KEY: KEY }, recorder(status)).send(message).catch((e) => {
      const blob = String(e.message) + String(e.stack || '');
      assert.ok(!blob.includes(KEY), `key leaked at status ${status}`);
    });
  }
});

test('resolveProvider returns null when nothing is configured', () => {
  assert.equal(resolveProvider({}), null);
  assert.equal(resolveProvider({ BREVO_API_KEY: 'k' }), null, 'a key alone is not enough without an envelope');
  assert.equal(resolveProvider(ENV), null, 'an envelope alone is not enough without a key');
});

test('resolveProvider prefers brevo when both keys are present', () => {
  const p = resolveProvider({ ...ENV, BREVO_API_KEY: 'a', RESEND_API_KEY: 'b' }, recorder());
  assert.equal(p.name, 'brevo');
});

test('FORM_PROVIDER overrides inference, and refuses if that key is missing', () => {
  assert.equal(resolveProvider({ ...ENV, FORM_PROVIDER: 'resend', RESEND_API_KEY: 'b' }, recorder()).name, 'resend');
  assert.equal(
    resolveProvider({ ...ENV, FORM_PROVIDER: 'resend', BREVO_API_KEY: 'a' }, recorder()),
    null,
    'naming a provider whose key is absent must not silently fall through to the other'
  );
});
