/* The one slugify.
 *
 * The editor (src/admin/text.js, imported by src/admin/editor.js) and the
 * publish endpoint (lib/publish-validate.mjs) used to each define this
 * separately, and they disagreed: the editor stripped diacritics and
 * apostrophes and had no length cap, the server did neither and capped at 80
 * characters. validatePublish ignores whatever slug the client sends and
 * recomputes its own, so the server's answer always won -- silently
 * overwriting an author's hand-edited slug, and for any name carrying an
 * accent or an apostrophe (D'aundra Lewis, Café Münchén) producing a
 * DIFFERENT slug than the one downloadPost() would have written for the same
 * title. That also breaks the cover image: coverPath is computed client-side
 * from the client's slug, but api/publish.js writes the image file using the
 * server's slug, so the two paths diverge and the published post points at
 * an image that was never written. One implementation, imported by both
 * sides, is the only way "published matches downloaded" can hold.
 */

/* Matches api/publish.js's own request-body ceiling in spirit: a slug this
   long makes an unusable filename and URL long before the request-size limit
   would ever be the problem. */
const MAX_SLUG = 80;

export function slugify(text) {
  return String(text == null ? '' : text)
    // NFD splits an accented letter into the base letter plus a combining
    // mark, so stripping U+0300-U+036F (the combining marks block) turns
    // "Café" into "cafe" instead of dropping the whole letter -- this is
    // what makes the slug match an existing post's committed filename.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // An apostrophe reads as a word joiner, not a separator: "D'aundra"
    // becomes "daundra", not "d-aundra" -- matching src/posts/daundra-lewis.html.
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SLUG)
    // The cap above can land mid-run of hyphens or right after one; trim
    // again so a long title never ends in a dangling "-".
    .replace(/-+$/, '');
}
