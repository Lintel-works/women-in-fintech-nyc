/* POST /api/invite — an admin invites an author by email.
 *
 * Clerk sends the email and owns the invitation token, its expiry and its
 * single use. This endpoint exists so a client-side admin can onboard an
 * author without a Clerk account of their own, which is the whole reason the
 * invite lives here rather than in Clerk's dashboard.
 *
 * Env:
 *   CLERK_PEM_PUBLIC_KEY       — verifies the caller's session token
 *   CLERK_SECRET_KEY           — authenticates to Clerk's Backend API
 *   CLERK_AUTHORIZED_PARTIES   — comma-separated allowed azp origins
 *   CLERK_INVITE_REDIRECT_URL  — where the invite link lands (optional)
 */
import { authenticateClerkRequest } from '../lib/clerk-request.mjs';
import { isAdmin } from '../lib/clerk-jwt.mjs';

const INVITATIONS_URL = 'https://api.clerk.com/v1/invitations';
const TIMEOUT_MS = 8000;

const NOT_SET_UP = 'Inviting is not set up on this site yet.';
const UNREACHABLE = 'Could not reach the sign-in service. Try again in a minute.';

/* Deliberately not a full RFC 5322 grammar: Clerk validates properly, and the
   only job here is to refuse the obviously wrong before spending one of the
   100 invitations an instance gets per hour. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    console.error('Inviting is not configured: CLERK_SECRET_KEY is required');
    return response.status(503).json({ message: NOT_SET_UP });
  }

  const { session, refusal } = authenticateClerkRequest(request);
  if (refusal) {
    // The shared module's 503 text is publish-flavoured; 401s are the token
    // verifier's own and read correctly here.
    const message = refusal.status === 503 ? NOT_SET_UP : refusal.message;
    return response.status(refusal.status).json({ message });
  }

  if (!isAdmin(session)) {
    return response.status(403).json({ message: 'Only an admin can invite an author.' });
  }

  const body = typeof request.body === 'object' && request.body ? request.body : {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL.test(email)) {
    return response.status(400).json({ message: 'That does not look like an email address.' });
  }

  const payload = { email_address: email };
  const redirectUrl = process.env.CLERK_INVITE_REDIRECT_URL;
  if (redirectUrl) payload.redirect_url = redirectUrl;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let clerkResponse;
  try {
    clerkResponse = await fetch(INVITATIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch {
    // Not a misconfiguration: saying so would send whoever maintains this to
    // the environment variables, which are fine.
    return response.status(502).json({ message: UNREACHABLE });
  } finally {
    clearTimeout(timer);
  }

  if (clerkResponse.ok) return response.status(204).end();

  if (clerkResponse.status === 422) {
    return response.status(409).json({ message: 'That person has already been invited, or already has an account.' });
  }
  if (clerkResponse.status === 429) {
    const retryAfter = clerkResponse.headers && clerkResponse.headers.get('retry-after');
    if (retryAfter) response.setHeader('Retry-After', retryAfter);
    return response.status(429).json({ message: 'Too many invitations in the last hour. Try again later.' });
  }
  console.error(`Clerk rejected an invitation with ${clerkResponse.status}`);
  return response.status(502).json({ message: UNREACHABLE });
}
