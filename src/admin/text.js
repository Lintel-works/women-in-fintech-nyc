/* Editor-only text helpers. Everything else the editor needs comes from
   /lib/render-blocks.mjs -- these have no meaning at build time, because a
   committed post already has its slug and its links are already checked. */
import { safeUrl } from '/lib/render-blocks.mjs';

/* Re-exported, not redefined: the publish endpoint (lib/publish-validate.mjs)
   recomputes and overwrites whatever slug the client sends, so this editor
   and that server MUST run the same function or a published file diverges
   from what downloadPost() would have written for the same title. See
   lib/slug.mjs for the incident that made that not-theoretical. */
export { slugify } from '/lib/slug.mjs';

/* Blank is fine; anything the renderer would collapse to '#' is not. */
export function isUrlSafe(s) {
  const raw = String(s == null ? '' : s).trim();
  return !raw || safeUrl(raw) !== '#';
}

/* The slug is pasted into an href on the post page and on both card pages.
   The renderer escapes it, so a stray quote no longer breaks out of the
   attribute -- but it still produces a link nobody can follow, and the author
   is the only one who can fix it. Name the characters rather than rewriting
   the slug behind their back. */
export function badSlugChars(slug) {
  const seen = [];
  for (const ch of String(slug == null ? '' : slug)) {
    if (!/[a-z0-9-]/.test(ch) && !seen.includes(ch)) seen.push(ch);
  }
  return seen;
}
