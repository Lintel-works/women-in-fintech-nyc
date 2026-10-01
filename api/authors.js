/* GET  /api/authors — list every author and their role.
 * POST /api/authors — remove an author, or change whether they are an admin.
 *
 * Both are admin-only. This exists so a client-side admin can manage authors
 * without a Clerk account of their own: /admin is the only place they sign
 * in, and sending them to Clerk's dashboard for the one urgent operation --
 * revoking someone who has left -- would defeat that.
 *
 * Env: the same as api/invite.js, minus CLERK_INVITE_REDIRECT_URL.
 */
import { authenticateClerkRequest, callClerk, clerkFailure } from '../lib/clerk-request.mjs';
import { isAdmin } from '../lib/clerk-jwt.mjs';

const USERS_URL = 'https://api.clerk.com/v1/users';
// Clerk's maximum page size. Fewer than every user would let the admin count
// come up short; that errs toward refusing, but an author past the page would
// also be invisible here.
const PAGE_LIMIT = 500;
const ACTIONS = new Set(['remove', 'promote', 'demote']);

const NOT_SET_UP = 'Managing authors is not set up on this site yet.';
const UNREACHABLE = 'Could not reach the sign-in service. Try again in a minute.';

function clerkError(status) {
  return Object.assign(new Error(`Clerk answered ${status}`), { code: 'clerk', status });
}

async function callClerkOk(url, secretKey, options) {
  const reply = await callClerk(url, secretKey, options);
  if (!reply.ok) throw clerkError(reply.status);
  return reply;
}

async function listAuthors(secretKey) {
  const reply = await callClerkOk(`${USERS_URL}?limit=${PAGE_LIMIT}`, secretKey);
  const users = await reply.json();
  return users.map((user) => ({
    id: user.id,
    email: user.email_addresses && user.email_addresses[0]
      ? user.email_addresses[0].email_address
      : '',
    role: user.public_metadata && user.public_metadata.role === 'admin' ? 'admin' : 'author',
    state: user.banned ? 'banned' : user.locked ? 'locked' : 'active'
  }));
}

/* An admin who cannot sign in does not count: "at least one admin remains"
   would otherwise pass on a technicality while the site is stranded. */
const isActiveAdmin = (author) => author.role === 'admin' && author.state === 'active';

const STRANDED = 'That change went through, but the site may now have no admin and this could not be confirmed or fixed automatically. '
  + 'Contact the site owner: they can restore an admin from the Clerk dashboard.';

function setRole(userUrl, secretKey, role) {
  return callClerkOk(`${userUrl}/metadata`, secretKey, {
    method: 'PATCH',
    body: JSON.stringify({ public_metadata: { role } })
  });
}

export default async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.setHeader('Allow', 'GET, POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const { session, refusal } = authenticateClerkRequest(request);
  if (refusal) {
    // The shared module's 503 text is publish-flavoured; 401s are the token
    // verifier's own and read correctly here.
    const message = refusal.status === 503 ? NOT_SET_UP : refusal.message;
    return response.status(refusal.status).json({ message });
  }

  if (!isAdmin(session)) {
    return response.status(403).json({ message: 'Only an admin can manage authors.' });
  }

  /* Checked only after the admin gate: an unauthenticated caller must not be
     able to probe whether the site's Clerk secret is configured. */
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    console.error('Managing authors is not configured: CLERK_SECRET_KEY is required');
    return response.status(503).json({ message: NOT_SET_UP });
  }

  let action = '';
  let id = '';
  if (request.method === 'POST') {
    const body = typeof request.body === 'object' && request.body ? request.body : {};
    action = String(body.action || '');
    id = String(body.id || '');
    // Refused before any Clerk call: an unrecognised action is a bug in the
    // caller and must not spend a request to find that out.
    if (!ACTIONS.has(action) || !id) {
      return response.status(400).json({ message: 'That is not something that can be done to an author.' });
    }
  }

  try {
    if (request.method === 'GET') {
      return response.status(200).json({ authors: await listAuthors(secretKey) });
    }

    /* Read before every write, never cached, so the check sees the state at
       the moment of the change rather than a stale one. This narrows the race
       between two admins stepping down together but cannot close it; see the
       post-write verification below for what happens when it loses. */
    const authors = await listAuthors(secretKey);
    const target = authors.find((author) => author.id === id);
    if (!target) return response.status(404).json({ message: 'No such author.' });

    /* "At least one admin remains", not "an admin may not act on themselves":
       the handoff is to promote a client admin and then step out, which a
       self-removal ban would block. */
    const losesAnAdmin = isActiveAdmin(target) && (action === 'remove' || action === 'demote');
    if (losesAnAdmin && authors.filter(isActiveAdmin).length <= 1) {
      return response.status(409).json({
        message: 'That is the last admin. Promote someone else first, or nobody could invite an author again.'
      });
    }

    const userUrl = `${USERS_URL}/${encodeURIComponent(id)}`;
    if (action === 'remove') {
      await callClerkOk(userUrl, secretKey, { method: 'DELETE' });
    } else {
      /* The dedicated metadata endpoint: as of Clerk API version 2026-05-12
         PATCH /v1/users/{id} ignores public_metadata yet returns 200, so the
         role would silently never change. A null value deletes the key, so a
         demotion leaves no role behind for a later check to misread. */
      await setRole(userUrl, secretKey, action === 'promote' ? 'admin' : null);
    }

    /* The check above NARROWS the race, it does not close it: Clerk has no
       compare-and-set, so two admins acting in the same instant can both read
       "two admins" and both write. Verify after the fact. A demotion is
       restored; a removal cannot be, so it is logged for the operator. */
    if (losesAnAdmin) {
      /* Its own try/catch, apart from the Clerk-failure mapping below: the
         write has already landed, so a failure here is not "try again in a
         minute". It is a possibly-stranded site, and retrying changes nothing
         while the evidence sits in a log nobody reads. */
      const stranded = () => {
        console.error(`NO ADMIN REMAINS (or could not be confirmed): ${action} of ${id} (${target.email}) landed and the follow-up failed or raced another change. Set public_metadata {"role":"admin"} on a user in the Clerk dashboard.`);
        return response.status(500).json({ message: STRANDED });
      };
      let after;
      try {
        after = await listAuthors(secretKey);
      } catch (error) {
        console.error(`Could not verify an admin remains after ${action} of ${id}: ${error.message}`);
        return stranded();
      }
      if (!after.some(isActiveAdmin)) {
        if (action === 'remove') return stranded();
        try {
          await setRole(userUrl, secretKey, 'admin');
        } catch (error) {
          console.error(`Could not restore admin on ${id}: ${error.message}`);
          return stranded();
        }
        console.error(`Two simultaneous admin changes left no admin; restored admin on ${id}`);
        return response.status(409).json({
          message: 'Another admin was changed at the same moment, so this change was undone to keep an admin in place. Nothing was changed; try again.'
        });
      }
    }
    return response.status(204).end();
  } catch (error) {
    if (error.code === 'clerk') {
      const failure = clerkFailure(error.status, { notSetUp: NOT_SET_UP, unreachable: UNREACHABLE });
      return response.status(failure.status).json({ message: failure.message });
    }
    // Not a misconfiguration: the variables are fine, and saying otherwise
    // would send the next person to the wrong place.
    console.error(`Author management could not complete a Clerk request: ${error.message}`);
    return response.status(502).json({ message: UNREACHABLE });
  }
}
