import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, postPath, validatePublish } from '../lib/publish-validate.mjs';
import { serializePost } from '../lib/post-file.mjs';
import { POST_TYPES } from '../lib/post-types.mjs';

test('a title becomes a slug', () => {
  assert.equal(slugify('October in Review: Three Sold-Out Nights'), 'october-in-review-three-sold-out-nights');
});

test('a valid news payload passes and computes its own path', () => {
  const result = validatePublish({
    type: 'post',
    mode: 'create',
    fields: { title: 'October Recap' },
    blocks: [{ type: 'paragraph', text: 'A paragraph.' }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.slug, 'october-recap');
  assert.equal(result.path, 'src/posts/october-recap.html');
});

test('a title that is only punctuation is refused, not silently pathed', () => {
  const result = validatePublish({
    type: 'post', mode: 'create', fields: { title: '...' }, blocks: []
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /letters or numbers/);
});

test('a traversal in the title cannot escape src/posts', () => {
  const result = validatePublish({
    type: 'post', mode: 'create', fields: { title: '../../eleventy.config' }, blocks: []
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, 'src/posts/eleventy-config.html');
  assert.ok(!result.path.includes('..'), 'path escaped src/posts/');
});

test('slugify never emits a path separator or a dot segment', () => {
  for (const hostile of ['../x', 'a/b/c', '..', './.', 'x\\y', '%2e%2e']) {
    const slug = slugify(hostile);
    assert.ok(!slug.includes('/'), `slash survived in ${hostile}`);
    assert.ok(!slug.includes('\\'), `backslash survived in ${hostile}`);
    assert.ok(slug !== '..' && slug !== '.', `dot segment survived in ${hostile}`);
  }
});

test('a very long title is capped and does not end in a hyphen', () => {
  const slug = slugify('word '.repeat(200));
  assert.ok(slug.length <= 80, `slug was ${slug.length} characters`);
  assert.ok(!slug.endsWith('-'), 'slug ended in a hyphen');
});

test('an emoji-only title is refused', () => {
  const result = validatePublish({
    type: 'post', mode: 'create', fields: { title: '🎉🎉🎉' }, blocks: []
  });
  assert.equal(result.ok, false);
});

test('an unknown post type is refused naming the known ones', () => {
  const result = validatePublish({
    type: 'newsletter', mode: 'create', fields: { title: 'Hello' }, blocks: []
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /fff/);
});

test('an unknown block type is refused', () => {
  const result = validatePublish({
    type: 'post', mode: 'create', fields: { title: 'Hello' },
    blocks: [{ type: 'video', src: 'x' }]
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /video/);
});

test('an fff post slugs from name, not title', () => {
  const result = validatePublish({
    type: 'fff', mode: 'create', fields: { name: 'Jane Doe' }, blocks: []
  });
  assert.equal(result.ok, true);
  assert.equal(result.slug, 'jane-doe');
});

/* Round 2 fix: an earlier version of this endpoint always recomputed the
   slug from the title and discarded whatever the editor sent, even when the
   author had hand-edited the slug field. That silently rewrote the address
   the author chose, and -- because publishPayload() sends the same slug
   downloadPost() would have written to the file -- made the published file
   differ from the downloaded one for any post with a touched slug. These
   four tests are the regression guard for that fix. */

test('a hand-edited slug is honoured, not recomputed from the title', () => {
  const result = validatePublish({
    type: 'post', mode: 'create',
    fields: { title: 'October in Review', slug: 'oct-recap' },
    blocks: []
  });
  assert.equal(result.ok, true);
  assert.equal(result.slug, 'oct-recap');
  assert.equal(result.path, 'src/posts/oct-recap.html');
});

test('a hostile hand-edited slug is sanitised, not trusted raw', () => {
  const result = validatePublish({
    type: 'post', mode: 'create',
    fields: { title: 'October in Review', slug: '../../eleventy.config' },
    blocks: []
  });
  assert.equal(result.ok, true);
  assert.ok(!result.path.includes('..'), 'path escaped src/posts/');
  assert.ok(result.path.startsWith('src/posts/'), 'path left src/posts/');
});

test('a slug that sanitises to nothing falls back to the title', () => {
  const result = validatePublish({
    type: 'post', mode: 'create',
    fields: { title: 'October Recap', slug: '...' },
    blocks: []
  });
  assert.equal(result.ok, true);
  assert.equal(result.slug, 'october-recap');
});

test('a hand-edited slug publishes byte-identically to what the editor would have downloaded', () => {
  // The object buildPostObject() (src/admin/editor.js) would have produced
  // for this form state, and what downloadPost() would serialize to a file.
  const downloadedPost = {
    title: 'October in Review',
    slug: 'oct-recap',
    tag: 'Event recap',
    author: 'Manvir Singh',
    isoDate: '2026-10-14',
    readTime: '4 min',
    gradient: 'g2',
    intro: 'It was a wonderful night.',
    coverPath: 'images/post-oct-recap.jpg',
    headshot: 'images/post-oct-recap.jpg',
    displayDate: 'Oct 14',
    type: 'post',
    blocks: [{ type: 'paragraph', text: 'It was a wonderful night.' }]
  };

  // publishPayload()'s split: blocks and type move out of fields to their
  // own top-level keys before the request is sent.
  const { blocks, type, ...fields } = downloadedPost;
  const result = validatePublish({ type, mode: 'create', fields, blocks });

  assert.equal(result.ok, true);
  assert.equal(serializePost(result.post), serializePost(downloadedPost));
});

/* Round 3 fix: the round-2 byte-identity test above used 'oct-recap', a
   slug already in canonical form -- it could not have caught a
   normalisation mismatch, because there was nothing left for either side to
   normalise. A slug typed directly into the editor's slug field was stored
   raw (only badSlugChars gated it, which is charset-only: it accepts
   "abc--def", "-abc-", a trailing "--", or any length), while resolved()
   downstream sent that raw value straight through. slugify() collapses
   repeated separators, trims leading/trailing hyphens, and caps at 80
   characters, so the server disagreed with the client on exactly those
   shapes. src/admin/editor.js's resolved() now runs model.slug through
   slugify() before anything downstream (the download filename, coverPath,
   the published payload) sees it, so the client is canonical BY
   CONSTRUCTION and can no longer disagree with the server no matter what an
   author typed. These four cases are the shapes that used to diverge. */
const HAND_TYPED_SLUG_SHAPES = [
  { typed: 'abc--def', label: 'a double hyphen' },
  { typed: '-abc-', label: 'a leading and trailing hyphen' },
  { typed: 'trailing--', label: 'a trailing hyphen run' },
  { typed: 'a'.repeat(90), label: 'a slug over the 80-character cap' }
];

for (const { typed, label } of HAND_TYPED_SLUG_SHAPES) {
  test(`a directly-typed slug with ${label} publishes byte-identically to what the editor would download`, () => {
    const type = 'post';
    const title = 'October in Review';

    // What src/admin/editor.js's resolved() now computes for model.slug --
    // slugify(model.slug) with the existing fallback to the source field
    // preserved. This is the fix under test: before it, this line would
    // have been the raw `typed` value.
    const clientSlug = slugify(typed) || slugify(title);

    // The object buildPostObject() would produce and downloadPost() would
    // write to a file, using that canonical slug throughout -- including
    // coverPath, which is derived from the same slug and would otherwise
    // point at an image api/publish.js never wrote.
    const downloadedPost = {
      title,
      slug: clientSlug,
      intro: 'It was a wonderful night.',
      coverPath: 'images/' + POST_TYPES[type].prefix + clientSlug + '.jpg',
      headshot: 'images/' + POST_TYPES[type].prefix + clientSlug + '.jpg',
      displayDate: 'Oct 14',
      type,
      blocks: []
    };

    // publishPayload()'s split: blocks and type move to their own top-level
    // payload keys before the request is sent.
    const { blocks, type: sentType, ...fields } = downloadedPost;
    const result = validatePublish({ type: sentType, mode: 'create', fields, blocks });

    assert.equal(result.ok, true);
    assert.equal(result.slug, clientSlug, `client slug "${clientSlug}" and server slug "${result.slug}" disagree for ${JSON.stringify(typed)}`);
    assert.equal(serializePost(result.post), serializePost(downloadedPost));

    // The cover image api/publish.js actually writes for this post --
    // coverPath (web-relative, no src/ prefix) must name the same file.
    const serverImagePath = `src/images/${POST_TYPES[type].prefix}${result.slug}.jpg`;
    assert.equal('src/' + downloadedPost.coverPath, serverImagePath);
  });
}
