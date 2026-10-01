/* Verifies a Clerk session token.
 *
 * Why no JWKS fetch: Clerk publishes the instance's RS256 public key as PEM,
 * so verification is a local signature check against an environment
 * variable. No network call, no cache, and no cache invalidation to get
 * wrong -- the same reasoning lib/github-auth.mjs applies to signing its own
 * JWT with node:crypto rather than taking a dependency.
 *
 * Why the three codes are distinct: a Clerk session token lives 60 seconds,
 * so 'expired' is the ordinary state of affairs a minute after sign-in, not
 * a fault. Reporting it the way a tampered token is reported would send an
 * author -- or whoever maintains this -- chasing a broken credential that is
 * working exactly as designed. publishing-setup.md documents the same
 * conflation costing real debugging time with GitHub's 403s.
 */
import { createVerify, createPublicKey } from 'node:crypto';

/* Clerk and Vercel do not share a clock. With a 60-second token, a second or
   two of skew would otherwise reject tokens that are perfectly valid, which
   presents as publishing that fails roughly at random. */
const DEFAULT_LEEWAY_SECONDS = 5;

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

export function verifyClerkToken(token, {
  publicKey,
  authorizedParties = [],
  now = Math.floor(Date.now() / 1000),
  leewaySeconds = DEFAULT_LEEWAY_SECONDS
} = {}) {
  if (!publicKey) {
    throw fail("The site's sign-in key is not configured — contact the site owner.", 'config');
  }

  const parts = String(token == null ? '' : token).split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw fail('Not signed in.', 'invalid');
  }

  let header;
  let payload;
  try {
    header = decodeSegment(parts[0]);
    payload = decodeSegment(parts[1]);
  } catch {
    throw fail('Not signed in.', 'invalid');
  }
  if (!header || !payload || typeof payload !== 'object') {
    throw fail('Not signed in.', 'invalid');
  }

  /* Pinned BEFORE verifying, not after. A token whose header asks for HS256
     invites the verifier to treat the public key as a shared HMAC secret --
     a key anyone can read -- which forges any payload at will. */
  if (header.alg !== 'RS256') {
    throw fail('Not signed in.', 'invalid');
  }

  let key;
  try {
    key = createPublicKey(publicKey);
  } catch {
    throw fail("The site's sign-in key could not be read — contact the site owner.", 'config');
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  let verified = false;
  try {
    verified = createVerify('RSA-SHA256')
      .update(signingInput)
      .verify(key, Buffer.from(parts[2], 'base64url'));
  } catch {
    verified = false;
  }
  if (!verified) throw fail('Not signed in.', 'invalid');

  // Claims are only trusted after the signature is known good.
  if (typeof payload.exp !== 'number' || payload.exp + leewaySeconds <= now) {
    throw fail('Your session expired — sign in again.', 'expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf - leewaySeconds > now) {
    throw fail('Not signed in.', 'invalid');
  }
  if (payload.azp && authorizedParties.length && !authorizedParties.includes(payload.azp)) {
    throw fail('Not signed in.', 'invalid');
  }

  return payload;
}

/* The role lives in public_metadata, which only Clerk's Backend API can
   write. user_metadata would be writable by the user it describes, which
   would make self-promotion to admin a single request. */
export function isAdmin(payload) {
  return !!payload && !!payload.public_metadata && payload.public_metadata.role === 'admin';
}
