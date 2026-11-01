/* GET /api/events — upcoming events from Luma, for the Events page.
 *
 * No API key, and nothing to configure. Luma's REST API requires a Luma Plus
 * subscription this calendar does not have, so the two PUBLIC sources are used
 * instead (lib/luma-feed.mjs explains both):
 *
 *   1. the calendar's iCal feed, which lists the events
 *   2. each event's own public page, whose JSON-LD carries the cover image,
 *      the locality and the start time with its local offset
 *
 * Step 2 costs one request per event, so only the soonest ENRICH_LIMIT are
 * enriched. Everything after that still ships with its name, date and link,
 * and src/luma-events.js draws its existing placeholder in place of a cover.
 *
 * It is deliberately narrow:
 *   - GET only
 *   - no request input is forwarded to Luma
 *   - the response is an explicit allowlist of public display fields
 */

import { loadManualEvents, mergeEvents } from '../lib/manual-events.mjs';
import { ICS_URL, parseIcs, fromEventPage } from '../lib/luma-feed.mjs';

const MAX_EVENTS = 24;
const UPSTREAM_TIMEOUT_MS = 8000;

/* Shorter than the feed's budget: these run in parallel AFTER it, so their
   timeout is additive, and a slow event page must not spend the whole
   function on an image. The worst case is therefore 8s + 4s = 12s, which is
   why vercel.json gives this function a maxDuration of 30 -- on the platform
   default the invocation would be killed before the catch below could serve
   the manual events, which is the one failure path with no fallback. */
const EVENT_PAGE_TIMEOUT_MS = 4000;

/* An event page is ~120KB, so enriching an unbounded calendar would mean
   megabytes per cache miss. Eight covers the home strip's three and the two
   each chapter page shows, with room over. */
const ENRICH_LIMIT = 8;

/* Luma is not hostile, but it is not ours either, and nothing in a fetch
   bounds how much it can send. The feed is ~1KB today and an event page
   ~120KB; these leave generous room while keeping a surprise bounded. The
   JSON-LD sits in the first 7KB of a page, so the page cap also stops us
   reading 100KB of markup we never look at. */
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_BYTES = 256 * 1024;

/* The Events page filters on these three chips. Anything else still shows
   under "All cities" but matches no city chip. */
const CITY_CHIPS = {
  nyc: ['new york', 'new york city', 'nyc', 'brooklyn', 'manhattan', 'queens'],
  sf: ['san francisco', 'sf', 'oakland', 'berkeley', 'palo alto', 'menlo park'],
  chi: ['chicago', 'evanston']
};

function cityChip(geo) {
  if (!geo) return 'other';
  const haystack = [geo.city, geo.city_state, geo.region]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  for (const [chip, names] of Object.entries(CITY_CHIPS)) {
    if (names.some((name) => haystack.includes(name))) return chip;
  }
  return 'other';
}

/* The feed gives absolute luma.com links; this still refuses anything else,
   because the value ends up as an href on a page we serve. */
function eventUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return /^https?:\/\/(www\.)?(lu\.ma|luma\.com)\//i.test(trimmed) ? trimmed : null;
  }
  if (!/^[\w-]+$/.test(trimmed)) return null;
  return 'https://lu.ma/' + trimmed;
}

/* Narrower than the scheme alone: this value becomes a background-image on
   a page we serve, so an arbitrary host would mean the feed could point every
   visitor's browser at it and collect their IP and referer. */
function safeImage(url) {
  if (typeof url !== 'string') return null;
  return /^https:\/\/[\w.-]*(?:lumacdn\.com|lu\.ma|luma\.com)\//i.test(url.trim()) ? url : null;
}

/* Rough boxes, not geocoding: the only question is which of three chips an
   event belongs to, and a point tens of miles outside all three is correctly
   none of them. Used only when the event page could not be read -- the page's
   own locality is exact and is preferred wherever it exists. */
const CITY_BOXES = {
  nyc: { lat: [40.45, 41.10], lon: [-74.30, -73.65] },
  sf: { lat: [37.20, 38.10], lon: [-122.60, -121.75] },
  chi: { lat: [41.60, 42.10], lon: [-88.00, -87.45] }
};

function chipFromGeo(geo) {
  if (!geo) return 'other';
  for (const [chip, box] of Object.entries(CITY_BOXES)) {
    if (geo.lat >= box.lat[0] && geo.lat <= box.lat[1] && geo.lon >= box.lon[0] && geo.lon <= box.lon[1]) {
      return chip;
    }
  }
  return 'other';
}

