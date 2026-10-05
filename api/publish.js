/* POST /api/publish — the only code in this project that can write to the
 * repository.
 *
 * Order matters and every step refuses before the next: verify the session,
 * validate the payload, render it, and only then touch GitHub -- and minting
 * a GitHub credential counts as touching GitHub, so it happens after every
 * local, pure check has already passed. Nothing is committed until the post
 * is known to build.
 *
 * Env:
 *   CLERK_PEM_PUBLIC_KEY    — Clerk's JWT public key (PEM); verifies the
 *                             Authorization: Bearer session token
 *   CLERK_AUTHORIZED_PARTIES — comma-separated origins allowed as the
 *                             token's azp; unset is a configuration fault
 *   GITHUB_APP_ID           — the GitHub App's id, used to mint a fresh
 *                             installation token on every request
 *   GITHUB_APP_PRIVATE_KEY  — the App's private key (PEM)
 *   GITHUB_INSTALLATION_ID  — the App's installation on this repository
 *   GITHUB_TOKEN            — test-only override: used verbatim as the
 *                             bearer token instead of minting one. Left set
 *                             in production it reintroduces the one-hour
 *                             expiry an installation token carries -- see
 *                             lib/github-auth.mjs, which warns loudly on
 *                             every use.
 *   GITHUB_OWNER            — repository owner
 *   GITHUB_REPO             — repository name
 *   GITHUB_BRANCH           — defaults to main
 */
import { authenticateClerkRequest } from '../lib/clerk-request.mjs';
import { authorNameFromSub } from '../lib/session.mjs';
import { preparePublish } from '../lib/publish.mjs';
import { commitWithRetry, pathExists } from '../lib/github.mjs';
import { resolveGithubToken } from '../lib/github-auth.mjs';
import { POST_TYPES, coverPathFor } from '../lib/post-types.mjs';

// Vercel's request body cap is 4.5 MB. Base64 inflates bytes by 4/3, so a
// 3 MB image becomes ~4 MB of base64 text -- leaving ~500 KB of the cap for
// the post text and the surrounding JSON.
const MAX_IMAGE_BYTES = 3_000_000;

// The only two extensions api/unpublish.js's derived-path deletion (Ruling
// 22) knows to look for. Anything else would publish a cover the editor
// cannot later clean up, so it is refused here even if a client somehow
// sent one -- the editor itself refuses "keep original" on webp/avif/gif
// before this is ever reached (src/admin/editor.js outputExt()).
const ALLOWED_COVER_EXTS = new Set(['jpg', 'png']);

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
    console.error('Publishing is not configured: missing GITHUB_OWNER/GITHUB_REPO, or no usable GitHub credential (GITHUB_TOKEN, or GITHUB_APP_ID+GITHUB_APP_PRIVATE_KEY+GITHUB_INSTALLATION_ID)');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
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
    // Honours the extension the editor actually produced -- "keep original"
    // on a PNG must publish a .png, not a JPEG mislabelled as one (Ruling
    // 24). Anything outside the allowlist is refused rather than guessed
    // at: the editor already refuses "keep original" on webp/avif/gif
    // before a request is ever sent, so reaching this branch with one means
    // something other than the shipped UI sent the request.
    const ext = String(payload.image.ext || 'jpg').toLowerCase();
    if (!ALLOWED_COVER_EXTS.has(ext)) {
      return response.status(400).json({
        message: `That cover image's file type (.${ext}) cannot be published. Use a JPG or PNG, or leave "keep original" unchecked.`
      });
    }
    files.push({
      path: `src/${coverPathFor(prepared.type, prepared.slug, ext)}`,
      content: String(payload.image.base64),
      encoding: 'base64'
    });
  }

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
    return response.status(502).json({ message: 'Publishing failed. Nothing was changed.' });
  }

  // Create versus update means nothing without this check: two different
  // titles can slugify the same way, and a "new" post landing on an existing
  // path would silently replace somebody else's work.
  try {
    const exists = await pathExists({ token, owner, repo, branch, path: prepared.path });
    if (payload.mode === 'create' && exists) {
      // Not "open the existing post to edit it": that post may be the OTHER
      // type (fff and post share one src/posts/ namespace, addressed only
      // by slug), and the editor refuses to open a post of the wrong type
      // for the form that's currently up (src/admin/editor.js openPostFile).
      // Naming a fix that might not work is worse than naming none.
      return response.status(409).json({
        message: 'A post already exists at that address. Change the title, or edit the slug field to choose a different address.'
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

  const authorName = authorNameFromSub(authorEmail);

  const commit = {
    token, owner, repo, branch,
    message: `Publish ${prepared.slug}\n\nPublished from the editor by ${authorEmail}.`,
    author: { name: authorName, email: authorEmail },
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
