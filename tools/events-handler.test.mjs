import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeManualEvents } from '../lib/manual-events.mjs';

/* api/events.js merges the Luma calendar with the files in src/_data/manual-events/.
   The two halves are unit-tested in tools/manual-events.test.mjs and
   tools/luma-feed.test.mjs; what this covers is the wiring -- that manual
   events reach the response at all, that they survive a Luma outage (the
   reason they are merged on the server rather than in the page), that the
   "Luma changed shape" alarm is still measured on Luma's own events rather
   than being silenced by them, and that enriching an event from its page is
   an improvement that can fail without costing the event.
 *
 * Fixtures go in a temp directory that MANUAL_EVENTS_DIR points the loader
 * at, never into src/_data/manual-events/, where a real event could be
 * clobbered and where a committed event would break the exact counts below.
 * lib/manual-events.mjs reads the directory on each call rather than
 * importing it, which is what makes this possible: an imported JSON module is
 * cached for the life of the process, so the first read would win for ever
 * and the handler could not be tested at all. */

const REAL_DIR = new URL('../src/_data/manual-events/', import.meta.url);
const REAL_BEFORE = fs.readdirSync(REAL_DIR).sort();

/* Every test in this file runs against an empty directory unless withManual()
   says otherwise. Without this, a test that calls the handler with no
   fixtures falls through to the real directory and starts failing the moment
   a real event is committed. Only the two tests that name REAL_DIR read it. */
const EMPTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'events-handler-empty-'));
const ENV_BEFORE = process.env.MANUAL_EVENTS_DIR;
process.env.MANUAL_EVENTS_DIR = EMPTY_DIR;

/* This file sets the override on purpose, and the loader warns about it on
   every call. Only that warning is dropped, so any other warning still shows. */
const realWarn = console.warn;
console.warn = (...args) => {
  if (String(args[0]).startsWith('MANUAL_EVENTS_DIR is set')) return;
  realWarn(...args);
};

/* The handler logs every upstream failure, and most tests here cause one on
   purpose. Silenced wholesale rather than by prefix: unlike the warning
   above, an unexpected console.error in this file is still a failing
   assertion somewhere, so nothing is lost by not reading it. */
const realError = console.error;
console.error = () => {};

after(() => {
  console.warn = realWarn;
  console.error = realError;
  if (ENV_BEFORE === undefined) delete process.env.MANUAL_EVENTS_DIR;
  else process.env.MANUAL_EVENTS_DIR = ENV_BEFORE;
  fs.rmSync(EMPTY_DIR, { recursive: true, force: true });
});

/* Far enough out that they never expire, and listed out of order so the
   merge has something real to sort. */
const FIXTURE = [
  { name: 'Manual later', startAt: '2030-08-01T18:00:00Z', url: 'https://example.com/b', city: 'sf' },
  { name: 'Manual sooner', startAt: '2030-06-01T18:00:00Z', url: 'https://example.com/a', city: 'nyc' }
];

