/* POST /api/add-event — put an event on the site that was never in Luma.
 *
 * The second piece of code in this project that can write to the repository,
 * and it follows api/publish.js's order for the same reasons: verify the
 * session, validate the payload, validate the image, and only then mint a
 * GitHub credential and touch GitHub. Minting a credential counts as touching
 * GitHub, so it happens after every local, pure check has passed. Nothing is
 * committed until the event is known to render.
 *
 * Authentication matches publish and unpublish: any signed-in author, no admin
 * check. Adding a partner event is the same kind of act as publishing a post.
 *
 * Creates or updates, by `mode`, checked against what is on the branch. The
 * slug is the filename, so it is frozen on update and an update must name it:
 * a changed slug would write a second file and leave the first. Renaming is
 * remove-then-add. Removal lives in its own endpoint, and
 * lib/event-entry.mjs retires an event by itself once its end time passes.
 *
 * Env: the same set api/publish.js documents (CLERK_PEM_PUBLIC_KEY,
 * CLERK_AUTHORIZED_PARTIES, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY,
 * GITHUB_INSTALLATION_ID or GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO,
 * GITHUB_BRANCH).
 */
import { authenticateClerkRequest } from '../lib/clerk-request.mjs';
import { authorNameFromSub } from '../lib/session.mjs';
import { normalizeEntry } from '../lib/event-entry.mjs';
import { commitWithRetry, getFileContent } from '../lib/github.mjs';
import { resolveGithubToken } from '../lib/github-auth.mjs';
import { slugify } from '../lib/slug.mjs';
import { isCleanBase64 } from './publish.js';

const MAX_IMAGE_BYTES = 3_000_000;

/* The two the site serves as a cover, matching api/publish.js and
   lib/event-entry.mjs's COVER_PATH. One allowlist disagreeing with another is
   how a cover gets committed that the renderer then refuses. Exported because
   api/remove-event.js deletes by the same convention. */
export const COVER_EXTS = ['jpg', 'png'];
const ALLOWED_COVER_EXTS = new Set(COVER_EXTS);

export function eventPathFor(slug) {
  return `src/_data/manual-events/${slug}.json`;
}

/* The WEB path, as a post's coverPath already is: the file is committed to
   src/images/ and referenced as images/…, because Eleventy passes src/images/
   through to the site root and every page that renders an event card is
   itself at the root. */
