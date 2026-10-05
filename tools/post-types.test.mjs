import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POST_TYPES, DEFAULT_TYPE, typeKeyOf, typeOf, postTitle, sortedPostsOfType, coverPathFor
} from '../lib/post-types.mjs';
import { TYPES } from '../src/admin/types.js';

test('the registry holds exactly the two types the site publishes', () => {
  assert.deepEqual(Object.keys(POST_TYPES).sort(), ['fff', 'post']);
  assert.equal(DEFAULT_TYPE, 'fff');
});

/* Jobs & Happenings is held back from launch. It must stay REGISTERED while
   hidden: api/unpublish.js refuses an unknown type, so removing the entry
   would strand any published post of it, and the renderer would lose the
   prefix and partials needed to rebuild one. This pins both halves -- if
   someone deletes the entry instead of the flag, the test above fails; if
   someone unhides it without meaning to, this one does. */
test('the post type is registered but hidden, and fff is not', () => {
  assert.equal(POST_TYPES.post.hidden, true);
  assert.ok(!POST_TYPES.fff.hidden, 'the default type must never be hidden');
});

// FIX 4 (final wave): the one cover-path convention, shared now by the
// editor, the renderer, and both publish endpoints -- there used to be four
// separate implementations of this same shape.
test('coverPathFor derives the convention path, honouring the given extension', () => {
  assert.equal(coverPathFor('fff', 'shira-amrany', 'jpg'), 'images/fff-shira-amrany.jpg');
  assert.equal(coverPathFor('post', 'october-recap', 'png'), 'images/post-october-recap.png');
});

test('coverPathFor falls back to a placeholder slug and jpg', () => {
  assert.equal(coverPathFor('fff', '', undefined), 'images/fff-post.jpg');
});

test('coverPathFor throws the same author-readable error typeOf does for an unknown type', () => {
  assert.throws(() => coverPathFor('bogus', 's', 'jpg'), /Unknown post type "bogus"/);
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

/* The collection names are what the listing templates loop. A type added to
   the registry without one would publish posts that appear on no page. */
test('every type names a collection, and the names are distinct', () => {
  const names = Object.values(POST_TYPES).map((type) => type.collection);
  assert.deepEqual(names, ['fff', 'happenings']);
  assert.equal(new Set(names).size, names.length);
});

test('every type names a hero, a foot, a listing page and a prefix', () => {
  for (const [key, type] of Object.entries(POST_TYPES)) {
    for (const field of ['label', 'prefix', 'listing', 'collection', 'hero', 'foot', 'cardBadge', 'tagFallback', 'slugSource']) {
      assert.equal(typeof type[field], 'string', `${key}.${field} must be a string`);
      assert.ok(type[field].length, `${key}.${field} must not be empty`);
    }
  }
});

/* Half-adding a type is the failure this catches: an entry in one registry and
   not the other means either a post type the editor cannot write, or a form
   that produces files the build rejects. */
test('the editor has a form for every registered type, and no others', () => {
  assert.deepEqual(Object.keys(TYPES).sort(), Object.keys(POST_TYPES).sort());
});

test('every editor type has fields and the full block list', () => {
  for (const [key, def] of Object.entries(TYPES)) {
    assert.ok(Array.isArray(def.fields) && def.fields.length, `${key} needs fields`);
    assert.deepEqual([...def.blocks].sort(),
      ['heading', 'image', 'list', 'paragraph', 'qa', 'quote']);
  }
});

/* The field a post's slug is derived from has to be a field the form actually
   shows, or the slug never fills in. */
test('each type derives its slug from one of its own required fields', () => {
  for (const [key, type] of Object.entries(POST_TYPES)) {
    const field = TYPES[key].fields.find((f) => f.key === type.slugSource);
    assert.ok(field, `${key}.slugSource "${type.slugSource}" is not a field on the form`);
    assert.equal(field.required, true, `${key}.slugSource must be required`);
  }
});

test('a news post form has no interviewee fields', () => {
  const keys = TYPES.post.fields.map((f) => f.key);
  for (const absent of ['name', 'role', 'company', 'linkedin']) {
    assert.ok(!keys.includes(absent), `post form must not carry "${absent}"`);
  }
  assert.ok(keys.includes('title'));
  assert.ok(keys.includes('author'));
});
