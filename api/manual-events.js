/* GET /api/manual-events — the manual events on the branch, for the editor.
 *
 * Deliberately NOT what api/events.js serves. That reads this function's own
 * bundle, which is a build artifact: right for rendering, because a page can
 * only show what was built, and wrong for editing, because an author would
 * open a copy as old as the last deploy and write back over whatever changed
 * since. This reads the branch.
 *
 * Also deliberately not filtered by expiry. An event that is over is invisible
 * on the site but its file is still in the repository, and clearing those out
 * is the one job that needs to see them.
 *
 * Authenticated like the rest of /admin: any signed-in author.
 */
import { authenticateClerkRequest } from '../lib/clerk-request.mjs';
import { normalizeEntry } from '../lib/event-entry.mjs';
import { listDirectory, getFileContent } from '../lib/github.mjs';
import { resolveGithubToken } from '../lib/github-auth.mjs';

const DIR = 'src/_data/manual-events';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!owner || !repo) {
    console.error('Listing events is not configured: missing GITHUB_OWNER/GITHUB_REPO');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }

  const { refusal } = authenticateClerkRequest(request);
  if (refusal) {
    return response.status(refusal.status).json({ message: refusal.message });
  }

  try {
    const token = await resolveGithubToken();
    const names = (await listDirectory({ token, owner, repo, branch, path: DIR }))
      .filter((name) => name.endsWith('.json'))
      .sort();

    const now = new Date();
    const events = [];
    for (const name of names) {
      let entry;
      try {
        entry = JSON.parse(await getFileContent({ token, owner, repo, branch, path: `${DIR}/${name}` }));
      } catch (error) {
        /* One unreadable file must not cost the whole list -- the same
           guarantee lib/manual-events.mjs holds for the calendar. */
        console.warn(`manual events: skipping ${name} -- ${error && error.message}`);
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        console.warn(`manual events: skipping ${name} -- it does not hold a single event object`);
        continue;
      }
      /* `over` is computed here rather than in the browser so the page and the
         site agree on when an event retires: normalizeEntry() is the only
         thing that decides that, and it says so by returning `expired`. */
      const verdict = normalizeEntry(entry, now, 1);
      events.push({
        slug: name.replace(/\.json$/, ''),
        name: typeof entry.name === 'string' ? entry.name : '(unnamed)',
        startAt: entry.startAt || null,
        endAt: entry.endAt || null,
        place: entry.place || '',
        city: entry.city || 'other',
        over: verdict.expired === true,
        /* So the page can show which events it cannot open cleanly rather
           than failing silently when the author clicks one. */
        broken: !!verdict.error,
        /* The whole entry, so opening one into the form costs no second
           request -- these files are a few hundred bytes and the author is
           already authenticated. It also carries the fields the form does not
           show, so a save cannot silently drop them. */
        entry
      });
    }
    return response.status(200).json({ events });
  } catch (error) {
    if (error.code === 'auth') {
      console.error('GitHub rejected the credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Could not list manual events', error);
    return response.status(502).json({ message: 'The event list could not be loaded. You can still add an event.' });
  }
}
