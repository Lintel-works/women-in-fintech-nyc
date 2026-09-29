import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { slugify } from '../lib/slug.mjs';
import { parsePost } from '../lib/post-file.mjs';
import { typeOf } from '../lib/post-types.mjs';

/* The regression guard for the slugify unification: the editor
   (src/admin/text.js) and the publish endpoint (lib/publish-validate.mjs)
   used to each define slugify separately and disagreed on accented names,
   apostrophes and length, so a real committed post -- D'aundra Lewis --
   would publish to a different path than the one it was downloaded as. This
   pins slugify(post's slug source) against every post actually committed to
   src/posts/, so a future edit to lib/slug.mjs (or a reintroduced second
   copy) that breaks a real post fails here instead of silently corrupting a
   publish. */
const POSTS_DIR = path.join(import.meta.dirname, '..', 'src', 'posts');
const FILES = fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.html'));

/* How many committed posts each slug source resolves to. Three women were
   interviewed twice, so one name has to address two files -- and only those
   names are allowed to. Counting rather than listing them keeps the exemption
   tied to the actual cause: a fourth repeat needs no edit here, and a slug
   that picks up a year suffix for any other reason still fails. */
const postsPerSource = new Map();
for (const file of FILES) {
  const post = parsePost(fs.readFileSync(path.join(POSTS_DIR, file), 'utf8'));
  const derived = slugify(post[typeOf(post).slugSource]);
  postsPerSource.set(derived, (postsPerSource.get(derived) || 0) + 1);
}

for (const file of FILES) {
  test(`slugify round-trips the committed slug for ${file}`, () => {
    const post = parsePost(fs.readFileSync(path.join(POSTS_DIR, file), 'utf8'));
    const type = typeOf(post);
    const source = post[type.slugSource];
    const derived = slugify(source);

    /* The later of two interviews with the same person keeps the bare slug and
       the earlier one carries its year -- see tools/fff-overrides.json. The
       post file states that slug itself, and lib/publish-validate.mjs honours a
       post's own slug over the one its name derives (`slugify(fields.slug) ||
       slugify(source)`), so republishing one cannot overwrite the other. The
       year must be a real four-digit year from this post's own isoDate, so a
       post with no date cannot slip through on a bare trailing hyphen. */
    const year = String(post.isoDate || '').slice(0, 4);
    const mayCarryYear = postsPerSource.get(derived) > 1 && /^\d{4}$/.test(year);
    const allowed = mayCarryYear ? [derived, `${derived}-${year}`] : [derived];
    assert.ok(
      allowed.includes(post.slug),
      `slugify(${JSON.stringify(source)}) produced "${derived}", ` +
        `but ${file} is committed as "${post.slug}"`
    );

    /* Whatever the slug is, it has to be one slugify would leave alone --
       otherwise a republish rewrites the filename and strands the old URL. */
    assert.equal(slugify(post.slug), post.slug, `${file} has a slug slugify would rewrite`);
  });
}
