/* The index the editor's post-list drawer reads.
 *
 * It exists because there are 261 posts: asking GitHub for each one's front
 * matter to draw a list would be 261 requests per drawer open. The build
 * already holds every post in a collection, so the list is emitted there and
 * the editor fetches one static file.
 *
 * The entries have to carry what a row shows and what opening one needs --
 * slug, type and url -- because the editor has no filesystem to look any of
 * it up in. That is the whole point of the feature.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPostsIndex, postsIndexEntry } from '../lib/posts-index.mjs';

const fff = (over) => ({ slug: 'shira-amrany', name: 'Shira Amrany', type: 'fff', ...over });

test('an entry carries what a row shows and what opening it needs', () => {
  const entry = postsIndexEntry(fff({
    title: 'Meet Shira', displayDate: 'Jul 10', isoDate: '2026-07-10'
  }));

  assert.equal(entry.slug, 'shira-amrany');
  assert.equal(entry.type, 'fff');
  assert.equal(entry.name, 'Shira Amrany');
  assert.equal(entry.title, 'Meet Shira');
  assert.equal(entry.displayDate, 'Jul 10');
  assert.equal(entry.isoDate, '2026-07-10');
  assert.equal(entry.url, 'fff-shira-amrany.html', 'the url must carry the type prefix');
});

test('the url uses the type prefix, not a hardcoded one', () => {
  const entry = postsIndexEntry({ slug: 'october-recap', title: 'October Recap', type: 'post' });
  assert.equal(entry.url, 'post-october-recap.html');
});

/* A post with no type is an FFF interview -- the seven migrated from Wix were
   written before the field existed. The list must show them, not drop them. */
test('a post with no type is indexed as an FFF interview', () => {
  const entry = postsIndexEntry({ slug: 'old-one', name: 'Someone' });
  assert.equal(entry.type, 'fff');
  assert.equal(entry.url, 'fff-old-one.html');
});

test('an FFF post with no title falls back the way the post page does', () => {
  const entry = postsIndexEntry(fff({ title: '' }));
  assert.equal(entry.title, 'FinTech Female Fridays: Meet Shira Amrany');
});

/* Dropped rather than thrown: one unopenable post must not take the whole
   list -- and the drawer -- down with it. */
test('an entry with no slug is dropped, because nothing could open it', () => {
  assert.equal(postsIndexEntry(fff({ slug: '' })), null);
});

test('an entry with an unknown type is dropped rather than throwing', () => {
  assert.equal(postsIndexEntry({ slug: 'x', name: 'X', type: 'nonsense' }), null);
});

test('the index is newest first, with undated posts last', () => {
  const index = buildPostsIndex([
    { data: fff({ slug: 'may', name: 'May', isoDate: '2026-05-21' }) },
    { data: fff({ slug: 'undated', name: 'Undated' }) },
    { data: fff({ slug: 'july', name: 'July', isoDate: '2026-07-10' }) }
  ]);

  assert.deepEqual(index.map((e) => e.slug), ['july', 'may', 'undated']);
});

test('the index drops unusable entries but keeps the rest', () => {
  const index = buildPostsIndex([
    { data: fff({ slug: '' }) },
    { data: fff({ slug: 'good', name: 'Good', isoDate: '2026-07-10' }) }
  ]);

  assert.deepEqual(index.map((e) => e.slug), ['good']);
});

test('it accepts bare post data as well as collection items', () => {
  const index = buildPostsIndex([fff({ isoDate: '2026-07-10' })]);
  assert.equal(index.length, 1);
  assert.equal(index[0].slug, 'shira-amrany');
});
