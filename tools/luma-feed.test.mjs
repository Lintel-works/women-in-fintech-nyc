import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, fromEventPage, ICS_URL, CALENDAR_ID } from '../lib/luma-feed.mjs';

/* lib/luma-feed.mjs reads a Luma calendar with no API key, from two public
   sources: the iCal feed, which lists the events, and each event's own page,
   whose JSON-LD carries the cover image and the locality.
 *
 * Neither format is a published contract -- the feed is RFC 5545 as Luma
 * chooses to emit it, and the JSON-LD exists for search engines -- so the
 * fixtures below are copied from the live calendar rather than invented, and
 * every test about malformed input is really asking the same question: does
 * this degrade to a thinner event, or does it throw? */

/* Verbatim from api.lu.ma on 2026-10-31, CRLF and folding intact. The
   DESCRIPTION folds mid-word ("Ad\r\n dress"), which is exactly the case that
   silently truncates a value if unfolding is skipped. */
const LIVE_FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Luma//NYC Fintech Women//EN',
  'X-WR-CALNAME:NYC Fintech Women',
  'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'BEGIN:VEVENT',
  'DTSTART:20261112T233000Z',
  'DTEND:20261113T023000Z',
  'DTSTAMP:20261031T180631Z',
  'ORGANIZER;CN="NYC Fintech Women":MAILTO:calendar-invite@lu.ma',
  'UID:evt-GUb6os6a4GVCVyf@events.lu.ma',
  'SUMMARY:Standing Room Only: The Official NYC Fintech Women Chicago Chapter',
  '  Launch Party',
  'DESCRIPTION:Get up-to-date information at: https://luma.com/ulhqvxfu\\n\\nAd',
  ' dress:\\nCheck event page for more details.\\n\\nHosted by NYC Fintech Women',
  'LOCATION:https://luma.com/event/evt-GUb6os6a4GVCVyf',
  'GEO:41.89554019472543;-87.63726607904923',
  'STATUS:TENTATIVE',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

test('the live feed parses into one usable event', () => {
  const events = parseIcs(LIVE_FEED);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    uid: 'evt-GUb6os6a4GVCVyf@events.lu.ma',
    summary: 'Standing Room Only: The Official NYC Fintech Women Chicago Chapter Launch Party',
    start: '2026-11-12T23:30:00.000Z',
    end: '2026-11-13T02:30:00.000Z',
    url: 'https://luma.com/ulhqvxfu',
    geo: { lat: 41.89554019472543, lon: -87.63726607904923 }
  });
});

test('an event with no GEO line simply has none', () => {
  /* Online events carry no coordinates, and the caller has to cope rather
     than place them at latitude zero. */
  const events = parseIcs(vevent(['UID:z', 'DTSTART:20261112T233000Z', 'DESCRIPTION:at https://luma.com/x']));
  assert.equal(events[0].geo, null);
});

test('a malformed GEO line is discarded, not half-read', () => {
  const events = parseIcs(vevent([
    'UID:y', 'DTSTART:20261112T233000Z', 'GEO:north;west', 'DESCRIPTION:at https://luma.com/x'
  ]));
  assert.equal(events[0].geo, null);
});

test('a folded line is rejoined rather than truncated', () => {
  /* The summary is folded across two lines in the live feed. Reading lines
     naively keeps "...Chicago Chapter" and silently drops "Launch Party",
     which looks like a correct title and is not. */
  assert.match(parseIcs(LIVE_FEED)[0].summary, /Launch Party$/);
});

test('the short link is preferred over the evt-id one', () => {
  /* LOCATION carries https://luma.com/event/evt-xxxx, which redirects to the
     short link. Taking the short one from DESCRIPTION means the href on our
     page is the one a visitor would see anywhere else, and does not depend on
     that redirect continuing to exist. */
  assert.equal(parseIcs(LIVE_FEED)[0].url, 'https://luma.com/ulhqvxfu');
});

test('STATUS:TENTATIVE is ignored', () => {
  /* Luma stamps it on every event in this feed, confirmed ones included.
     Filtering on it would empty the calendar. */
  assert.equal(parseIcs(LIVE_FEED).length, 1);
});

