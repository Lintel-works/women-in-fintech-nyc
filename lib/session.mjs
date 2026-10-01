/* Derives the git author name for a signed-in author.
 *
 * What remains of a module that used to sign and verify this project's own
 * session cookies. Clerk now owns sessions (lib/clerk-jwt.mjs verifies its
 * tokens), and the file's original header predicted exactly this: "Swapping
 * to GitHub OAuth or a managed provider replaces this file and api/login.js
 * and touches nothing else." It did.
 */

/* git blame reads better with a name than with an email address; a session
   only carries an email, so fall back to its local part. Shared by
   api/publish.js and api/unpublish.js so both endpoints derive the same git
   author name for the same signed-in author, rather than each computing its
   own answer that could quietly drift apart.

   A sub with no local part (it starts with "@", or is "@" alone) would make
   split('@')[0] an empty string -- an empty git commit author name is a 422
   from GitHub's own API, which lib/github.mjs maps to 'stale_head', which
   commitWithRetry retries once and then still fails: the author sees "Someone
   else just published" forever, for a bug that has nothing to do with anyone
   else publishing. Falling back to the full sub when the local part is empty
   means there is always a non-empty name to commit as. */
export function authorNameFromSub(sub) {
  const local = sub.includes('@') ? sub.split('@')[0] : sub;
  return local || sub;
}
