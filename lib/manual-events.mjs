/* Events that are not in Luma.
 *
 * Every event on the site comes from the Luma calendar, which means an event
 * that was never created there -- a partner's event, a conference talk, a
 * chapter meetup organised elsewhere -- cannot be shown at all. These are
 * written into src/_data/manual-events.json and committed, so adding one is
 * the same publish path as everything else on the site.
 *
 * They are merged in api/events.js rather than in the page, for two reasons:
 * the three chapter pages already call LumaEvents.load() with a city filter
 * and so get these for free, and src/luma-events.js keeps its built-in cards
 * whenever the request fails -- so a manual event merged in the browser would
 * disappear during exactly the Luma outage it is most needed for.
 *
 * Nothing here trusts the file. It is committed rather than submitted, but a
 * hand-edited entry with a missing date or a broken link would otherwise
 * render a card that goes nowhere, and one bad entry must not take the whole
 * calendar down -- so an invalid entry is dropped with a warning naming it,
 * and the rest still ship.
 */
import fs from 'node:fs';
import { slugify } from './slug.mjs';

/* The Events page filters on these chips (src/events.html). `other` is a real
   value, not a failure: it shows under "All cities" and matches no chip. */
const CITY_CHIPS = new Set(['nyc', 'sf', 'chi', 'other']);

/* What api/events.js reports for a Luma event. `meet` and `unknown` exist
   upstream but there is no reason to write either by hand. */
const LOCATION_TYPES = new Set(['offline', 'zoom']);

const MAX_TAGS = 3;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/* Any https URL, unlike api/events.js's eventUrl(), which accepts only lu.ma
   links. A manual event pointing at lu.ma would be in Luma already; the whole
   point is that these link somewhere else. http is refused rather than
   upgraded -- a mixed-content link from an https page is a broken link. */
function httpsUrl(value) {
  const url = text(value);
  return /^https:\/\/\S+$/i.test(url) ? url : '';
}

function timestamp(value) {
  const when = text(value);
  if (!when) return null;
  const parsed = new Date(when);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/* One entry, in exactly the shape api/events.js's present() produces for a
   Luma event, or null if it cannot be shown. The two must agree field for
   field: src/luma-events.js renders both through the same card(). */
function normalizeEntry(entry, now, position) {
  if (!entry || typeof entry !== 'object') return { error: 'not an object' };

  const name = text(entry.name);
  if (!name) return { error: 'no name' };

  const startAt = timestamp(entry.startAt);
  if (!startAt) return { error: `no readable startAt (${JSON.stringify(entry.startAt)})` };

  const url = httpsUrl(entry.url);
  if (!url) return { error: `no https url (${JSON.stringify(entry.url)})` };

  /* An unreadable endAt is refused rather than quietly treated as absent.
     Falling back to null looks harmless but changes when the event retires --
     "2026-07-01 9pm" would drop an evening event off the page at its start
     time instead of its end, with nothing to say why. */
  const endAt = timestamp(entry.endAt);
  if (entry.endAt != null && entry.endAt !== '' && !endAt) {
    return { error: `no readable endAt (${JSON.stringify(entry.endAt)})` };
  }

  /* Luma is asked for `after=<now>`, so past events never reach the page from
     there. A manual entry has no such query behind it and would sit on the
     calendar forever, so it retires itself. An event runs until it ends. */
  if ((endAt || startAt) < now) return { expired: true };

  const locationType = LOCATION_TYPES.has(entry.locationType) ? entry.locationType : 'offline';
  const city = CITY_CHIPS.has(entry.city) ? entry.city : 'other';

  return {
    event: {
      /* Prefixed so a manual event can never collide with a Luma id, and
         readable so it is obvious in the DOM where a card came from. A name
         that slugifies to nothing -- one written in a non-Latin script -- and
         two entries sharing a name both fall back to the position in the
         file, so an id is always present and always distinct. */
      id: 'manual-' + (slugify(entry.slug) || slugify(name) || String(position)),
      name,
      startAt: startAt.toISOString(),
      endAt: endAt ? endAt.toISOString() : null,
      timezone: text(entry.timezone) || 'America/New_York',
      coverUrl: httpsUrl(entry.coverUrl) || null,
      url,
      city,
      /* Matches present(): an online event with no place reads "Online"
         rather than leaving the line blank. */
      place: text(entry.place) || (locationType === 'zoom' ? 'Online' : ''),
      locationType,
      membersOnly: entry.membersOnly === true,
      tags: Array.isArray(entry.tags)
        ? entry.tags.map(text).filter(Boolean).slice(0, MAX_TAGS)
        : []
    }
  };
}

export function normalizeManualEvents(raw, now = new Date()) {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) console.error('manual events: expected an array');
    return [];
  }
  const events = [];
  /* Ids have to be distinct across the list, and two entries can reach the
     same one by sharing a name -- the same event run twice, which is the
     normal way a series is written. Only the list can see that, so it is
     settled here rather than per entry. */
  const taken = new Set();
  raw.forEach((entry, i) => {
    const result = normalizeEntry(entry, now, i + 1);
    if (result.event) {
      if (taken.has(result.event.id)) result.event.id += '-' + (i + 1);
      taken.add(result.event.id);
      events.push(result.event);
      return;
    }
    /* An expired entry is not a mistake, so it is not reported as one. */
    if (result.expired) return;
    console.warn(
      `manual events: skipping entry ${i + 1}` +
        (entry && entry.name ? ` ("${entry.name}")` : '') +
        ` -- ${result.error}`
    );
  });
  return events;
}

export function loadManualEvents(now = new Date()) {
  /* Read from disk on each call rather than imported as a module.
   *
   * A static or dynamic `import` of the JSON is cached by the ESM loader for
   * the life of the process, which makes the endpoint untestable: a test can
   * put a fixture in place, but every later call still sees whichever copy
   * was loaded first. Reading the file is also what vercel.json's
   * `includeFiles` for api/events.js exists to guarantee -- the file sits
   * outside api/, so it is named there explicitly rather than left to the
   * bundler's tracing.
   *
   * Any failure here -- the file missing from the deployment, or edited into
   * something that will not parse -- degrades to "no manual events" so the
   * Luma calendar still renders, rather than taking the endpoint down.
   */
  try {
    const raw = fs.readFileSync(new URL('../src/_data/manual-events.json', import.meta.url), 'utf8');
    return normalizeManualEvents(JSON.parse(raw), now);
  } catch (error) {
    console.error('manual events: could not be loaded --', error && error.message);
    return [];
  }
}

/* Luma events and manual ones, in one chronological list. Kept here, and
   pure, because it is the only place the two sources meet: api/events.js just
   hands it what it has. Luma is asked to sort and mostly does, but manual
   entries arrive in whatever order the file lists them, so the merged list is
   always re-sorted -- the page reads chronologically or it looks broken. */
export function mergeEvents(lumaEvents, manualEvents, max) {
  const all = [...(lumaEvents || []), ...(manualEvents || [])];
  all.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  return max ? all.slice(0, max) : all;
}
