import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POST_TYPES, DEFAULT_TYPE, typeKeyOf, typeOf, postTitle, sortedPostsOfType
} from '../lib/post-types.mjs';

test('the registry holds exactly the two types the site publishes', () => {
  assert.deepEqual(Object.keys(POST_TYPES).sort(), ['fff', 'post']);
  assert.equal(DEFAULT_TYPE, 'fff');
});

/* The seven posts migrated from Wix predate the type field. A file that loses
   the line by hand-edit must still publish, not fail the build. */
for (const value of [undefined, '', '   ', null]) {
  test(`a blank type (${JSON.stringify(value)}) is an fff post`, () => {
    assert.equal(typeKeyOf({ type: value }), 'fff');
    assert.equal(typeOf({ type: value }).prefix, 'fff-');
  });
}

test('typeKeyOf survives being handed nothing at all', () => {
  assert.equal(typeKeyOf(undefined), 'fff');
});

test('a news post resolves to the post type', () => {
  assert.equal(typeKeyOf({ type: 'post' }), 'post');
  assert.equal(typeOf({ type: 'post' }).prefix, 'post-');
  assert.equal(typeOf({ type: 'post' }).listing, 'happenings.html');
});

test('an unknown type names itself and the valid types', () => {
  assert.throws(() => typeOf({ type: 'newsletter' }), (err) => {
    assert.match(err.message, /newsletter/);
    assert.match(err.message, /fff/);
    assert.match(err.message, /post/);
    return true;
  });
});

test('an fff post with no title falls back to the interviewee', () => {
  assert.equal(postTitle({ type: 'fff', name: 'Shira Amrany' }),
    'FinTech Female Fridays: Meet Shira Amrany');
});

test('a news post with no title has no fallback', () => {
  assert.equal(postTitle({ type: 'post', name: 'Shira Amrany' }), '');
});

test('an explicit title wins for either type', () => {
  assert.equal(postTitle({ type: 'fff', title: 'A Title', name: 'X' }), 'A Title');
  assert.equal(postTitle({ type: 'post', title: 'A Title' }), 'A Title');
});

test('sortedPostsOfType filters by type and sorts newest first', () => {
  const posts = [
    { data: { type: 'post', isoDate: '2026-01-01', slug: 'old-news' } },
    { data: { type: 'fff', isoDate: '2026-09-01', slug: 'an-interview' } },
    { data: { type: 'post', isoDate: '2026-06-01', slug: 'new-news' } }
  ];
  assert.deepEqual(
    sortedPostsOfType(posts, 'post').map((p) => p.data.slug),
    ['new-news', 'old-news']
  );
  assert.deepEqual(
    sortedPostsOfType(posts, 'fff').map((p) => p.data.slug),
    ['an-interview']
  );
});

/* isoDate is optional in the editor. A post without one must not throw and
   must not land somewhere different on every build. */
test('a post with no isoDate sorts last rather than throwing', () => {
  const posts = [
    { data: { type: 'post', slug: 'undated' } },
    { data: { type: 'post', isoDate: '2026-06-01', slug: 'dated' } }
  ];
  assert.deepEqual(
    sortedPostsOfType(posts, 'post').map((p) => p.data.slug),
    ['dated', 'undated']
  );
});
