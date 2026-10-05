/* One manual event, normalised — the half of manual events that touches
 * nothing.
 *
 * Split out of lib/manual-events.mjs so the browser can import it. The admin
 * page at /admin/events/ has to refuse exactly what this refuses, in the
 * field, where the author can see it; lib/manual-events.mjs reads the
 * filesystem and so can never be served, and a second copy of these rules in
 * the page is the drift lib/slug.mjs's header was written about. One
 * implementation, imported by both sides.
 *
 * Nothing here trusts its input. An entry is committed rather than submitted
 * today and submitted rather than committed tomorrow, and neither is a reason
 * to render a card that goes nowhere -- so an invalid entry is dropped with a
 * warning naming it, and the rest still ship.
 */
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
export function normalizeEntry(entry, now, position) {
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