async function withManual(entries, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-handler-'));
  entries.forEach((entry, index) => {
    fs.writeFileSync(path.join(dir, `event-${index}.json`), JSON.stringify(entry, null, 2) + '\n');
  });
  const previous = process.env.MANUAL_EVENTS_DIR;
  process.env.MANUAL_EVENTS_DIR = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.MANUAL_EVENTS_DIR;
    else process.env.MANUAL_EVENTS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function res() {
  const r = { code: null, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  return r;
}

/* Shaped like the live feed: CRLF, the short link only in DESCRIPTION, the
   evt-id form in LOCATION, and STATUS:TENTATIVE on everything -- which Luma
   really does stamp on confirmed events, so a test calendar that omitted it
   would not prove the handler ignores it. */
const icsFor = (events) => [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Luma//NYC Fintech Women//EN',
  ...events.flatMap((e) => [
    'BEGIN:VEVENT',
    `UID:evt-${e.uid}@events.lu.ma`,
    `DTSTART:${e.start}`,
    e.end ? `DTEND:${e.end}` : null,
    `SUMMARY:${e.summary || 'Luma ' + e.uid}`,
    `DESCRIPTION:Get up-to-date information at: ${e.link || 'https://luma.com/' + e.uid}`,
    `LOCATION:${e.location || 'https://luma.com/event/evt-' + e.uid}`,
    e.geo ? `GEO:${e.geo}` : null,
    'STATUS:TENTATIVE',
    'END:VEVENT'
  ].filter(Boolean)),
  'END:VCALENDAR'
].join('\r\n');

const pageFor = (fields) =>
  '<html><head><meta charset="utf-8">' +
  '<script type="application/ld+json">' +
  JSON.stringify({ '@context': 'https://schema.org', '@type': 'Event', ...fields }) +
  '</script></head><body></body></html>';

const CHICAGO = {
  name: 'Enriched name',
  url: 'https://luma.com/pretty',
  startDate: '2030-07-01T13:00:00.000-05:00',
  endDate: '2030-07-01T16:00:00.000-05:00',
  image: [
    'https://images.lumacdn.com/uploads/gw/real-cover.png',
    'https://images.lumacdn.com/event-social/a6/share-card.png'
  ],
  location: {
    '@type': 'Place',
    name: 'Chicago, IL',
    address: { '@type': 'PostalAddress', addressLocality: 'Chicago', addressRegion: 'Illinois' }
  },
  eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode'
};

/* Routes by URL the way the handler calls them: the feed once, then one
   request per event page. `pages` returns the HTML for a page URL, or null to
   make that page a 404. */
function serve({ ics = icsFor([]), feedOk = true, feedStatus = 200, pages = () => null } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/ics/get')) {
      return { ok: feedOk, status: feedStatus, text: async () => ics };
    }
    const body = pages(String(url));
    if (body == null) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}

const down = serve({ feedOk: false, feedStatus: 500 });
const timeout = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };

/* Parses as a VEVENT but points somewhere that is not Luma, so every event
   is dropped at the URL allowlist -- the shape of "the feed still loads but
   we no longer understand it". */
const brokenShape = serve({
  ics: icsFor([{ uid: 'x', start: '20300701T180000Z', link: 'https://evil.example/x', location: 'https://evil.example/x' }])
});

/* A fresh module instance per call so process.env changes take effect, the
   way tools/form-handler.test.mjs does it. */
let n = 0;
async function run({ fetchImpl, method = 'GET' } = {}) {
  n += 1;
  globalThis.fetch = fetchImpl || serve();
  const url = new URL('../api/events.js', import.meta.url).href + '?i=' + n;
  const { default: handler } = await import(url);
  const r = res();
  await handler({ method }, r);
  return r;
}

/* 20300701T180000Z and friends: the feed's own stamp format, not ISO. */
const stamp = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

test('every committed event file is usable', () => {
  /* The directory ships empty, but once events are added a typo in one of
     them should fail here rather than quietly vanish from the calendar. */
  const committed = REAL_BEFORE
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(new URL(name, REAL_DIR), 'utf8')));
  for (const event of normalizeManualEvents(committed)) {
    assert.ok(event.name, 'an event in the committed file has no name');
    assert.match(event.url, /^https:\/\//);
    assert.match(event.id, /^manual-/);
  }
});

test('manual events are merged into the Luma list in date order', async () => {
  await withManual(FIXTURE, async () => {
    const r = await run({
      fetchImpl: serve({ ics: icsFor([{ uid: 'luma1', start: '20300701T180000Z' }]) })
    });
    assert.equal(r.code, 200);
    assert.deepEqual(r.body.events.map((e) => e.name), ['Manual sooner', 'Luma luma1', 'Manual later']);
  });
});

test('a manual event carries the city chip it was given', async () => {
  /* The chapter pages filter this same payload by city, which is the whole
     reason the merge happens on the server. */
  await withManual(FIXTURE, async () => {
    const r = await run({ fetchImpl: serve() });
    assert.deepEqual(r.body.events.map((e) => e.city).sort(), ['nyc', 'sf']);
  });
});

