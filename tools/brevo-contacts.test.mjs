import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSubscriber, brevoSubscriber } from '../lib/brevo-contacts.mjs';

const ENV = { BREVO_API_KEY: 'k', BREVO_LIST_ID: '7' };

/* Records the request instead of making one, the same shape
   tools/mailer.test.mjs uses. `statuses` is consumed one per call, so the
   retry path can be given a 400 followed by a 201. */
function recorder(...statuses) {
  const calls = [];
  const queue = statuses.length ? [...statuses] : [201];
  const impl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : null
    });
    const status = queue.length > 1 ? queue.shift() : queue[0];
    return { ok: status < 400, status, json: async () => ({}), text: async () => '' };
  };
  impl.calls = calls;
  return impl;
}

const person = { email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe' };

test('sends the documented create-contact body', async () => {
  const f = recorder(201);
  const result = await brevoSubscriber(ENV, f, 'BREVO_LIST_ID').subscribe(person);
  const [call] = f.calls;
  assert.equal(call.url, 'https://api.brevo.com/v3/contacts');
  assert.equal(call.headers['api-key'], 'k');
  assert.equal(call.body.email, 'jane@example.com');
  assert.deepEqual(call.body.listIds, [7], 'the list id must be a number, not a string');
  assert.deepEqual(call.body.attributes, { FIRSTNAME: 'Jane', LASTNAME: 'Doe' });
  assert.equal(result.attributed, true);
});

/* Without updateEnabled, Brevo answers 400 for a contact it already holds.
   On a list this size the returning member is the ordinary case, so this is
   the single most important field in the request. */
test('always sets updateEnabled so an existing member is not a failure', async () => {
  const f = recorder(201);
  await brevoSubscriber(ENV, f, 'BREVO_LIST_ID').subscribe(person);
  assert.equal(f.calls[0].body.updateEnabled, true);
});

test('204 counts as subscribed — it is how Brevo reports an update', async () => {
  const f = recorder(204);
  const result = await brevoSubscriber(ENV, f, 'BREVO_LIST_ID').subscribe(person);
  assert.equal(result.attributed, true);
  assert.equal(f.calls.length, 1, 'a 204 must not trigger the retry');
});

/* The account's name attributes may be FNAME/LNAME rather than the defaults
   this module sends, and Brevo rejects attributes it does not hold. Being on
   the list under no name is recoverable from the notification email; not
   being on the list is not. */
test('a 400 retries without attributes so the person still lands on the list', async () => {
  const f = recorder(400, 201);
  const result = await brevoSubscriber(ENV, f, 'BREVO_LIST_ID').subscribe(person);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].body.attributes, undefined, 'the retry must drop attributes');
  assert.equal(f.calls[1].body.email, 'jane@example.com');
  assert.deepEqual(f.calls[1].body.listIds, [7]);
  assert.equal(result.attributed, false, 'the caller must be able to log the missing name');
});

test('a 400 with no attributes to drop is not retried', async () => {
  const f = recorder(400);
  await assert.rejects(
    () => brevoSubscriber(ENV, f, 'BREVO_LIST_ID').subscribe({ email: 'jane@example.com' }),
    (error) => error.code === 'invalid'
  );
  assert.equal(f.calls.length, 1);
});

test('a rejected credential is distinguishable from an outage', async () => {
  const f = recorder(401);
  await assert.rejects(() => brevoSubscriber(ENV, f, 'BREVO_LIST_ID').subscribe(person), (e) => e.code === 'auth');
  const g = recorder(500);
  await assert.rejects(() => brevoSubscriber(ENV, g, 'BREVO_LIST_ID').subscribe(person), (e) => e.code === 'upstream');
});

/* Never the response body: a provider can echo the key back in an error, and
   the message reaches a log the whole team can read. */
test('no error message can carry the credential', async () => {
  const f = recorder(500);
  await assert.rejects(
    () => brevoSubscriber({ ...ENV, BREVO_API_KEY: 'super-secret' }, f, 'BREVO_LIST_ID').subscribe(person),
    (error) => !/super-secret/.test(error.message)
  );
});

test('subscribing with no address is refused before any request', async () => {
  const f = recorder(201);
  await assert.rejects(
    () => brevoSubscriber(ENV, f, 'BREVO_LIST_ID').subscribe({ firstName: 'Jane' }),
    (e) => e.code === 'invalid'
  );
  assert.equal(f.calls.length, 0);
});

test('resolveSubscriber needs both the key and the list', () => {
  assert.ok(resolveSubscriber('membership', ENV));
  assert.equal(resolveSubscriber('membership', { BREVO_API_KEY: 'k' }), null, 'no list id');
  assert.equal(resolveSubscriber('membership', { BREVO_LIST_ID: '7' }), null, 'no key');
  assert.equal(resolveSubscriber('membership', {}), null);
});

/* A non-numeric list id would be sent as NaN and rejected on every single
   submission. Refusing it up front makes it one configuration fault rather
   than a per-person failure. */
test('resolveSubscriber refuses a list id that is not a positive integer', () => {
  for (const BREVO_LIST_ID of ['main-list', '0', '-3', '7.5', '']) {
    assert.equal(resolveSubscriber('membership', { BREVO_API_KEY: 'k', BREVO_LIST_ID }), null, BREVO_LIST_ID);
  }
});

/* Nominating a woman is not joining, so the two audiences must not be mailed
   as one. Each kind reads its own variable. */
test('each form kind resolves its own list', async () => {
  const env = { BREVO_API_KEY: 'k', BREVO_LIST_ID: '3', BREVO_NOMINATION_LIST_ID: '9' };

  const f = recorder(201);
  await resolveSubscriber('membership', env, f).subscribe(person);
  assert.deepEqual(f.calls[0].body.listIds, [3]);

  const g = recorder(201);
  await resolveSubscriber('nomination', env, g).subscribe(person);
  assert.deepEqual(g.calls[0].body.listIds, [9], 'a nomination must not land in the members list');
});

test('a kind with no list configured subscribes nobody', () => {
  const env = { BREVO_API_KEY: 'k', BREVO_LIST_ID: '3' };
  assert.equal(resolveSubscriber('nomination', env), null, 'nomination list unset');
  assert.ok(resolveSubscriber('membership', env), 'membership is unaffected');
});

/* An unknown kind can never subscribe anyone, whatever it claims. Adding a
   form to the site must not quietly start adding people to a list. */
test('an unrecognised kind never subscribes anyone', () => {
  const env = { BREVO_API_KEY: 'k', BREVO_LIST_ID: '3', BREVO_NOMINATION_LIST_ID: '9' };
  for (const kind of ['co-founder', 'whatever', '', null, undefined]) {
    assert.equal(resolveSubscriber(kind, env), null, String(kind));
  }
});

/* The list is the caller's responsibility. Defaulting it would make the
   members list the implicit target for a call site that forgot — the exact
   mixing the per-kind split exists to prevent. */
test('a subscriber with no list named refuses rather than guessing', async () => {
  const f = recorder(201);
  await assert.rejects(
    () => brevoSubscriber(ENV, f).subscribe(person),
    (error) => error.code === 'invalid'
  );
  assert.equal(f.calls.length, 0, 'nothing may be sent without a named list');
});
