/* Adds a form submitter to a Brevo contact list.
 *
 * Why this is separate from lib/mailer.mjs: that module notifies the team, and
 * this one changes the mailing list. They share a credential and nothing else.
 * Keeping them apart means the notification cannot be broken by a list problem
 * -- which matters because of the order api/form.js calls them in.
 *
 * Why it exists at all: the membership form ends with a checked box reading
 * "Subscribe to NYC Fintech Women communications and get invited to events."
 * Until this module, nothing subscribed anybody -- the answer became a line in
 * an email and the person was told "Welcome in." That is the same failure the
 * co-founder form had, one step further along.
 *
 * Env:
 *   BREVO_API_KEY  - the same transactional key lib/mailer.mjs uses
 *   BREVO_LIST_ID  - the list a membership signup joins. Unset means no
 *                    subscribing, reported by resolveSubscriber() returning
 *                    null rather than by a failure at send time.
 *   BREVO_NOMINATION_LIST_ID - the list an IFF nominator joins. A separate
 *                    list on purpose: nominating a woman is not joining, and
 *                    the two audiences should not be mailed as one.
 */

const TIMEOUT_MS = 8000;
const ENDPOINT = 'https://api.brevo.com/v3/contacts';

/* Brevo rejects attributes that do not exist on the account, and the default
   name attributes are not consistent between accounts -- a list created years
   ago may carry FNAME/LNAME where a new one carries FIRSTNAME/LASTNAME. The
   names below are the current default; if this account differs, the retry
   below still gets the person onto the list without them. */
const NAME_ATTRIBUTES = { first: 'FIRSTNAME', last: 'LASTNAME' };

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function post(key, body, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': key },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    /* 201 is a new contact, 204 an existing one updated because
       updateEnabled is set. Both mean the person is on the list. */
    if (response.status === 201 || response.status === 204 || response.status === 200) return;
    if (response.status === 401 || response.status === 403) {
      throw fail('Brevo rejected the credential', 'auth');
    }
    if (response.status === 400) {
      throw fail('Brevo rejected the contact', 'invalid');
    }
    /* Never the response body: a provider can echo the key back in an error,
       and this reaches a log the whole team can read. */
    throw fail(`Brevo returned ${response.status}`, 'upstream');
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw fail('Brevo did not answer in time', 'timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* Which environment variable names the list for each form. A kind absent from
   this map never subscribes anyone, whatever the submission says -- adding a
   form to the site cannot quietly start adding people to a list. */
const LIST_VAR_BY_KIND = {
  membership: 'BREVO_LIST_ID',
  nomination: 'BREVO_NOMINATION_LIST_ID'
};

/* listVar has no default on purpose. Defaulting it would make the membership
   list the implicit target, so a future call site that forgot the argument
   would write nominators into the members list silently and successfully --
   the exact mixing this per-kind split exists to prevent. Naming the list is
   the caller's job, and getting it wrong throws rather than mis-sends. */
export function brevoSubscriber(env, fetchImpl = fetch, listVar) {
  const key = String(env.BREVO_API_KEY || '').trim();
  const listId = Number(String((listVar && env[listVar]) || '').trim());

  return {
    name: 'brevo',
    async subscribe({ email, firstName, lastName }) {
      if (!email) throw fail('No email address to subscribe', 'invalid');
      /* A bad or unnamed list would be sent as NaN and silently rejected by
         Brevo. Refusing here makes it a caller error, not a lost person. */
      if (!Number.isInteger(listId) || listId <= 0) {
        throw fail('No contact list named for this subscription', 'invalid');
      }

      const attributes = {};
      if (firstName) attributes[NAME_ATTRIBUTES.first] = firstName;
      if (lastName) attributes[NAME_ATTRIBUTES.last] = lastName;

      /* updateEnabled is not optional in practice. Without it, an existing
         contact is a 400 -- and on a list this size the person re-joining or
         updating their details is the ordinary case, not the edge one. */
      const body = { email, listIds: [listId], updateEnabled: true };

      try {
        await post(key, { ...body, attributes }, fetchImpl);
        return { attributed: true };
      } catch (error) {
        /* The attributes are the only part of this request that can be wrong
           in a way the account controls, so a 400 is retried without them.
           Being on the list under the wrong display name is recoverable from
           the notification email; not being on the list is not. */
        if (error.code !== 'invalid' || !Object.keys(attributes).length) throw error;
        await post(key, body, fetchImpl);
        return { attributed: false };
      }
    }
  };
}

/* Returns null when subscribing is not configured for this form, so the caller
   can say so once in a log line rather than treat it as an outage. Each kind
   has its own list: a nomination must not land in the membership list, because
   nominating someone is not joining. */
export function resolveSubscriber(kind, env = process.env, fetchImpl = fetch) {
  const listVar = LIST_VAR_BY_KIND[String(kind || '').trim()];
  if (!listVar) return null;
  const key = String(env.BREVO_API_KEY || '').trim();
  const listId = String(env[listVar] || '').trim();
  if (!key || !listId) return null;
  /* A non-numeric list id would be sent as NaN and rejected on every
     submission. Catching it here makes it a configuration fault, not a
     per-person failure. */
  if (!Number.isInteger(Number(listId)) || Number(listId) <= 0) return null;
  return brevoSubscriber(env, fetchImpl, listVar);
}
