/* The index behind the editor's post-list drawer.
 *
 * An author signed in to /admin has no clone of this repository, so until now
 * there was no way to reach a published post at all: "Open post" reads a file
 * from the author's own disk, which an author on their own laptop does not
 * have. That left unpublish unreachable for exactly the people the editor
 * exists for. Phase 5's spec listed this as out of scope ("no list view, no
 * delete"); this is that piece.
 *
 * It is emitted by the build rather than served from an endpoint because
 * there are 261 posts: drawing the list from GitHub would be 261 requests for
 * front matter the build already has in hand. The cost is that the list
 * describes the last deploy rather than the repository's head, which is the
 * honest thing for a list of *published* posts to say -- a post published
 * thirty seconds ago genuinely is not live yet.
 */
import { POST_TYPES, typeKeyOf, postTitle } from './post-types.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/* One row, or null if the post could not be acted on.
 *
 * Null rather than a throw: these are read straight out of the collection, so
 * a single malformed post would otherwise empty the drawer and leave an author
 * unable to reach any of the other 260. The build still renders whatever it
 * can, which is the same bargain lib/manual-events.mjs strikes.
 */
export function postsIndexEntry(data) {
  if (!data || typeof data !== 'object') return null;

  /* The slug is the identity: it is what opening fetches and what unpublish
     is given. An entry without one has no action behind it. */
  const slug = text(data.slug);
  if (!slug) return null;

  const typeKey = typeKeyOf(data);
  const type = POST_TYPES[typeKey];
  if (!type) return null;

  return {
    slug,
    type: typeKey,
    name: text(data.name),
    /* Resolved through postTitle so a row reads the same as the post page and
       its card -- an FFF interview with no title of its own shows the
       "Meet {name}" fallback rather than an empty cell. */
    title: postTitle(data),
    displayDate: text(data.displayDate),
    isoDate: text(data.isoDate),
    url: type.prefix + slug + '.html'
  };
}

/* Accepts Eleventy collection items (`{ data }`) or bare post data, so the
   template can hand over a collection and a test can hand over a fixture. */
function dataOf(item) {
  return item && typeof item === 'object' && item.data ? item.data : item;
}

export function buildPostsIndex(items) {
  const entries = [];
  (items || []).forEach((item) => {
    const entry = postsIndexEntry(dataOf(item));
    if (entry) entries.push(entry);
  });

  /* Newest first, matching sortedPostsOfType and the listing pages, so the
     drawer agrees with the site. An undated post sorts last there too -- and
     a post sorted last there is one that never reached the homepage, so
     seeing it at the bottom here is a useful signal rather than a quirk. */
  entries.sort((a, b) => {
    if (a.isoDate !== b.isoDate) return a.isoDate < b.isoDate ? 1 : -1;
    return (a.name || a.title).localeCompare(b.name || b.title);
  });
  return entries;
}
