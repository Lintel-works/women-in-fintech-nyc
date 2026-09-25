/* The post types, and the per-type facts the build needs.
 *
 * Imported by the build from Node and by the editor over HTTP from the
 * passthrough copy of lib/, so the two sides cannot disagree about what a type
 * is. The form field lists stay in src/admin/types.js: those are UI, and the
 * build has no use for them.
 *
 * There is deliberately no `layout` here. Eleventy resolves a template's
 * layout before computed data runs, so eleventyComputed cannot set it --
 * permalink is the one documented exception. Both types render through
 * src/_includes/post.njk and differ only in the hero and foot partials it
 * includes.
 */

export const DEFAULT_TYPE = 'fff';

export const POST_TYPES = {
  fff: {
    label: 'Fintech Female Fridays',
    prefix: 'fff-',
    listing: 'fintech-female-fridays.html',
    collection: 'fff',
    hero: 'hero-fff.njk',
    foot: 'foot-fff.njk',
    cardBadge: 'FFF',
    tagFallback: 'Fintech Female Fridays',
    slugSource: 'name',
    titleFallback: (post) => 'FinTech Female Fridays: Meet ' + (post.name || '')
  },
  post: {
    label: 'Jobs & Happenings',
    prefix: 'post-',
    listing: 'happenings.html',
    collection: 'happenings',
    hero: 'hero-happenings.njk',
    foot: 'foot-happenings.njk',
    cardBadge: 'News',
    tagFallback: 'Jobs & Happenings',
    slugSource: 'title',
    titleFallback: null
  }
};

/* A blank or absent type is an FFF interview: the seven posts migrated from
   Wix were written before the field existed, and a file that loses the line to
   a hand-edit must still publish rather than fail a build nobody is watching. */
export function typeKeyOf(post) {
  return String((post && post.type) || '').trim() || DEFAULT_TYPE;
}

/* Throws rather than falling back. An unrecognised type has no URL, no listing
   page and no hero, so there is nothing sensible to publish it as -- and a
   silent drop is the failure mode the spec's operating assumption forbids. The
   message names what was found and what is allowed, because the person reading
   it is an author. */
export function typeOf(post) {
  const key = typeKeyOf(post);
  const type = POST_TYPES[key];
  if (!type) {
    throw new Error(
      `Unknown post type "${key}". A post's type must be one of: ` +
      Object.keys(POST_TYPES).join(', ') + '.'
    );
  }
  return type;
}

/* The title, resolved the one way the post page and its card must both resolve
   it -- they disagreed once already, which is why buildCardView carries a
   comment about it. An FFF interview with no title falls back to the
   interviewee's name; a news post has no such fallback and resolves to '', so
   the editor can refuse it before a file is ever written. */
export function postTitle(post) {
  const explicit = String((post && post.title) || '').trim();
  if (explicit) return explicit;
  const fallback = typeOf(post).titleFallback;
  return fallback ? fallback(post) : '';
}

/* Newest first. The comparator is the one eleventy.config.js has used for the
   fff collection since Phase 5, kept verbatim: no post sets Eleventy's
   reserved `date` key, so the ordering has to be explicit, and a different
   comparator risks silently reordering the seven published cards. A post with
   no isoDate sorts last. */
export function sortedPostsOfType(posts, key) {
  return posts
    .filter((item) => typeKeyOf(item.data) === key)
    .sort((a, b) => ((a.data.isoDate || '') < (b.data.isoDate || '') ? 1 : -1));
}
