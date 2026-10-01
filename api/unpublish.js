/* POST /api/unpublish — remove a published post.
 *
 * This exists because there is no review step and no developer. The first bad
 * post is a matter of time, and without this the only recovery is somebody
 * with a checkout running git revert -- the exact dependency this phase is
 * built to remove.
 *
 * Env: see api/publish.js -- both endpoints read the same variables and mint
 * a GitHub credential the same way.
 */
import { verifyClerkToken } from '../lib/clerk-jwt.mjs';
import { authorNameFromSub } from '../lib/session.mjs';
import { slugify, postPath } from '../lib/publish-validate.mjs';
import { commitWithRetry, getFileContent } from '../lib/github.mjs';
import { resolveGithubToken } from '../lib/github-auth.mjs';
import { parsePost } from '../lib/post-file.mjs';
import { POST_TYPES, typeKeyOf, coverPathFor } from '../lib/post-types.mjs';

// The two extensions api/publish.js can have written a cover image as (see
// its ALLOWED_COVER_EXTS) -- checked in this order against the live post's
// own coverPath so a PNG cover is cleaned up exactly as reliably as a JPEG
// one, closing the same gap Ruling 22 closed for the single-extension case.
const COVER_EXTS = ['jpg', 'png'];

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const clerkPublicKey = process.env.CLERK_PEM_PUBLIC_KEY;
  const authorizedParties = String(process.env.CLERK_AUTHORIZED_PARTIES || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const hasGithubCredential = !!process.env.GITHUB_TOKEN ||
    !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_INSTALLATION_ID);
  if (!clerkPublicKey || !owner || !repo || !hasGithubCredential) {
    console.error('Publishing is not configured: missing CLERK_PEM_PUBLIC_KEY/GITHUB_OWNER/GITHUB_REPO, or no usable GitHub credential (GITHUB_TOKEN, or GITHUB_APP_ID+GITHUB_APP_PRIVATE_KEY+GITHUB_INSTALLATION_ID)');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }

  /* The token arrives in a header, not a cookie: the browser holds the
     session through Clerk and mints a fresh 60-second token per request, so
     there is nothing for this endpoint to read a cookie for. */
  const bearer = String(request.headers.authorization || '');
  let session;
  try {
    session = verifyClerkToken(bearer.replace(/^Bearer\s+/i, ''), {
      publicKey: clerkPublicKey,
      authorizedParties
    });
  } catch (error) {
    // 'config' also covers an empty CLERK_AUTHORIZED_PARTIES: that is a
    // deployment fault, not something the author did wrong.
    if (error.code === 'config') {
      console.error(`Publishing is not configured: ${error.message}`);
      return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
    }
    return response.status(401).json({ message: error.message });
  }

  /* Clerk's DEFAULT session token has no email claim -- only a user_… id.
     Committing that id as the author would be silently wrong: nothing fails,
     and the damage only shows up in git log long afterwards. The dashboard
     must be configured to add the claim, and until it is, refusing is the
     only honest answer. */
  const authorEmail = String(session.email || '').trim().toLowerCase();
  if (!authorEmail) {
    console.error('Publishing is not configured: the Clerk session token carries no email claim. Add {{user.primary_email_address}} to the session token in the Clerk Dashboard.');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }

  const payload = typeof request.body === 'object' && request.body ? request.body : {};

  const typeKey = String(payload.type || '').trim();
  const type = POST_TYPES[typeKey];
  // POST_TYPES is checked even though the path below does not use it: an
  // unpublish naming a type that does not exist is a bug in the caller, and
  // refusing it here is cheaper than deleting the wrong file.
  if (!type) return response.status(400).json({ message: 'That is not a post type.' });

  const slug = slugify(String(payload.slug || ''));
  if (!slug) return response.status(400).json({ message: 'Name the post to unpublish.' });

  const path = postPath(slug);

  let token;
  try {
    token = await resolveGithubToken();
  } catch (error) {
    if (error.code === 'key') {
      console.error("The site's GitHub private key could not be used", error);
      return response.status(503).json({ message: error.message });
    }
    if (error.code === 'auth') {
      console.error('GitHub rejected the publishing credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Could not obtain a GitHub credential', error);
    return response.status(502).json({ message: 'Unpublishing failed. Nothing was changed.' });
  }

  // A destructive action must never report a success it did not verify.
  // Reading the file also answers two further questions below -- whether
  // it's really a post of the TYPE the caller named, and what its own
  // coverPath is -- with one request instead of three.
  let content;
  try {
    content = await getFileContent({ token, owner, repo, branch, path });
  } catch (error) {
    if (error.code === 'auth') {
      console.error('GitHub rejected the publishing credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Could not check whether the post is published', error);
    return response.status(502).json({ message: 'Unpublishing failed. Nothing was changed.' });
  }
  if (content === null) {
    return response.status(404).json({ message: 'There is no published post at that address.' });
  }

  const files = [{ path, delete: true }];

  // fff and post share one src/posts/ namespace, addressed only by slug --
  // validatePublish checks `type` on the way IN but nothing used to check it
  // on the way OUT, so a caller sending {type:'post', slug:'shira-amrany'}
  // deleted the FFF post at that slug with no type mismatch in sight. If the
  // live post cannot be parsed, its real type is unknowable either way, and
  // an unreadable post someone urgently wants gone must still be removable
  // by an operator who already knows what it is -- so only a POST THAT
  // PARSES and disagrees with the caller's typeKey is refused.
  let post = null;
  try {
    post = parsePost(content);
  } catch (error) {
    console.error('Could not read the live post to check its type and cover image', error);
  }
  if (post && typeKeyOf(post) !== typeKey) {
    // Same message and status as "nothing at that address": from the
    // caller's own typeKey's point of view, that is exactly what is true,
    // and it does not disclose that a post of some OTHER type lives there.
    return response.status(404).json({ message: 'There is no published post at that address.' });
  }

  // Only remove the cover image when the live post's own coverPath is
  // exactly the path this editor derives by convention, for whichever
  // extension api/publish.js could have written (Ruling 22, extended by
  // FIX 4 to cover PNG as well as JPEG). A hand-set or legacy coverPath may
  // be shared with another post, or may predate this editor, and deleting
  // it would be a second destructive action the author never confirmed.
  if (post) {
    const live = String(post.coverPath || '').trim();
    const conventional = COVER_EXTS.map((ext) => coverPathFor(typeKey, slug, ext));
    if (conventional.includes(live)) {
      files.push({ path: `src/${live}`, delete: true });
    }
  }

  try {
    const result = await commitWithRetry({
      token, owner, repo, branch,
      message: `Unpublish ${slug}\n\nUnpublished from the editor by ${authorEmail}.`,
      author: { name: authorNameFromSub(authorEmail), email: authorEmail },
      files
    });
    return response.status(200).json({ commit: result.sha });
  } catch (error) {
    if (error.code === 'auth') {
      console.error('GitHub rejected the publishing credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Unpublish failed', error);
    return response.status(502).json({ message: 'Unpublishing failed. Nothing was changed.' });
  }
}
