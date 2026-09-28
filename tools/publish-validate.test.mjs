import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, postPath, validatePublish } from '../lib/publish-validate.mjs';
import { serializePost } from '../lib/post-file.mjs';

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
