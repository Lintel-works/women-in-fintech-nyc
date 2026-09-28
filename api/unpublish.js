/* POST /api/unpublish — remove a published post.
 *
 * This exists because there is no review step and no developer. The first bad
 * post is a matter of time, and without this the only recovery is somebody
 * with a checkout running git revert -- the exact dependency this phase is
 * built to remove.
 */
import { verifySession, authorNameFromSub } from '../lib/session.mjs';
import { slugify, postPath } from '../lib/publish-validate.mjs';
import { commitWithRetry, getFileContent } from '../lib/github.mjs';
import { parsePost } from '../lib/post-file.mjs';
import { POST_TYPES } from '../lib/post-types.mjs';

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const secret = process.env.AUTH_SECRET;
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!secret || !token || !owner || !repo) {
    console.error('Publishing is not configured: missing AUTH_SECRET/GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }

  const session = verifySession(readCookie(request.headers.cookie, 'wif_session'), secret);
  if (!session) {
    return response.status(401).json({ message: 'Your session expired — sign in again.' });
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

  // A destructive action must never report a success it did not verify.
  // Reading the file also answers a second question below -- what its own
  // coverPath is -- with one request instead of two.
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

  // Only remove the cover image when the live post's own coverPath is
  // exactly the path this editor derives by convention. A hand-set or
  // legacy coverPath may be shared with another post, or may predate this
  // editor, and deleting it would be a second destructive action the author
  // never confirmed. If the post cannot be parsed, the image is left alone
  // rather than guessed at -- unpublishing the post itself still proceeds.
  try {
    const post = parsePost(content);
    const conventionalCoverPath = `images/${type.prefix}${slug}.jpg`;
    if (String(post.coverPath || '').trim() === conventionalCoverPath) {
      files.push({ path: `src/${conventionalCoverPath}`, delete: true });
    }
  } catch (error) {
    console.error('Could not read the live post to check its cover image', error);
  }

  try {
    const result = await commitWithRetry({
      token, owner, repo, branch,
      message: `Unpublish ${slug}\n\nUnpublished from the editor by ${session.sub}.`,
      author: { name: authorNameFromSub(session.sub), email: session.sub },
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
