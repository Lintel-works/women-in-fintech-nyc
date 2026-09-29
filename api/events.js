/* GET /api/events — upcoming events from Luma, for the Events page.
 *
 * Why this exists: the Luma API key is scoped to a whole calendar and grants
 * FULL access to it (create/cancel events, read guest lists). It can never be
 * shipped to the browser, so this function is the only thing that holds it.
 *
 * It is deliberately narrow:
 *   - GET only
 *   - no request input is forwarded to Luma
 *   - the response is an explicit allowlist of public display fields; guest
 *     data, emails and submitted_by never leave this file
 *
 * Env: LUMA_API_KEY — a calendar-scoped key from
 * luma.com/calendar/manage/api-keys (requires a Luma Plus subscription).
 */

import { loadManualEvents, mergeEvents } from '../lib/manual-events.mjs';

const LUMA_ENDPOINT = 'https://public-api.luma.com/v1/calendars/events/list';
const MAX_EVENTS = 24;
const UPSTREAM_TIMEOUT_MS = 8000;

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

/* Luma returns `url` as a bare slug ("i5ju0s29"), but has used absolute URLs
   before — handle both, and refuse anything that isn't http(s). */
function eventUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return /^https?:\/\/(www\.)?(lu\.ma|luma\.com)\//i.test(trimmed) ? trimmed : null;
  }
  if (!/^[\w-]+$/.test(trimmed)) return null;
  return 'https://lu.ma/' + trimmed;
}

function safeImage(url) {
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null;
}

/* Luma's newer endpoint returns event fields flat on each entry; the older
   one nested them under `entry.event`. Accept either so a shape change on
   their side degrades to nothing rather than an empty page. */
function unwrap(entry) {
  return entry && typeof entry.event === 'object' && entry.event ? entry.event : entry;
}

function present(raw) {
  const entry = unwrap(raw);
  return {
    id: String(entry.id || ''),
    name: String(entry.name || 'Untitled event'),
    startAt: entry.start_at || null,
    endAt: entry.end_at || null,
    timezone: entry.timezone || 'America/New_York',
    coverUrl: safeImage(entry.cover_url),
    url: eventUrl(entry.url),
    city: cityChip(entry.geo_address_json),
    place:
      (entry.geo_address_json && (entry.geo_address_json.city_state || entry.geo_address_json.city)) ||
      (entry.location_type === 'zoom' || entry.location_type === 'meet' ? 'Online' : ''),
    locationType: entry.location_type || 'unknown',
    membersOnly: entry.visibility === 'members-only',
    tags: Array.isArray(entry.tags)
      ? entry.tags.map((t) => String(t && t.name ? t.name : '')).filter(Boolean).slice(0, 3)
      : []
  };
}

function sendEvents(response, lumaEvents, manualEvents, extra) {
  const ordered = mergeEvents(lumaEvents, manualEvents, MAX_EVENTS);
  return response.status(200).json({ events: ordered, count: ordered.length, ...extra });
}

/* Cache at the CDN so traffic spikes never reach Luma's rate limit
   (200 req/min per calendar) and the page stays fast. */
function cacheAtEdge(response) {
  response.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
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

  const apiKey = process.env.LUMA_API_KEY;
  if (!apiKey) {
    // Not an outage — the integration simply isn't wired up yet.
    if (manual.length) {
      cacheAtEdge(response);
      return sendEvents(response, [], manual, { source: 'manual' });
    }
    // The page falls back to its built-in events when it sees this.
    return response.status(503).json({
      error: 'not_configured',
      message: 'LUMA_API_KEY is not set for this deployment.'
    });
  }

  const query = new URLSearchParams({
    after: new Date().toISOString(),
    sort_column: 'start_at',
    sort_direction: 'asc',
    pagination_limit: String(MAX_EVENTS)
  });

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(`${LUMA_ENDPOINT}?${query}`, {
      headers: { 'x-luma-api-key': apiKey, accept: 'application/json' },
      signal: abort.signal
    });

    if (!upstream.ok) {
      // Surface the upstream status, but never the body — it can echo the key
      // back in error messages.
      console.error('Luma API error', upstream.status, upstream.statusText);
      if (manual.length) {
        cacheAtEdge(response);
        return sendEvents(response, [], manual, { source: 'manual', degraded: true });
      }
      return response.status(502).json({
        error: 'upstream_error',
        status: upstream.status
      });
    }

    const data = await upstream.json();
    const entries = Array.isArray(data.entries) ? data.entries : [];

    const lumaEvents = entries
      .map(unwrap)
      .filter((entry) => entry && entry.visibility !== 'private')
      .filter((entry) => entry.start_at)
      .map(present)
      .filter((event) => event.url);

    /* A calendar with events that all drop out means we failed to read the
       payload — surface that instead of masquerading as an empty calendar.
       Measured on the Luma events alone: manual events always survive their
       own validation, so counting them here would mask the very shape change
       this exists to catch. But not counting them is not a reason to withhold
       them, so a manual event still ships — this is an outage like any other,
       and the built-in cards it would otherwise fall back to are invented. */
    if (entries.length && !lumaEvents.length) {
      console.error('Luma returned %d entries but none were usable — response shape may have changed', entries.length);
      if (manual.length) {
        cacheAtEdge(response);
        return sendEvents(response, [], manual, { source: 'manual', degraded: true });
      }
      /* Deliberately uncached: the CDN would otherwise serve this failure for
         five minutes, and keep serving it stale for thirty more, long after
         Luma recovered. */
      return response.status(502).json({ error: 'unrecognized_response', received: entries.length });
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
  } finally {
    clearTimeout(timer);
  }
}