export function coverPathFor(slug, ext) {
  return `images/event-${slug}.${ext}`;
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
    console.error('Publishing is not configured: missing GITHUB_OWNER/GITHUB_REPO, or no usable GitHub credential');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }

  const payload = typeof request.body === 'object' && request.body ? request.body : {};
  const submitted = typeof payload.event === 'object' && payload.event ? payload.event : {};

  /* Defaults to create: a client that forgets to send one is adding, and the
     worst a wrong guess can do here is a 409 the author can read. */
  const mode = payload.mode === 'update' ? 'update' : 'create';
  const failedMessage = mode === 'update'
    ? 'Updating the event failed. Nothing was changed.'
    : 'Adding the event failed. Nothing was changed.';

  /* Enforced here rather than left to the page: an update that derived its
     slug from a renamed event would look for a file that was never there and
     report the event as removed. */
  if (mode === 'update' && !slugify(submitted.slug)) {
    return response.status(400).json({
      message: 'An update must say which event it changes. Reopen the event from the list and try again.'
    });
  }

  /* The slug is the filename and the identity, and it is interpolated into a
     repository path -- so it is slugified before it is used for anything, the
     check that makes api/post.js safe. Derived from the name when the form
     does not send one, exactly as normalizeEntry() derives the id. */
  const slug = slugify(submitted.slug) || slugify(submitted.name);
  if (!slug) {
    return response.status(400).json({
      message: 'That event name cannot be turned into an address. Add a few letters or numbers to it.'
    });
  }

  /* The cover is written only under src/images/ with a name derived from the
     slug, never from the uploaded filename. */
  let ext = null;
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
    ext = String(payload.image.ext || 'jpg').toLowerCase();
    if (!ALLOWED_COVER_EXTS.has(ext)) {
      return response.status(400).json({
        message: `That cover image's file type (.${ext}) cannot be published. Use a JPG or a PNG.`
      });
    }
  }

  /* Written to the file, never taken from the request: an author cannot
     choose where an image lands, which is what keeps the path check in
     lib/event-entry.mjs meaningful. */
  const entry = {
    name: typeof submitted.name === 'string' ? submitted.name.trim() : '',
    slug,
    startAt: submitted.startAt,
    endAt: submitted.endAt || null,
    timezone: submitted.timezone || 'America/New_York',
    url: submitted.url,
    city: submitted.city,
    place: submitted.place || '',
    locationType: submitted.locationType,
    membersOnly: submitted.membersOnly === true,
    tags: Array.isArray(submitted.tags) ? submitted.tags : []
  };
  if (ext) entry.coverPath = coverPathFor(slug, ext);
  else if (submitted.coverUrl) entry.coverUrl = submitted.coverUrl;

  /* Run through the SAME normaliser the build uses, so the page cannot write
     a file the renderer would later drop. The event this produces is
     discarded; only its verdict is wanted. */
  const verdict = normalizeEntry(entry, new Date(), 1);
  if (verdict.expired) {
    /* Not an { error }, so a handler checking only verdict.error would commit
       a file that renders nowhere and report success. */
    return response.status(400).json({
      message: 'That event has already finished, so it would not appear on the site. Check the date and time.'
    });
  }
  if (verdict.error) {
    return response.status(400).json({ message: `This event cannot be added: ${verdict.error}.` });
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
    if (error.code === 'auth') {
      console.error('GitHub rejected the publishing credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Could not obtain a GitHub credential', error);
    return response.status(502).json({ message: failedMessage });
  }

  /* Create versus update checked against the branch, the rule
     api/publish.js enforces: two different names can slugify the same way, so
     a "new" event landing on an existing path would silently replace somebody
     else's. The live file is read rather than merely probed, because an
     update needs what is in it -- see the cover carry-over below. */
  let live = null;
  try {
    const text = await getFileContent({ token, owner, repo, branch, path });
    if (mode === 'create' && text !== null) {
      return response.status(409).json({
        message: 'An event already exists at that address. Change the event name, or edit the address field.'
      });
    }
    if (mode === 'update' && text === null) {
      return response.status(409).json({
        message: 'That event is no longer on the site — someone may have removed it. Add it again as a new event.'
      });
    }
    if (text !== null) {
      try {
        live = JSON.parse(text);
      } catch (error) {
        /* A hand-edited file that will not parse must not block a correction
           -- that is exactly when someone needs this page. The cover
           carry-over below simply finds nothing. */
        console.warn(`add-event: the live ${path} does not parse; updating it anyway`);
      }
    }
  } catch (error) {
    if (error.code === 'auth') {
      console.error('GitHub rejected the publishing credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Could not check whether the event already exists', error);
    return response.status(502).json({ message: failedMessage });
  }

  /* Cover carry-over. An author editing a start time does not re-upload the
     cover, and losing it silently is worse than any error this file reports.
     Taken from the LIVE file rather than the client's copy, which may be a
     stale draft -- the rule api/unpublish.js follows for the same field. */
  /* Trimmed, as api/remove-event.js and api/unpublish.js do: the normaliser's
     sitePath() trims, so " images/x.jpg" is a valid cover to the renderer and
     must be recognised as one here too. */
  const liveCover = live && typeof live.coverPath === 'string' ? live.coverPath.trim() : '';
  if (!ext && !entry.coverUrl && liveCover) {
    entry.coverPath = liveCover;
    /* Re-validated rather than trusted: the live file may have been edited by
       hand into something the renderer would drop, and carrying that forward
       would launder it. */
    const recheck = normalizeEntry(entry, new Date(), 1);
    if (recheck.error) delete entry.coverPath;
  }

  /* The event and its cover in ONE commit, so an event is never live with a
     missing cover, nor an image orphaned by a failed event write. */
  const files = [{ path, content: JSON.stringify(entry, null, 2) + '\n', encoding: 'utf-8' }];
  if (ext) {
    files.push({
      path: `src/${coverPathFor(slug, ext)}`,
      content: String(payload.image.base64),
      encoding: 'base64'
    });
  }

  /* A cover this endpoint wrote earlier that the event no longer points at --
     a PNG replacing a JPG, or a hosted coverUrl replacing an upload -- would
     sit in src/images/ forever. Deleted only when the live cover is a path
     THIS endpoint could have written: a partner-hosted or hand-set one is not
     ours to remove (the rule api/unpublish.js follows, extended to both
     extensions here). */
  for (const other of COVER_EXTS) {
    const conventional = coverPathFor(slug, other);
    if (liveCover === conventional && entry.coverPath !== conventional) {
      files.push({ path: `src/${conventional}`, delete: true });
    }
  }

  try {
    const result = await commitWithRetry({
      token, owner, repo, branch,
      message: mode === 'update'
        ? `Update event ${slug}\n\nUpdated from the events page by ${authorEmail}.`
        : `Add event ${slug}\n\nAdded from the events page by ${authorEmail}.`,
      author: { name: authorNameFromSub(authorEmail), email: authorEmail },
      files
    });
    return response.status(200).json({
      slug,
      commit: result.sha,
      coverPath: ext ? coverPathFor(slug, ext) : null
    });
  } catch (error) {
    if (error.code === 'stale_head') {
      return response.status(409).json({ message: 'Someone else just published. Try again.' });
    }
    if (error.code === 'auth') {
      console.error('GitHub rejected the publishing credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Add event failed', error);
    return response.status(502).json({ message: failedMessage });
  }
}
