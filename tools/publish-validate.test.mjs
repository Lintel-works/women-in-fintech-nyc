import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, postPath, validatePublish } from '../lib/publish-validate.mjs';

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
