/* POST /api/remove-event — take a manual event off the site.
 *
 * api/unpublish.js with a different path convention, and it keeps that file's
 * one careful rule: the cover is deleted only when the LIVE file's coverPath
 * is a path this project's own convention produces. A partner-hosted cover is
 * not ours to delete, and a hand-set one may be an image another page uses.
 * The live file is read for this rather than trusting the client, whose copy
 * may be a stale draft.
 *
 * There is no undo. The page asks the author to type the address first; this
 * endpoint does not second-guess that, but it does refuse a slug with no file
 * rather than reporting a success that removed nothing.
 */
import { authenticateClerkRequest } from '../lib/clerk-request.mjs';
import { authorNameFromSub } from '../lib/session.mjs';
import { commitWithRetry, getFileContent } from '../lib/github.mjs';
import { resolveGithubToken } from '../lib/github-auth.mjs';
import { slugify } from '../lib/slug.mjs';
import { eventPathFor, coverPathFor, COVER_EXTS } from './add-event.js';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  /* Before the configuration check: a refusal there would tell an
     unauthenticated caller whether the site is misconfigured. */
  const { email: authorEmail, refusal } = authenticateClerkRequest(request);
  if (refusal) {
    return response.status(refusal.status).json({ message: refusal.message });
  }

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const hasGithubCredential = !!process.env.GITHUB_TOKEN ||
    !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_INSTALLATION_ID);
  if (!owner || !repo || !hasGithubCredential) {
    console.error('Publishing is not configured');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }

  const payload = typeof request.body === 'object' && request.body ? request.body : {};
  /* Slugified before it builds a path, the check that makes api/post.js safe.
     A traversing slug becomes a harmless one rather than escaping. */
  const slug = slugify(payload.slug);
  if (!slug) {
    return response.status(400).json({ message: 'Name the event to remove.' });
  }

  const path = eventPathFor(slug);

  let token;
  try {
    token = await resolveGithubToken();
  } catch (error) {
    if (error.code === 'key') {
      console.error("The site's GitHub private key could not be used", error);
      return response.status(503).json({ message: error.message });
    }
    console.error('Could not obtain a GitHub credential', error);
    return response.status(502).json({ message: 'Removing the event failed. Nothing was changed.' });
  }

  let live = null;
  try {
    const text = await getFileContent({ token, owner, repo, branch, path });
    if (text === null) {
      return response.status(404).json({
        message: 'There is no event at that address. It may already have been removed.'
      });
    }
    try {
      live = JSON.parse(text);
    } catch (error) {
      /* A file that will not parse still has to be removable -- that is
         exactly when somebody wants it gone. Its cover is simply not matched. */
      console.warn(`remove-event: the live ${path} does not parse; removing it anyway`);
    }
  } catch (error) {
    if (error.code === 'auth') {
      console.error('GitHub rejected the credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Could not read the event being removed', error);
    return response.status(502).json({ message: 'Removing the event failed. Nothing was changed.' });
  }

  const files = [{ path, delete: true }];

  /* Only a path this endpoint's own convention produces. Anything else --
     a partner's URL, or images/fff-someone.jpg set by hand -- is left where
     it is. Deleting an image another page renders is not recoverable from
     here. */
  const liveCover = live && typeof live.coverPath === 'string' ? live.coverPath.trim() : '';
  const conventional = COVER_EXTS.map((ext) => coverPathFor(slug, ext));
  if (liveCover && conventional.includes(liveCover)) {
    files.push({ path: `src/${liveCover}`, delete: true });
  }

  try {
    const result = await commitWithRetry({
      token, owner, repo, branch,
      message: `Remove event ${slug}\n\nRemoved from the events page by ${authorEmail}.`,
      author: { name: authorNameFromSub(authorEmail), email: authorEmail },
      files
    });
    return response.status(200).json({ slug, commit: result.sha });
  } catch (error) {
    if (error.code === 'stale_head') {
      return response.status(409).json({ message: 'Someone else just published. Try again.' });
    }
    if (error.code === 'auth') {
      console.error('GitHub rejected the credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Remove event failed', error);
    return response.status(502).json({ message: 'Removing the event failed. Nothing was changed.' });
  }
}
