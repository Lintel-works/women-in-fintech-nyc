/* Authenticates one API request from its Clerk session token.
 *
 * Shared by every endpoint that acts on behalf of a signed-in author
 * (publish, unpublish, and the user-management endpoints) so the mapping from
 * "what went wrong" to "what the client is told" lives in one place -- the
 * same reason lib/session.mjs once absorbed the helpers publish and unpublish
 * carried as byte-identical copies that could drift.
 *
 * Env:
 *   CLERK_PEM_PUBLIC_KEY      — Clerk's JWT public key (PEM)
 *   CLERK_AUTHORIZED_PARTIES  — comma-separated origins allowed as the azp
 *
 * Returns { session, email, refusal }:
 *   success -> session is the verified payload (so callers can run
 *              isAdmin(session) without a second verification), email is the
 *              trimmed, lower-cased email claim, refusal is null.
 *   refusal -> { status, message }; session and email are null. The caller
 *              does: if (refusal) return response.status(refusal.status)
 *              .json({ message: refusal.message }).
 */
import { verifyClerkToken } from './clerk-jwt.mjs';

const NOT_SET_UP = { status: 503, message: 'Publishing is not set up on this site yet.' };

function refuse(refusal) {
  return { session: null, email: null, refusal };
}

export function authenticateClerkRequest(request, env = process.env) {
  const authorizedParties = String(env.CLERK_AUTHORIZED_PARTIES || '')
    .split(',').map((value) => value.trim()).filter(Boolean);

  /* The token arrives in a header, not a cookie: the browser holds the
     session through Clerk and mints a fresh 60-second token per request, so
     there is nothing for an endpoint to read a cookie for. */
  let session;
  try {
    const header = String((request.headers && request.headers.authorization) || '');
    session = verifyClerkToken(header.replace(/^Bearer\s+/i, ''), {
      publicKey: env.CLERK_PEM_PUBLIC_KEY,
      authorizedParties
    });
  } catch (error) {
    // 'config' also covers an empty CLERK_AUTHORIZED_PARTIES: that is a
    // deployment fault, not something the author did wrong.
    if (error.code === 'config') {
      console.error(`Publishing is not configured: ${error.message}`);
      return refuse(NOT_SET_UP);
    }
    if (error.code === 'expired' || error.code === 'invalid') {
      return refuse({ status: 401, message: error.message });
    }
    // An uncoded error is a bug, not a bad token: its raw text must not
    // reach the client of an auth endpoint.
    console.error('Unexpected failure verifying the Clerk session token', error);
    return refuse({ status: 500, message: 'Something went wrong. Nothing was changed.' });
  }

  /* Clerk's DEFAULT session token has no email claim -- only a user_… id.
     Committing that id as the author would be silently wrong: nothing fails,
     and the damage only shows up in git log long afterwards. The dashboard
     must be configured to add the claim, and until it is, refusing is the
     only honest answer. */
  const email = String(session.email || '').trim().toLowerCase();
  if (!email) {
    console.error('Publishing is not configured: the Clerk session token carries no email claim. Add {{user.primary_email_address}} to the session token in the Clerk Dashboard.');
    return refuse(NOT_SET_UP);
  }

  return { session, email, refusal: null };
}
