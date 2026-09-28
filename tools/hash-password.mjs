/* node tools/hash-password.mjs 'the password'
 *
 * Prints one entry for AUTH_USERS. Setting up a new author is: generate a
 * long random password, run this, paste the line into the Vercel env var,
 * hand the author the password. Removing one is deleting its line.
 */
import { hashPassword } from '../lib/password.mjs';

const password = process.argv[2];
if (!password) {
  console.error("Usage: node tools/hash-password.mjs 'the password'");
  process.exit(1);
}
console.log(hashPassword(password));