const vevent = (lines) =>
  ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

test('a start time is read in each of the three forms Luma can emit', () => {
  const link = 'DESCRIPTION:at https://luma.com/x';
  const utc = parseIcs(vevent(['UID:a', 'DTSTART:20261112T233000Z', link]));
  assert.equal(utc[0].start, '2026-11-12T23:30:00.000Z');

  /* 17:30 in Chicago on 12 November is CST, UTC-6. Resolved through Intl so
     daylight saving is right without shipping a table. */
  const zoned = parseIcs(vevent(['UID:b', 'DTSTART;TZID=America/Chicago:20261112T173000', link]));
  assert.equal(zoned[0].start, '2026-11-12T23:30:00.000Z');

  /* An all-day event is a marker, not an instant. UTC midnight keeps the
     date itself correct; inventing a zone would move it for some readers. */
  const allDay = parseIcs(vevent(['UID:c', 'DTSTART;VALUE=DATE:20261112', link]));
  assert.equal(allDay[0].start, '2026-11-12T00:00:00.000Z');
});

test('a summer date in a named zone keeps daylight saving straight', () => {
  /* The same wall clock four months later is CDT, UTC-5. A fixed offset
     table would be an hour out here and nowhere else, which is the kind of
     bug nobody notices until an event is listed at the wrong time. */
  const events = parseIcs(vevent([
    'UID:d', 'DTSTART;TZID=America/Chicago:20260712T173000', 'DESCRIPTION:at https://luma.com/x'
  ]));
  assert.equal(events[0].start, '2026-07-12T22:30:00.000Z');
});

test('escaped characters come back as themselves', () => {
  const events = parseIcs(vevent([
    'UID:e',
    'DTSTART:20261112T233000Z',
    'SUMMARY:Drinks\\, dinner\\; and a talk',
    'DESCRIPTION:at https://luma.com/x'
  ]));
  assert.equal(events[0].summary, 'Drinks, dinner; and a talk');
});

test('an event with no usable start or no link is dropped, not guessed at', () => {
  const noStart = parseIcs(vevent(['UID:f', 'SUMMARY:When?', 'DESCRIPTION:at https://luma.com/x']));
  assert.deepEqual(noStart, []);

  const noLink = parseIcs(vevent(['UID:g', 'DTSTART:20261112T233000Z', 'SUMMARY:Where?']));
  assert.deepEqual(noLink, []);

  const unparsableStart = parseIcs(vevent(['UID:h', 'DTSTART:next tuesday', 'DESCRIPTION:at https://luma.com/x']));
  assert.deepEqual(unparsableStart, []);
});

test('a feed that is not a feed yields nothing rather than throwing', () => {
  /* The caller answers an empty list with the manual events. An exception
     here would instead be a 504 and no events at all. */
  for (const input of ['', 'not a calendar', '<html>503</html>', null, undefined]) {
    assert.deepEqual(parseIcs(input), [], `expected [] for ${JSON.stringify(input)}`);
  }
});

test('line endings may be LF as well as CRLF', () => {
  const lf = LIVE_FEED.replace(/\r\n/g, '\n');
  assert.deepEqual(parseIcs(lf), parseIcs(LIVE_FEED));
});

/* ---- the event page ---- */

