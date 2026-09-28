/* Session signing for the admin editor.
 *
 * Why this is a separate, pure module: it is the seam the whole auth decision
 * sits behind. api/publish.js asks it one question -- who is this caller --
 * and knows nothing about how they proved it. Swapping to GitHub OAuth or a
 * managed provider replaces this file and api/login.js and touches nothing
 * else. Being pure also means it tests under node --test with no server.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_SECONDS = 43200; // 12 hours

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(body, secret) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function signSession(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

export function verifySession(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const given = token.slice(dot + 1);

  const expected = sign(body, secret);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // Length must match before timingSafeEqual, which throws on a mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp <= now) return null;
  return payload;
}