test('an event page supplies the cover, the place and the city chip', async () => {
  const r = await run({
    fetchImpl: serve({
      ics: icsFor([{ uid: 'a', start: '20300701T180000Z' }]),
      pages: () => pageFor(CHICAGO)
    })
  });
  const [event] = r.body.events;
  assert.equal(event.name, 'Enriched name');
  assert.equal(event.url, 'https://luma.com/pretty');
  assert.equal(event.place, 'Chicago, IL');
  assert.equal(event.city, 'chi');
  /* Derived from the chip, so a Chicago event reads in Chicago time even for
     a visitor somewhere else -- which is what a date on a flyer means. */
  assert.equal(event.timezone, 'America/Chicago');
  /* The offset form from the page, not the feed's UTC: same instant, but it
     is the one that formats correctly. */
  assert.equal(event.startAt, '2030-07-01T13:00:00.000-05:00');
});

test('the cover is the real artwork, not Luma\'s generated share card', async () => {
  /* The /event-social/ image has the title and date rendered into it, so on
     a card that already shows both it reads as a duplicate. */
  const r = await run({
    fetchImpl: serve({
      ics: icsFor([{ uid: 'a', start: '20300701T180000Z' }]),
      pages: () => pageFor(CHICAGO)
    })
  });
  assert.equal(r.body.events[0].coverUrl, 'https://images.lumacdn.com/uploads/gw/real-cover.png');
});

test('an event whose page cannot be read is still an event', async () => {
  /* Enrichment is an improvement, not a dependency. A 404, a timeout or a
     Luma redesign costs the card its picture and nothing else. */
  for (const [what, pages] of [
    ['a 404', () => null],
    ['a page with no JSON-LD', () => '<html><head></head><body>nope</body></html>'],
    ['malformed JSON-LD', () => '<script type="application/ld+json">{broken</script>']
  ]) {
    const r = await run({
      fetchImpl: serve({ ics: icsFor([{ uid: 'a', start: '20300701T180000Z' }]), pages })
    });
    assert.equal(r.code, 200, `expected the event to survive ${what}`);
    assert.equal(r.body.events.length, 1, `expected the event to survive ${what}`);
    assert.equal(r.body.events[0].name, 'Luma a', `expected the feed's name after ${what}`);
    assert.equal(r.body.events[0].coverUrl, null);
  }
});

test('past events are dropped, and one still running is not', async () => {
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const hourAhead = new Date(Date.now() + 3600_000).toISOString();
  const lastYear = new Date(Date.now() - 365 * 86400_000).toISOString();
  const r = await run({
    fetchImpl: serve({
      ics: icsFor([
        { uid: 'over', summary: 'Over', start: stamp(lastYear), end: stamp(lastYear) },
        { uid: 'running', summary: 'Running', start: stamp(hourAgo), end: stamp(hourAhead) },
        { uid: 'soon', summary: 'Soon', start: '20300701T180000Z' }
      ])
    })
  });
  assert.deepEqual(r.body.events.map((e) => e.name), ['Running', 'Soon']);
});

test('only the soonest few events cost a page request', async () => {
  /* An event page is ~120KB. Without a cap, a busy calendar would mean
     megabytes on every cache miss and a real chance of the whole function
     timing out over nothing more than cover images. */
  const many = Array.from({ length: 11 }, (_, i) => ({
    uid: 'e' + i,
    start: `2030070${(i % 9) + 1}T1800${String(i).padStart(2, '0')}Z`
  }));
  /* Each page advertises its OWN canonical URL. A fixture where they all
     claim the same one is not merely unrealistic -- mergeEvents de-duplicates
     on it, so eleven events would collapse into one and the cap would appear
     to work for the wrong reason. */
  const fetchImpl = serve({
    ics: icsFor(many),
    pages: (url) => pageFor({ ...CHICAGO, url: 'https://luma.com/' + url.split('evt-').pop() })
  });
  const r = await run({ fetchImpl });

  assert.equal(r.body.events.length, 11, 'every event ships, enriched or not');
  const pageRequests = fetchImpl.calls.filter((url) => !url.includes('/ics/get'));
  assert.equal(pageRequests.length, 8, 'only the first 8 should be fetched');
  assert.equal(r.body.events.filter((e) => e.coverUrl).length, 8);
  assert.equal(r.body.events[8].coverUrl, null, 'the 9th ships without a cover');
  assert.ok(r.body.events[8].url, 'the 9th still has its link');
});