/* A date the browser can actually format. src/luma-events.js passes these
   straight to Intl, which throws RangeError on an unparseable one -- from the
   fallback as well as the first attempt -- and that escapes far enough to
   empty the whole grid. The feed's own value is validated by parseIcs; this
   guards the page's, which is only type-checked. */
function safeDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/* The ICS gives instants in UTC, which is correct but formats in the wrong
   zone for a reader. The chip is the best signal available for which wall
   clock an event is advertised in -- a New York event reads in Eastern even
   for a visitor in Berlin, which is what the date on a flyer means. */
const CHIP_TIMEZONES = {
  nyc: 'America/New_York',
  sf: 'America/Los_Angeles',
  chi: 'America/Chicago'
};

/* One ICS entry, plus whatever its page gave up, as the shape the front end
   and lib/manual-events.mjs both already speak. `page` is null whenever the
   event was past the enrich limit or its page could not be read. */
function present(entry, page) {
  /* The page's locality is exact; the feed's coordinates are a fallback for
     an event whose page was not read -- which is every event past the enrich
     limit. Without the fallback those all become 'other', and 'other' also
     picks the timezone, so a Chicago event would be listed an hour late. */
  const city = page
    ? cityChip({ city: page.locality, city_state: page.place, region: page.region })
    : chipFromGeo(entry.geo);

  return {
    id: String(entry.uid || ''),
    name: String((page && page.name) || entry.summary || 'Untitled event'),
    /* The page's times carry a local offset and the feed's are UTC. They are
       the same instant either way; the offset is the better value to hand a
       formatter, so prefer it -- but only once it is known to parse, since
       falling back to the feed's is strictly better than shipping a date the
       browser throws on. */
    startAt: safeDate(page && page.startAt) || entry.start || null,
    endAt: safeDate(page && page.endAt) || entry.end || null,
    timezone: CHIP_TIMEZONES[city] || 'America/New_York',
    coverUrl: safeImage(page && page.coverUrl),
    /* Each candidate is allowlisted in turn rather than picking one and
       validating it once: a page advertising a canonical URL we refuse --
       a custom domain, say -- would otherwise DELETE an event the feed
       described perfectly well, and the soonest events are the enriched
       ones, so it would be those that vanished. */
    url: eventUrl(page && page.url) || eventUrl(entry.url),
    city,
    place: (page && page.place) || (page && page.online ? 'Online' : ''),
    /* 'zoom' rather than a new 'online': src/luma-events.js and
       lib/event-entry.mjs already share this vocabulary, and widening it to
       say the same thing would mean touching both for no visible gain.
       'unknown' when there is no page, because an unenriched Zoom event
       labelled "In person" is a confident statement of something we did not
       check -- src/luma-events.js shows no location tag for 'unknown'. */
    locationType: page ? (page.online ? 'zoom' : 'offline') : 'unknown',
    /* Neither source exposes these. A members-only event is not in a public
       feed at all, and the card falls back to "In person" with no tags. */
    membersOnly: false,
    tags: []
  };
}

function sendEvents(response, lumaEvents, manualEvents, extra) {
  const ordered = mergeEvents(lumaEvents, manualEvents, MAX_EVENTS);
  return response.status(200).json({ events: ordered, count: ordered.length, ...extra });
}

/* Cache at the CDN so traffic spikes never reach Luma and the page stays
   fast. It also bounds the event-page requests this makes on their behalf:
   at five minutes, a busy day costs Luma about twelve rounds of them. */
function cacheAtEdge(response) {
  response.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
}

/* Reads at most `maxBytes`, so an upstream that answers with something far
   larger than expected costs a bounded amount of memory rather than whatever
   it felt like sending. Truncation is deliberate and silent: both parsers
   already treat input they cannot make sense of as "no events" and "no
   enrichment", which is the right answer for a half-read body too. */
async function readCapped(upstream, maxBytes) {
  if (!upstream.body || typeof upstream.body.getReader !== 'function') {
    /* Test stubs, and any runtime without a streaming body. */
    return (await upstream.text()).slice(0, maxBytes);
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length >= maxBytes) return out.slice(0, maxBytes);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return out;
}

async function fetchText(url, timeoutMs, maxBytes) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const upstream = await fetch(url, {
      headers: { accept: 'text/calendar, text/html;q=0.9, */*;q=0.1' },
      signal: abort.signal
    });
    return {
      ok: upstream.ok,
      status: upstream.status,
      text: upstream.ok ? await readCapped(upstream, maxBytes) : ''
    };
  } finally {
    clearTimeout(timer);
  }
}

