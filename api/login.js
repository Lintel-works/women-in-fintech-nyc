/* POST /api/login — exchange an email and password for a session cookie.
 *
 * This is the only code that touches AUTH_USERS. It follows the discipline
 * api/events.js established: one method, nothing from the request forwarded
 * anywhere, and a response that never hints which half of the credential was
 * wrong -- that hint is what turns a leaked email list into a target list.
 *
 * Env:
 *   AUTH_SECRET — random string, at least 32 characters, signs the session
 *   AUTH_USERS  — JSON: {"jane@example.com": "<salt>:<hash>"}
 */
import { verifyPassword } from '../lib/password.mjs';
import { signSession, SESSION_TTL_SECONDS } from '../lib/session.mjs';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const secret = process.env.AUTH_SECRET;
  let users;
  try {
    users = JSON.parse(process.env.AUTH_USERS || '{}');
  } catch {
    users = null;
  }
  if (!secret || secret.length < 32 || !users || !Object.keys(users).length) {
    // Misconfiguration, not a bad password. Say so distinctly: an author
    // retyping a correct password forever is the worst possible failure here.
    console.error('Sign-in is not configured: AUTH_SECRET and/or AUTH_USERS missing or invalid');
    return response.status(503).json({ error: 'not_configured' });
  }

  const body = typeof request.body === 'object' && request.body ? request.body : {};
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  const stored = Object.prototype.hasOwnProperty.call(users, email) ? users[email] : null;
  // Hash even when the email is unknown, so a missing account and a wrong
  // password cost the same time and cannot be told apart from outside.
  //
  // The dummy must be a VALID hash shape or this does nothing: verifyPassword
  // rejects a malformed stored value before it reaches scryptSync, which would
  // make the unknown-email path fast and the known-email path slow -- exactly
  // the oracle this line exists to close.
  const DUMMY_HASH = '00'.repeat(16) + ':' + '00'.repeat(64);
  const ok = verifyPassword(password, stored || DUMMY_HASH);

  if (!stored || !ok) {
    return response.status(401).json({ error: 'bad_credentials' });
  }

  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = signSession({ sub: email, exp }, secret);
  response.setHeader(
    'Set-Cookie',
    `wif_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`
  );
  return response.status(204).end();
}