test('a Luma event has exactly the keys a manual event has', async () => {
  /* mergeEvents sorts the two sources into one list and the page reads them
     identically, so a field present on one and missing on the other is a card
     that renders differently for no reason the reader can see. */
  const r = await withManual(FIXTURE, async () =>
    run({ fetchImpl: serve({ ics: icsFor([{ uid: 'a', start: '20300701T180000Z' }]), pages: () => pageFor(CHICAGO) }) })
  );
  const luma = r.body.events.find((e) => e.id.startsWith('evt-'));
  const manual = r.body.events.find((e) => e.id.startsWith('manual-'));
  assert.ok(luma && manual, 'expected one event from each source');
  assert.deepEqual(Object.keys(luma).sort(), Object.keys(manual).sort());
});

test('a page that parses but says something unusable loses only that field', async () => {
  /* Every other enrichment test here is a failed READ. This is the other
     shape of the problem: the page loads, the JSON-LD parses, and one value
     is not what we can use. Preferring it blindly is how an improvement
     deletes the thing it was improving. */
  const ics = icsFor([{ uid: 'a', start: '20300701T180000Z' }]);

  /* A canonical URL we refuse -- a custom event domain, say. The feed's own
     short link was fine, so the event must survive on it. */
  const offDomain = await run({
    fetchImpl: serve({ ics, pages: () => pageFor({ ...CHICAGO, url: 'https://custom.example/x' }) })
  });
  assert.equal(offDomain.code, 200, 'an off-domain canonical URL must not delete the event');
  assert.equal(offDomain.body.events.length, 1);
  assert.equal(offDomain.body.events[0].url, 'https://luma.com/a');

  /* A date the browser would throw on. src/luma-events.js hands these to
     Intl, which raises RangeError from the fallback as well as the first
     attempt, taking the whole grid down with it. */
  const badDate = await run({
    fetchImpl: serve({ ics, pages: () => pageFor({ ...CHICAGO, startDate: 'next tuesday' }) })
  });
  assert.equal(badDate.body.events[0].startAt, '2030-07-01T18:00:00.000Z');
  assert.ok(Number.isFinite(Date.parse(badDate.body.events[0].startAt)));

  /* An image somewhere that is not Luma would put every visitor's IP and
     referer in a stranger's logs. */
  const foreignImage = await run({
    fetchImpl: serve({ ics, pages: () => pageFor({ ...CHICAGO, image: ['https://tracker.example/pixel.png'] }) })
  });
  assert.equal(foreignImage.body.events[0].coverUrl, null);
  assert.equal(foreignImage.body.events[0].name, 'Enriched name', 'the rest of the page still applies');
});

test('an unenriched event is placed by the coordinates in the feed', async () => {
  /* Without this every event past the enrich limit is 'other', and 'other'
     also chooses the timezone -- so a 17:30 Chicago event would be listed as
     6:30 PM. Wrong by an hour is worse than missing a picture. */
  const r = await run({
    fetchImpl: serve({
      ics: icsFor([{ uid: 'a', start: '20300701T223000Z', geo: '41.8955;-87.6372' }]),
      pages: () => null
    })
  });
  const [event] = r.body.events;
  assert.equal(event.city, 'chi');
  assert.equal(event.timezone, 'America/Chicago');
  /* And an event we could not read is not claimed to be in person. */
  assert.equal(event.locationType, 'unknown');
});

test('an event page is only fetched if its link passes the allowlist', async () => {
  /* LOCATION can be any https URL, so fetching it unchecked would let
     whoever writes the feed choose where this server sends a request -- and
     the reply supplies a name we render and an image we put on the page. */
  const fetchImpl = serve({
    ics: icsFor([{ uid: 'x', start: '20300701T180000Z', link: 'https://attacker.example/x', location: 'https://attacker.example/x' }]),
    pages: () => pageFor(CHICAGO)
  });
  await run({ fetchImpl });
  assert.deepEqual(
    fetchImpl.calls.filter((url) => !url.includes('/ics/get')),
    [],
    'no request should have been made to the address the feed named'
  );
});