/* Reads each event's page for the fields the feed does not carry. Never
   rejects: an event whose page times out, 404s or stops containing JSON-LD is
   still an event, and losing its cover is the whole cost. */
async function enrich(entries) {
  const settled = await Promise.allSettled(
    entries.map(async (entry) => {
      /* Allowlisted BEFORE the request, not just before rendering. The feed
         is a third party and LOCATION can be any https URL, so fetching it
         unchecked would let whoever writes the feed choose where this server
         sends a request -- and the reply supplies a name we render and an
         image URL we put on the page. */
      const target = eventUrl(entry.url);
      if (!target) return null;
      const page = await fetchText(target, EVENT_PAGE_TIMEOUT_MS, MAX_PAGE_BYTES);
      return page.ok ? fromEventPage(page.text) : null;
    })
  );
  return settled.map((outcome) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    console.error('Luma event page failed', outcome.reason && outcome.reason.name);
    return null;
  });
}

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  /* Read before Luma is even called, so every exit below can still serve
     them. src/luma-events.js keeps its built-in cards on any non-200, and
     those cards are placeholders — an invented panel, an invented mixer — so
     a real manual event is better than falling back to them. */
  const manual = loadManualEvents();

  try {
    const feed = await fetchText(ICS_URL, UPSTREAM_TIMEOUT_MS, MAX_FEED_BYTES);

    if (!feed.ok) {
      console.error('Luma ICS error', feed.status);
      if (manual.length) {
        cacheAtEdge(response);
        return sendEvents(response, [], manual, { source: 'manual', degraded: true });
      }
      return response.status(502).json({ error: 'upstream_error', status: feed.status });
    }

    /* A 200 that is not a calendar at all -- a maintenance page, a login
       interstitial, a JSON error, a move off iCal -- would otherwise parse to
       zero events and be reported as a quiet calendar, cached for five
       minutes, with nothing in the log. That is precisely the "masquerading
       as an empty calendar" case the alarm below exists to prevent, and the
       alarm cannot see it, because it measures events that parsed. */
    if (!feed.text.includes('BEGIN:VCALENDAR')) {
      console.error('Luma feed was not a calendar — format may have changed');
      if (manual.length) {
        cacheAtEdge(response);
        return sendEvents(response, [], manual, { source: 'manual', degraded: true });
      }
      return response.status(502).json({ error: 'unrecognized_response', received: 0 });
    }

    const parsed = parseIcs(feed.text);

    /* The feed carries past events indefinitely -- the live one still lists
       an October event in November -- so filtering here is what makes this
       "upcoming". Measured on the END where there is one: an event that
       started an hour ago is still on. */
    const now = Date.now();
    const upcoming = parsed
      .filter((entry) => Date.parse(entry.end || entry.start) >= now)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .slice(0, MAX_EVENTS);

    const pages = await enrich(upcoming.slice(0, ENRICH_LIMIT));

    const lumaEvents = upcoming
      .map((entry, index) => present(entry, pages[index] || null))
      .filter((event) => event.url);

    /* A feed with VEVENTs that all drop out means we failed to read it —
       surface that instead of masquerading as an empty calendar. Measured on
       the Luma events alone: manual events always survive their own
       validation, so counting them here would mask the very shape change this
       exists to catch. But not counting them is not a reason to withhold
       them, so a manual event still ships — this is an outage like any other,
       and the built-in cards it would otherwise fall back to are invented. */
    if (parsed.length && !lumaEvents.length && upcoming.length) {
      console.error('Luma feed had %d events but none were usable — format may have changed', parsed.length);
      if (manual.length) {
        cacheAtEdge(response);
        return sendEvents(response, [], manual, { source: 'manual', degraded: true });
      }
      /* Deliberately uncached: the CDN would otherwise serve this failure for
         five minutes, and keep serving it stale for thirty more, long after
         Luma recovered. */
      return response.status(502).json({ error: 'unrecognized_response', received: parsed.length });
    }

    cacheAtEdge(response);
    /* Merged here rather than in the browser: the chapter pages each call
       LumaEvents.load() with a city filter and pick these up for free.
       Capped at MAX_EVENTS across both sources, which is what "the next 24
       events" means — adding a manual event does push the furthest-out Luma
       event past the end of the list, and that is the intended reading. */
    return sendEvents(response, lumaEvents, manual);
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    console.error('Luma fetch failed', timedOut ? 'timeout' : error);
    if (manual.length) {
      cacheAtEdge(response);
      return sendEvents(response, [], manual, { source: 'manual', degraded: true });
    }
    return response.status(504).json({ error: timedOut ? 'upstream_timeout' : 'fetch_failed' });
  }
}
