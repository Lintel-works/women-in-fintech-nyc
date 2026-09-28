/* scrypt password hashing.
 *
 * scrypt is deliberately slow, which is the point: this project has no
 * storage to rate-limit sign-in attempts with, so the cost per guess is the
 * defence. Paired with generated (not chosen) passwords, online guessing is
 * not viable. Recorded as a mitigation, not a rate limiter.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  let salt, expected;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (!salt.length || expected.length !== KEYLEN) return false;
  const actual = scryptSync(String(password), salt, KEYLEN);
  return timingSafeEqual(actual, expected);
}
