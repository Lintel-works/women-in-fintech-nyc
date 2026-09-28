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

const MAX_IMAGE_BYTES = 3_500_000; // under Vercel's 4.5 MB body cap, with room for the JSON

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
  const prepared = preparePublish(payload);
  if (!prepared.ok) {
    return response.status(400).json({ message: prepared.message });
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

  const files = [{ path: prepared.path, content: prepared.text, encoding: 'utf-8' }];

  if (payload.image && payload.image.base64) {
    const bytes = Math.floor(String(payload.image.base64).length * 0.75);
    if (bytes > MAX_IMAGE_BYTES) {
      return response.status(400).json({
        message: 'That cover image is too large to publish. Choose a smaller one.'
      });
    }
    const prefix = POST_TYPES[prepared.type].prefix;
    files.push({
      path: `src/images/${prefix}${prepared.slug}.jpg`,
      content: String(payload.image.base64),
      encoding: 'base64'
    });
  }

  const commit = {
    token, owner, repo, branch,
    message: `Publish ${prepared.slug}\n\nPublished from the editor by ${session.sub}.`,
    author: { name: session.sub, email: session.sub },
    files
  };

  try {
    const result = await commitWithRetry(commit);
    return response.status(200).json({
      url: `/${POST_TYPES[prepared.type].prefix}${prepared.slug}.html`,
      commit: result.sha
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
