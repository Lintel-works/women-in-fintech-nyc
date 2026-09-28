/* POST /api/publish — the only code in this project that can write to the
 * repository.
 *
 * Order matters and every step refuses before the next: verify the session,
 * validate the payload, render it, and only then touch GitHub. Nothing is
 * committed until the post is known to build.
 *
 * Env:
 *   AUTH_SECRET   — verifies the session cookie (see api/login.js)
 *   GITHUB_TOKEN  — the GitHub App installation token; repo contents: write
 *   GITHUB_OWNER  — repository owner
 *   GITHUB_REPO   — repository name
 *   GITHUB_BRANCH — defaults to main
 */
import { verifySession } from '../lib/session.mjs';
import { preparePublish } from '../lib/publish.mjs';
import { commitWithRetry, pathExists } from '../lib/github.mjs';
import { POST_TYPES } from '../lib/post-types.mjs';

// Vercel's request body cap is 4.5 MB. Base64 inflates bytes by 4/3, so a
// 3 MB image becomes ~4 MB of base64 text -- leaving ~500 KB of the cap for
// the post text and the surrounding JSON.
const MAX_IMAGE_BYTES = 3_000_000;

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

// Buffer.from(x, 'base64') does not throw on garbage -- it silently skips
// any character outside the base64 alphabet, so a data URI's
// "data:image/jpeg;base64," prefix decodes to wrong bytes instead of
// failing. Re-encoding the decoded bytes and comparing to the input (modulo
// '=' padding) catches that: a clean base64 string round-trips, a corrupted
// one does not.
export function isCleanBase64(value) {
  const str = String(value == null ? '' : value);
  if (!str) return false;
  const decoded = Buffer.from(str, 'base64');
  if (decoded.length === 0) return false;
  const reencoded = decoded.toString('base64');
  return reencoded.replace(/=+$/, '') === str.replace(/=+$/, '');
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
  const prepared = preparePublish(payload);
  if (!prepared.ok) {
    return response.status(400).json({ message: prepared.message });
  }

  const files = [{ path: prepared.path, content: prepared.text, encoding: 'utf-8' }];

  // Every check here is pure and local, so it all runs before the first
  // network call: a bad image should never cost a GitHub round trip, and an
  // author with a too-large photo should never be told "GitHub is down"
  // when GitHub was never asked.
  if (payload.image && payload.image.base64) {
    const bytes = Math.floor(String(payload.image.base64).length * 0.75);
    if (bytes > MAX_IMAGE_BYTES) {
      return response.status(400).json({
        message: 'That cover image is too large to publish. Choose a smaller one.'
      });
    }
    if (!isCleanBase64(payload.image.base64)) {
      return response.status(400).json({
        message: 'That cover image could not be read. Try choosing it again.'
      });
    }
    const prefix = POST_TYPES[prepared.type].prefix;
    files.push({
      path: `src/images/${prefix}${prepared.slug}.jpg`,
      content: String(payload.image.base64),
      encoding: 'base64'
    });
  }

  // Create versus update means nothing without this check: two different
  // titles can slugify the same way, and a "new" post landing on an existing
  // path would silently replace somebody else's work.
  try {
    const exists = await pathExists({ token, owner, repo, branch, path: prepared.path });
    if (payload.mode === 'create' && exists) {
      return response.status(409).json({
        message: 'A post already exists at that address. Change the title, or open the existing post to edit it.'
      });
    }
    if (payload.mode === 'update' && !exists) {
      return response.status(409).json({
        message: 'There is no published post at that address yet. Publish it as a new post instead.'
      });
    }
  } catch (error) {
    if (error.code === 'auth') {
      console.error('GitHub rejected the publishing credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Could not check whether the post already exists', error);
    return response.status(502).json({ message: 'Publishing failed. Nothing was changed.' });
  }

  // git blame reads better with a name than with an email address; the
  // session only carries an email, so fall back to its local part.
  const authorName = session.sub.includes('@') ? session.sub.split('@')[0] : session.sub;

  const commit = {
    token, owner, repo, branch,
    message: `Publish ${prepared.slug}\n\nPublished from the editor by ${session.sub}.`,
    author: { name: authorName, email: session.sub },
    files
  };

  try {
    const result = await commitWithRetry(commit);
    return response.status(200).json({
      url: `/${POST_TYPES[prepared.type].prefix}${prepared.slug}.html`,
      commit: result.sha,
      // The editor uses this to track which slug is now live, so a second
      // publish of the same post sends mode: 'update' instead of 'create'.
      // Sent explicitly rather than left for the client to parse back out of
      // `url` -- this is the slug the server actually decided on (it may
      // differ from what the client asked for), and the client should never
      // have to re-derive that by guessing at a URL's shape.
      slug: prepared.slug
    });
  } catch (error) {
    if (error.code === 'stale_head') {
      return response.status(409).json({ message: 'Someone else just published. Try again.' });
    }
    if (error.code === 'auth') {
      console.error('GitHub rejected the publishing credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Publish failed', error);
    return response.status(502).json({ message: 'Publishing failed. Nothing was changed.' });
  }
}