test('the same event in both sources is shown once, as the live copy', async () => {
  /* A manual event exists so something shows when the feed cannot be read.
     Once the feed works, the same event being in both is the normal state,
     not an error -- but two identical cards is a visible bug. The Luma copy
     wins because a time changed in Luma is right there, where the committed
     file still says whatever it said when it was written. */
  const sameEvent = [{
    name: 'Committed copy',
    startAt: '2030-07-01T18:00:00Z',
    url: 'https://lu.ma/shared',
    city: 'chi'
  }];
  const r = await withManual(sameEvent, async () =>
    run({ fetchImpl: serve({ ics: icsFor([{ uid: 'shared', summary: 'Live copy', start: '20300701T180000Z' }]) }) })
  );
  assert.equal(r.body.events.length, 1, 'lu.ma/shared and luma.com/shared are one event');
  assert.equal(r.body.events[0].name, 'Live copy');
});

test('a 200 that is not a calendar is an outage, not an empty calendar', async () => {
  /* A maintenance page, a login interstitial or a move off iCal all parse to
     zero events. Reported as a quiet calendar they would be cached for five
     minutes with nothing in the log -- the exact masquerade the shape alarm
     exists to prevent, and one it cannot see, because it counts events that
     parsed. */
  const notACalendar = serve({ ics: '<!DOCTYPE html><html><body>We are down</body></html>' });
  const r = await run({ fetchImpl: notACalendar });
  assert.equal(r.code, 502);
  assert.equal(r.body.error, 'unrecognized_response');
  assert.equal(r.headers['cache-control'], undefined);

  await withManual(FIXTURE, async () => {
    const withFallback = await run({ fetchImpl: notACalendar });
    assert.equal(withFallback.code, 200);
    assert.equal(withFallback.body.degraded, true);
  });
});

test('manual events survive every way Luma can fail', async () => {
  /* src/luma-events.js keeps its built-in cards on any non-200, and those
     cards are invented placeholders -- so a real committed event must never
     be traded for them, whichever way the upstream breaks. */
  await withManual(FIXTURE, async () => {
    for (const [what, fetchImpl] of [['outage', down], ['timeout', timeout], ['shape change', brokenShape]]) {
      const r = await run({ fetchImpl });
      assert.equal(r.code, 200, `expected manual events to ship on a Luma ${what}`);
      assert.equal(r.body.degraded, true, `expected degraded:true on a Luma ${what}`);
      assert.equal(r.body.events.length, 2);
    }
  });
});

test('with nothing to fall back on, a failure is reported honestly', async () => {
  const cases = [
    [down, 502, 'upstream_error'],
    [timeout, 504, 'upstream_timeout'],
    [brokenShape, 502, 'unrecognized_response']
  ];
  for (const [fetchImpl, code, error] of cases) {
    const r = await run({ fetchImpl });
    assert.equal(r.code, code);
    assert.equal(r.body.error, error);
  }
});

test('a failure is never cached at the edge', async () => {
  /* The CDN would otherwise serve the failure for five minutes, and keep
     serving it stale for thirty more, long after Luma had recovered. */
  for (const fetchImpl of [down, timeout, brokenShape]) {
    const r = await run({ fetchImpl });
    assert.ok(r.code >= 500, `expected a failure status, got ${r.code}`);
    assert.equal(r.headers['cache-control'], undefined, `a ${r.code} must not be cached`);
  }
});

test('a successful response is cached at the edge', async () => {
  const r = await run({ fetchImpl: serve({ ics: icsFor([{ uid: 'a', start: '20300701T180000Z' }]) }) });
  assert.match(r.headers['cache-control'] || '', /s-maxage=300/);
});

test('an empty calendar is an empty calendar, not an error', async () => {
  const r = await run({ fetchImpl: serve() });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.events, []);
});

test('a calendar whose events have all finished is empty, not broken', async () => {
  /* Distinct from the shape-change alarm: the feed carries past events for
     ever, so "everything parsed and everything is over" is the normal state
     of a quiet calendar and must not be reported as an outage. */
  const lastYear = stamp(new Date(Date.now() - 365 * 86400_000).toISOString());
  const r = await run({ fetchImpl: serve({ ics: icsFor([{ uid: 'old', start: lastYear, end: lastYear }]) }) });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.events, []);
});

test('only GET is allowed', async () => {
  const r = await run({ method: 'POST', fetchImpl: serve() });
  assert.equal(r.code, 405);
});

test('the committed manual events directory was left exactly as it was found', () => {
  assert.deepEqual(fs.readdirSync(REAL_DIR).sort(), REAL_BEFORE);
});
