import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEntry, normalizeManualEvents } from '../lib/event-entry.mjs';

/* A manual event's cover can come from two places, and they are not the same
   field: a partner hosts theirs, and an author uploads one that this site
   then serves. The second is site-relative, which httpsUrl() refuses by
   design -- so it gets its own field with its own rules, and those rules are
   the only thing standing between a submitted string and a repository path. */

const NOW = new Date('2026-06-01T12:00:00Z');
const future = '2026-07-01T18:00:00Z';

const valid = (extra) => Object.assign({
  name: 'Fintech Forward with SVB',
  startAt: future,
  url: 'https://www.svb.com/events/fintech-forward'
}, extra || {});

test('a site-relative coverPath becomes the card\'s coverUrl', () => {
  const { event } = normalizeEntry(
    valid({ coverPath: 'images/event-svb-fintech-forward.jpg' }), NOW, 1);
  assert.equal(event.coverUrl, 'images/event-svb-fintech-forward.jpg');
});

test('a png coverPath is accepted', () => {
  const { event } = normalizeEntry(valid({ coverPath: 'images/event-a.png' }), NOW, 1);
  assert.equal(event.coverUrl, 'images/event-a.png');
});

test('coverPath cannot traverse out of images/', () => {
  for (const path of [
    '../lib/github.mjs',
    'images/../../lib/github.mjs',
    'images/../secrets.json',
    '/images/event-a.jpg',
    '/etc/passwd'
  ]) {
    const result = normalizeEntry(valid({ coverPath: path }), NOW, 1);
    assert.ok(result.error, `${path} should be refused`);
    assert.match(result.error, /coverPath/);
  }
});

test('coverPath refuses an absolute URL — that is what coverUrl is for', () => {
  const result = normalizeEntry(
    valid({ coverPath: 'https://example.com/cover.jpg' }), NOW, 1);
  assert.ok(result.error);
});

test('coverPath refuses a file type the site does not serve as a cover', () => {
  const result = normalizeEntry(valid({ coverPath: 'images/event-a.svg' }), NOW, 1);
  assert.ok(result.error);
});

test('http is still refused for both cover fields', () => {
  const hosted = normalizeEntry(valid({ coverUrl: 'http://example.com/c.jpg' }), NOW, 1);
  /* coverUrl keeps its existing forgiving behaviour: an unusable one is no
     cover, not a refusal. The card falls back to its gradient. */
  assert.equal(hosted.event.coverUrl, null);

  const uploaded = normalizeEntry(valid({ coverPath: 'http://example.com/c.jpg' }), NOW, 1);
  assert.ok(uploaded.error);
});

test('coverPath wins when both are set — the author uploaded that one', () => {
  const { event } = normalizeEntry(valid({
    coverUrl: 'https://example.com/hosted.jpg',
    coverPath: 'images/event-a.jpg'
  }), NOW, 1);
  assert.equal(event.coverUrl, 'images/event-a.jpg');
});

test('no cover at all is still null', () => {
  const { event } = normalizeEntry(valid(), NOW, 1);
  assert.equal(event.coverUrl, null);
});

/* Review Focus 3: the form must never send this, and the degradation is
   pinned rather than left to luck. */
test('a tags string rather than an array degrades to no tags', () => {
  const { event } = normalizeEntry(valid({ tags: 'Partner event' }), NOW, 1);
  assert.deepEqual(event.tags, []);
});

test('a manual event still has exactly the fields it had before', () => {
  const { event } = normalizeEntry(valid({ coverPath: 'images/event-a.jpg' }), NOW, 1);
  assert.deepEqual(Object.keys(event).sort(), [
    'city', 'coverUrl', 'endAt', 'id', 'locationType', 'membersOnly',
    'name', 'place', 'startAt', 'tags', 'timezone', 'url'
  ]);
});
