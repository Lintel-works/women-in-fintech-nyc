/* Validates what the browser sent and decides where it may be written.
 *
 * Why the server computes the path: if the browser supplied file text and a
 * destination, anything that compromised the editor page could write anywhere
 * in the repository -- eleventy.config.js, api/events.js, a CI workflow.
 * Deriving the path here from a validated type and a slugified slug (or
 * title, as a fallback) reduces the write surface to one directory whatever
 * the client sends: fields.slug is run through slugify() before it is ever
 * used, never trusted raw, so it still cannot escape src/posts/ or name an
 * arbitrary file. An author CAN choose their own address, though -- the
 * editor lets them hand-edit the slug field, and discarding that choice
 * used to mean the file this endpoint wrote differed from the one
 * downloadPost() would have written for the same form state.
 */
import { POST_TYPES } from './post-types.mjs';
/* Imported, not redefined here: see lib/slug.mjs for why this endpoint and
   the editor (src/admin/text.js) must share one implementation. Re-exported
   too, so existing importers of slugify from this module still work. */
import { slugify } from './slug.mjs';
export { slugify };

/* The block types lib/render-blocks.mjs actually renders, verified by calling
   it with each. This list is load-bearing, not belt-and-braces: renderBlocks
   looks up BLOCK_RENDERERS[b.type] and returns '' on a miss, so an unknown
   block is dropped SILENTLY rather than throwing. The render gate in
   lib/publish.mjs cannot catch it. This is the only thing that can. */
const KNOWN_BLOCKS = new Set(['paragraph', 'heading', 'image', 'list', 'qa', 'quote']);

export function postPath(slug) {
  return `src/posts/${slug}.html`;
}

export function validatePublish(payload) {
  const fail = (message) => ({ ok: false, message });
  if (!payload || typeof payload !== 'object') return fail('Nothing was sent to publish.');

  const typeKey = String(payload.type || '').trim();
  const type = POST_TYPES[typeKey];
  if (!type) {
    return fail(`"${typeKey}" is not a post type. Choose one of: ${Object.keys(POST_TYPES).join(', ')}.`);
  }

  if (payload.mode !== 'create' && payload.mode !== 'update') {
    return fail('The editor did not say whether this is a new post or an edit. Reload and try again.');
  }

  const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
  const source = fields[type.slugSource];
  if (!String(source || '').trim()) {
    return fail(`Add a ${type.slugSource} — a ${type.label} post needs one before it can publish.`);
  }

  // An author-chosen slug is honoured, but never trusted raw: slugify()
  // still runs on it, so a hostile or malformed value (a traversal attempt,
  // stray punctuation) collapses to the same safe [a-z0-9-] shape a title
  // would. Falls back to the title/name's slug when no usable slug was
  // supplied, which is also what an untouched slug field already equals.
  const slug = slugify(fields.slug) || slugify(source);
  if (!slug) {
    return fail('That title has no letters or numbers in it, so it cannot become a web address. Add some words.');
  }

  const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
  for (const block of blocks) {
    const kind = block && block.type;
    if (!KNOWN_BLOCKS.has(kind)) {
      return fail(`This post contains a "${kind}" section, which the site does not know how to show.`);
    }
  }

  return { ok: true, type: typeKey, slug, path: postPath(slug), post: { ...fields, type: typeKey, slug, blocks } };
}
