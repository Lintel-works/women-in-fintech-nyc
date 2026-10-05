import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManualEvents, mergeEvents } from '../lib/manual-events.mjs';

/* src/_data/manual-events.json is hand-edited and committed, so its entries
   are trusted about as far as any hand-edited file: a missing date or a link
   that goes nowhere would render a card a visitor can click into nothing, and
   one bad entry must not take the whole calendar down with it. */

const NOW = new Date('2026-06-01T12:00:00Z');
const future = '2026-07-01T18:00:00Z';

const valid = () => ({
  name: 'Fintech Women at Money20/20',
  startAt: future,
  url: 'https://example.com/event'
});

function quiet(fn) {
  /* The module warns about what it drops, which is the point of it -- but a
     passing test run should not be full of warnings. */
  const warn = console.warn;
  const error = console.error;
  const messages = [];
  console.warn = (...args) => messages.push(args.join(' '));
  console.error = (...args) => messages.push(args.join(' '));
  try {
    return { result: fn(), messages };
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

test('a complete entry keeps every field it was given', () => {
  const [event] = normalizeManualEvents([{
    name: 'Chapter Mixer',
    slug: 'chapter-mixer',
    startAt: future,
    endAt: '2026-07-01T21:00:00Z',
    timezone: 'America/Chicago',
    coverUrl: 'https://example.com/cover.jpg',
    url: 'https://example.com/rsvp',
    city: 'chi',
    place: 'River North, Chicago',
    locationType: 'offline',
    membersOnly: true,
    tags: ['Mixer', 'In person']
  }], NOW);

  assert.equal(event.id, 'manual-chapter-mixer');
  assert.equal(event.name, 'Chapter Mixer');
  assert.equal(event.city, 'chi');
  assert.equal(event.membersOnly, true);
  assert.equal(event.coverUrl, 'https://example.com/cover.jpg');
  assert.deepEqual(event.tags, ['Mixer', 'In person']);
});

test('a manual event has exactly the fields a Luma event has', () => {
  /* src/luma-events.js renders both through one card(). A field this forgets
     is a blank line on the page for manual events only. */
  const [event] = normalizeManualEvents([valid()], NOW);
  assert.deepEqual(Object.keys(event).sort(), [
    'city', 'coverUrl', 'endAt', 'id', 'locationType', 'membersOnly',
    'name', 'place', 'startAt', 'tags', 'timezone', 'url'
  ]);
});

test('the id is prefixed so it can never collide with a Luma id', () => {
  const [event] = normalizeManualEvents([valid()], NOW);
  assert.match(event.id, /^manual-/);
});

test('an entry with no name, no date or no link is dropped', () => {
  for (const [field, bad] of [['name', ''], ['startAt', 'not a date'], ['url', '']]) {
    const entry = { ...valid(), [field]: bad };
    const { result, messages } = quiet(() => normalizeManualEvents([entry], NOW));
    assert.equal(result.length, 0, `expected an entry with a bad ${field} to be dropped`);
    assert.ok(messages.join(' ').includes('skipping'), `expected a warning naming the dropped ${field}`);
  }
});

test('one bad entry does not take the good ones with it', () => {
  const { result } = quiet(() =>
    normalizeManualEvents([{ name: 'Broken' }, valid()], NOW)
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].name, valid().name);
});

test('a link that is not https is refused', () => {
  /* http from an https page is a mixed-content link, which is a broken one.
     Unlike api/events.js's eventUrl(), any https host is fine -- an event
     already on lu.ma would not need a manual entry. */
  const { result } = quiet(() =>
    normalizeManualEvents([{ ...valid(), url: 'http://example.com/e' }], NOW)
  );
  assert.equal(result.length, 0);
  assert.equal(normalizeManualEvents([valid()], NOW).length, 1);
});

test('an event that has already finished retires itself', () => {
  /* Luma is queried with after=<now>, so its past events never reach the
     page. Nothing does that for a file, so the file has to do it itself. */
  const past = normalizeManualEvents([{ ...valid(), startAt: '2026-05-01T18:00:00Z' }], NOW);
  assert.equal(past.length, 0);

  /* An event that started this morning and ends tonight is still on. */
  const running = normalizeManualEvents([{
    ...valid(),
    startAt: '2026-06-01T09:00:00Z',
    endAt: '2026-06-01T22:00:00Z'
  }], NOW);
  assert.equal(running.length, 1);
});

test('an unknown city falls back to the one the chips treat as a catch-all', () => {
  /* src/events.html compares city exactly against all|nyc|sf|chi. */
  const [event] = normalizeManualEvents([{ ...valid(), city: 'boston' }], NOW);
  assert.equal(event.city, 'other');
});

test('an online event with no place still reads "Online"', () => {
  const [event] = normalizeManualEvents([{ ...valid(), locationType: 'zoom' }], NOW);
  assert.equal(event.place, 'Online');
});

test('tags are capped at three, matching the Luma path', () => {
  const [event] = normalizeManualEvents([{ ...valid(), tags: ['a', 'b', 'c', 'd'] }], NOW);
  assert.deepEqual(event.tags, ['a', 'b', 'c']);
});

test('a file that is not an array yields nothing rather than throwing', () => {
  for (const bad of [{}, 'nope', 42]) {
    const { result } = quiet(() => normalizeManualEvents(bad, NOW));
    assert.deepEqual(result, []);
  }
  assert.deepEqual(normalizeManualEvents(undefined, NOW), []);
});

test('merging re-sorts both sources into one chronological list', () => {
  const luma = [
    { id: 'a', startAt: '2026-07-10T00:00:00Z' },
    { id: 'b', startAt: '2026-07-20T00:00:00Z' }
  ];
  const manual = [{ id: 'm', startAt: '2026-07-15T00:00:00Z' }];
  assert.deepEqual(mergeEvents(luma, manual).map((e) => e.id), ['a', 'm', 'b']);
});

test('merging caps the list and keeps the earliest events', () => {
  const luma = [
    { id: 'late', startAt: '2026-09-01T00:00:00Z' },
    { id: 'early', startAt: '2026-07-01T00:00:00Z' }
  ];
  assert.deepEqual(mergeEvents(luma, [], 1).map((e) => e.id), ['early']);
});

test('merging copes with either side being absent', () => {
  assert.deepEqual(mergeEvents(null, null), []);
  assert.equal(mergeEvents([{ id: 'a', startAt: future }], undefined).length, 1);
});

/* The committed file, and the dynamic import that reads it, are exercised in
   tools/events-handler.test.mjs instead. That file is the only one that
   touches src/_data/manual-events.json, so nothing races it. */

test('an endAt that cannot be read is refused, not quietly ignored', () => {
  /* Treating it as absent looks harmless but changes when the event retires:
     an evening event would drop off the page at its start time instead of its
     end, with nothing in the logs to say why. */
  const { result, messages } = quiet(() =>
    normalizeManualEvents([{ ...valid(), endAt: '2026-07-01 9pm' }], NOW)
  );
  assert.equal(result.length, 0);
  assert.ok(messages.join(' ').includes('endAt'), 'the warning should name the field');

  /* Absent is still fine — endAt is optional. */
  assert.equal(normalizeManualEvents([{ ...valid(), endAt: null }], NOW).length, 1);
  assert.equal(normalizeManualEvents([valid()], NOW).length, 1);
});

test('an id is always present and distinct, whatever the name', () => {
  /* Nothing renders the id today, but two entries collapsing to one id is the
     kind of thing that only bites once something does. */
  const [nonLatin] = normalizeManualEvents([{ ...valid(), name: '東京' }], NOW);
  assert.equal(nonLatin.id, 'manual-1');

  const shared = normalizeManualEvents([valid(), valid()], NOW);
  assert.notEqual(shared[0].id, shared[1].id);
});