const ldJson = (data) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(data)}</script></head></html>`;

/* Trimmed from the live Chicago event page, keeping every field that is read. */
const LIVE_EVENT = {
  '@context': 'https://schema.org',
  '@type': 'Event',
  url: 'https://luma.com/ulhqvxfu',
  name: 'Standing Room Only: The Official NYC Fintech Women Chicago Chapter Launch Party',
  eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
  location: {
    '@type': 'Place',
    name: 'Chicago, IL',
    address: { '@type': 'PostalAddress', addressLocality: 'Chicago', addressRegion: 'Illinois' }
  },
  image: [
    'https://images.lumacdn.com/cdn-cgi/image/width=1920/uploads/gw/dba10e90.png',
    'https://images.lumacdn.com/cdn-cgi/image/width=1200/event-social/a6/3a179755.png'
  ],
  startDate: '2026-11-12T17:30:00.000-06:00',
  endDate: '2026-11-12T20:30:00.000-06:00'
};

test('a live event page gives every field the feed does not', () => {
  assert.deepEqual(fromEventPage(ldJson(LIVE_EVENT)), {
    name: LIVE_EVENT.name,
    url: 'https://luma.com/ulhqvxfu',
    startAt: '2026-11-12T17:30:00.000-06:00',
    endAt: '2026-11-12T20:30:00.000-06:00',
    coverUrl: 'https://images.lumacdn.com/cdn-cgi/image/width=1920/uploads/gw/dba10e90.png',
    place: 'Chicago, IL',
    locality: 'Chicago',
    region: 'Illinois',
    online: false
  });
});

test('the generated share card is never chosen as the cover', () => {
  /* It has the title and date rendered into the picture, so it duplicates
     the card it would sit in. The real artwork is not always under the same
     path -- one live event has /uploads/, the other /gallery-images/ -- so
     the rule has to be exclusion, not a list of good paths. */
  /* Listed FIRST here on purpose. The live page happens to put the real
     artwork first, so a rule of "take image[0]" would pass against it and
     still be wrong -- nothing in the markup promises that order, and
     og:image on the same page advertises the share card. */
  const socialFirst = {
    ...LIVE_EVENT,
    image: [
      'https://images.lumacdn.com/cdn-cgi/image/width=1200/event-social/s1/share.png',
      'https://images.lumacdn.com/cdn-cgi/image/width=1920/gallery-images/s1/5a2246e6.png'
    ]
  };
  assert.match(fromEventPage(ldJson(socialFirst)).coverUrl, /gallery-images/);

  /* Unless it is all there is, in which case a generated picture beats the
     grey placeholder. */
  const onlySocial = { ...LIVE_EVENT, image: ['https://images.lumacdn.com/event-social/s1/share.png'] };
  assert.match(fromEventPage(ldJson(onlySocial)).coverUrl, /event-social/);
});

test('a missing location is tolerated, because one live event has none', () => {
  const { location, ...noLocation } = LIVE_EVENT;
  const read = fromEventPage(ldJson(noLocation));
  assert.equal(read.place, null);
  assert.equal(read.locality, null);
  assert.equal(read.name, LIVE_EVENT.name);
});

test('an online event is marked as one', () => {
  const online = { ...LIVE_EVENT, eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode' };
  assert.equal(fromEventPage(ldJson(online)).online, true);
});

test('a @graph array is read as well as a bare object', () => {
  const graph = [{ '@type': 'Organization', name: 'NYC Fintech Women' }, LIVE_EVENT];
  assert.equal(fromEventPage(ldJson(graph)).name, LIVE_EVENT.name);
});

test('a page this cannot read returns null rather than throwing', () => {
  /* This is the expected path the day Luma changes its markup: the caller
     keeps the event and shows it without a picture. An exception would lose
     the event, and with it the whole calendar. */
  const cases = {
    'no script at all': '<html><head><title>Luma</title></head></html>',
    'malformed JSON': '<script type="application/ld+json">{nope</script>',
    'a different @type': ldJson({ '@type': 'Organization', name: 'NYC Fintech Women' }),
    'an empty string': '',
    'null': null
  };
  for (const [what, html] of Object.entries(cases)) {
    assert.equal(fromEventPage(html), null, `expected null for ${what}`);
  }
});

test('a non-https image is refused', () => {
  /* The value becomes a background-image URL on a page we serve. */
  const insecure = { ...LIVE_EVENT, image: ['http://images.lumacdn.com/uploads/x.png'] };
  assert.equal(fromEventPage(ldJson(insecure)).coverUrl, null);
});

test('the feed URL names the calendar the site actually shows', () => {
  /* The id is public and appears in the embed URL on the site. Pinning it
     here means a typo is a failing test rather than a silently empty page. */
  assert.equal(CALENDAR_ID, 'cal-d9YW8e4H3RWitjA');
  assert.match(ICS_URL, /^https:\/\/api\.lu\.ma\/ics\/get\?entity=calendar&id=cal-/);
});
