/* GET /api/post?type=<type>&slug=<slug> — one published post's source file.
 *
 * The editor's post-list drawer needs this because an author signed in to
 * /admin has no clone of this repository. "Open post" reads a file from the
 * author's own disk, which an author on their own laptop does not have, so
 * until now there was no way to reach a published post at all -- and no way
 * to correct one, or to find the one you meant to take down.
 *
 * The list itself is posts-index.json, emitted by the build (lib/posts-index.mjs
 * says why). This endpoint serves only the post the author actually picked, so
 * opening the drawer costs one static file and opening a post costs one call.
 *
 * It returns the source rather than the rendered page because the editor
 * parses it back into the form with lib/post-file.mjs -- the rendered page has
 * already lost the front matter and the block structure.
 *
 * Env: the same as api/publish.js and api/unpublish.js. All three read
 * GITHUB_OWNER/GITHUB_REPO/GITHUB_BRANCH and mint a credential the same way.
 */
import { authenticateClerkRequest } from '../lib/clerk-request.mjs';
import { slugify, postPath } from '../lib/publish-validate.mjs';
import { getFileContent } from '../lib/github.mjs';
import { resolveGithubToken } from '../lib/github-auth.mjs';
import { POST_TYPES } from '../lib/post-types.mjs';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  /* Authenticated like publish and unpublish, and for the same reason rather
     than a different one: this reads a file that is already public on the
     site, but it reads it *through this site's GitHub credential*. Leaving it
     open would make the endpoint a free proxy for any path the credential can
     reach, and the slug check below is the only thing standing between a
     caller and that.

     Ahead of the configuration check, also like its siblings: a refusal there
     would tell an unauthenticated caller whether the site is misconfigured. */
  const { refusal } = authenticateClerkRequest(request);
  if (refusal) {
    return response.status(refusal.status).json({ message: refusal.message });
  }

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const hasGithubCredential = !!process.env.GITHUB_TOKEN ||
    !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_INSTALLATION_ID);
  if (!owner || !repo || !hasGithubCredential) {
    console.error('Publishing is not configured: missing GITHUB_OWNER/GITHUB_REPO, or no usable GitHub credential');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }

  const query = request.query || {};
  const typeKey = String(query.type || '').trim();
  if (!POST_TYPES[typeKey]) {
    return response.status(400).json({ message: 'That is not a post type.' });
  }

  /* Run through slugify rather than trusted as sent: it is what builds the
     path below, and it is what keeps "../../.." out of it. postPath()
     interpolates, so this is the check that makes that safe. */
  const slug = slugify(String(query.slug || ''));
  if (!slug) return response.status(400).json({ message: 'Name the post to open.' });

  let token;
  try {
    token = await resolveGithubToken();
  } catch (error) {
    console.error('Could not obtain a GitHub credential:', error && error.message);
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }

  try {
    const source = await getFileContent({ token, owner, repo, branch, path: postPath(slug) });
    /* A post listed in the index but missing here is the ordinary race, not a
       fault: the index describes the last deploy, so a post unpublished since
       then is still listed. The drawer says so rather than showing an error.
       Compared against null, not falsiness -- getFileContent resolves to the
       decoded file, and an empty one is a post that exists. */
    if (source === null) {
      return response.status(404).json({ message: 'That post is no longer published.' });
    }
    return response.status(200).json({ slug, type: typeKey, source });
  } catch (error) {
    if (error && error.code === 'auth') {
      console.error('GitHub rejected the credential while reading a post');
      return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
    }
    console.error('Could not read a post:', error && error.message);
    return response.status(502).json({ message: 'Could not reach GitHub. Try again in a minute.' });
  }
}
