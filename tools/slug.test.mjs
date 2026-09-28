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

for (const file of fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.html'))) {
  test(`slugify round-trips the committed slug for ${file}`, () => {
    const post = parsePost(fs.readFileSync(path.join(POSTS_DIR, file), 'utf8'));
    const type = typeOf(post);
    const source = post[type.slugSource];
    assert.equal(
      slugify(source),
      post.slug,
      `slugify(${JSON.stringify(source)}) produced "${slugify(source)}", ` +
        `but ${file} is committed as "${post.slug}"`
    );
  });
}
