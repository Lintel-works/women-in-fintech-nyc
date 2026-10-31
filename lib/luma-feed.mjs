/* Reads a public Luma calendar without an API key.
 *
 * Luma's REST API needs a Luma Plus subscription, which this calendar does not
 * have and is not going to buy. Two public sources replace it:
 *
 *   parseIcs()      the calendar's iCal feed — ENUMERATES the events. Cheap
 *                   (about 1KB) but thin: a name, a start, an end, a link.
 *   fromEventPage() one event's public page — ENRICHES it, from the JSON-LD
 *                   block Luma emits for search engines, which carries the
 *                   cover image, the locality and the start time with its
 *                   local offset.
 *
 * Both are pure functions over text so they can be tested without a network.
 * Neither throws on malformed input: a feed that stops parsing should cost the
 * page its Luma events, which api/events.js answers with the manual ones, and
 * a page that stops parsing should cost one card its image, not the request.
 */

/* Not a secret, and not an env var: it is the same id already baked into the
   public embed URL on the site. An env var would imply it rotates. */
export const CALENDAR_ID = 'cal-d9YW8e4H3RWitjA';
export const ICS_URL = `https://api.lu.ma/ics/get?entity=calendar&id=${CALENDAR_ID}`;

/* RFC 5545 folds any line over 75 octets by inserting CRLF and one space or
   tab. Luma folds mid-word -- the live feed splits "Address" as "Ad\r\n dress"
   -- so unfolding has to happen before anything is split into lines, or every
   long value is silently truncated at the fold. */
function unfold(text) {
  return String(text == null ? '' : text).replace(/\r?\n[ \t]/g, '');
}

/* \\ must go last: unescaping it first would turn a literal "\\n" (backslash,
   then n) into a newline that was never in the source. */
function unescapeText(value) {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/* How far `timeZone` is from UTC at `instant`, in minutes. Resolved through
   Intl rather than a table so daylight saving is right without shipping one. */
function offsetMinutes(instant, timeZone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant)
    .find((part) => part.type === 'timeZoneName');
  const match = name && /GMT([+-])(\d{2}):(\d{2})/.exec(name.value);
  if (!match) return 0;
  const magnitude = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -magnitude : magnitude;
}

/* An iCal date-time in one of the three shapes Luma can emit:
     20261112T233000Z          UTC, which is what this calendar actually sends
     20261112T173000           local to the TZID parameter
     20261112                  an all-day event (VALUE=DATE)
   Returns an ISO string, or null if it is none of those. */
function toIso(value, tzid) {
  const stamp = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value || '').trim());
  if (!stamp) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', zulu] = stamp;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (!Number.isFinite(asUtc)) return null;

  /* Already UTC, or an all-day date with no zone to apply. An all-day event
     is a marker rather than an instant, so UTC midnight is the honest reading
     -- inventing a zone for it would shift the date itself for some readers. */
  if (zulu || !tzid) return new Date(asUtc).toISOString();

  /* The wall-clock time is known but the instant is not, and the offset
     depends on the instant. Resolve once against the naive guess, then again
     against the corrected one: the second pass is what gets a time sitting
     within an hour of a daylight-saving change right. */
  let guess = asUtc - offsetMinutes(new Date(asUtc), tzid) * 60000;
  guess = asUtc - offsetMinutes(new Date(guess), tzid) * 60000;
  return new Date(guess).toISOString();
}

/* Luma puts the event's canonical short link in the DESCRIPTION ("Get
   up-to-date information at: https://luma.com/ulhqvxfu") and the long
   evt-id form in LOCATION. The short one is what a visitor should see, and
   taking it from here means not depending on the redirect that maps one to
   the other. */
function linkFrom(description, location) {
  const inDescription = /https:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/[\w-]+/i.exec(description || '');
  if (inDescription) return inDescription[0];
  const trimmed = String(location || '').trim();
  return /^https:\/\//i.test(trimmed) ? trimmed : null;
}

/* The feed's VEVENTs, as { uid, summary, start, end, url }. `start` and `end`
   are ISO strings; `end` may be null. Events the parser cannot place in time
   or link to are dropped rather than guessed at. */
export function parseIcs(text) {
  const lines = unfold(text).split(/\r?\n/);
  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) {
        const start = toIso(current.dtstart, current.dtstartTz);
        const url = linkFrom(current.description, current.location);
        /* STATUS is deliberately not read. Luma stamps TENTATIVE on every
           event in this feed, including confirmed ones, so filtering on it
           would empty the calendar. */
        if (start && url) {
          events.push({
            uid: current.uid || '',
            summary: current.summary || '',
            start,
            end: toIso(current.dtend, current.dtendTz),
            url,
            /* The only location the feed carries, and the only thing that
               tells an UNENRICHED event which clock to display in. Without
               it a Chicago event past the enrich limit reads an hour late. */
            geo: current.geo || null
          });
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const rawName = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [name, ...params] = rawName.split(';');
    const tzid = (params.find((p) => /^TZID=/i.test(p)) || '').slice(5) || null;

    switch (name.toUpperCase()) {
      case 'UID':
        current.uid = value.trim();
        break;
      case 'SUMMARY':
        current.summary = unescapeText(value).trim();
        break;
      case 'DESCRIPTION':
        current.description = unescapeText(value);
        break;
      case 'LOCATION':
        current.location = unescapeText(value).trim();
        break;
      case 'DTSTART':
        current.dtstart = value;
        current.dtstartTz = tzid;
        break;
      case 'DTEND':
        current.dtend = value;
        current.dtendTz = tzid;
        break;
      case 'GEO': {
        /* "GEO:41.895;-87.637" -- latitude and longitude, semicolon
           separated, per RFC 5545. Absent on online events. */
        const [lat, lon] = value.split(';').map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lon)) current.geo = { lat, lon };
        break;
      }
      default:
        break;
    }
  }

  return events;
}

/* The organiser's own cover art, not Luma's share card.
 *
 * `image` holds both: the real artwork, under a path that varies by how it
 * was added (/uploads/ on one live event, /gallery-images/ on the other), and
 * an /event-social/ one Luma generates with the title and date rendered into
 * the picture. That second one reads as a duplicate of the card it would sit
 * in, so it is excluded rather than the real paths being listed -- a new path
 * for real artwork should be picked up automatically, and only the one known
 * bad kind ruled out. */
function coverFrom(image) {
  const urls = (Array.isArray(image) ? image : [image])
    .filter((url) => typeof url === 'string' && /^https:\/\//i.test(url));
  return urls.find((url) => !url.includes('/event-social/')) || urls[0] || null;
}

/* The fields of one event, read from the JSON-LD on its public page, or null
 * when the page does not carry any this function recognises.
 *
 * Returning null is the expected path for a Luma redesign, not an exception:
 * the caller keeps the event and shows it without an image. Parsed with a
 * regex rather than parse5 because parse5 is a devDependency and may not be
 * in the deployed function bundle. */
export function fromEventPage(html) {
  const block = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html || '');
  if (!block) return null;

  let data;
  try {
    data = JSON.parse(block[1]);
  } catch {
    return null;
  }
  /* Luma emits a bare object today, but a @graph array is the other common
     shape and costs one line to tolerate. */
  const event = Array.isArray(data) ? data.find((item) => item && item['@type'] === 'Event') : data;
  if (!event || event['@type'] !== 'Event') return null;

  const location = (event.location && typeof event.location === 'object') ? event.location : {};
  const address = (location.address && typeof location.address === 'object') ? location.address : {};

  return {
    name: typeof event.name === 'string' ? event.name : null,
    url: typeof event.url === 'string' ? event.url : null,
    startAt: typeof event.startDate === 'string' ? event.startDate : null,
    endAt: typeof event.endDate === 'string' ? event.endDate : null,
    coverUrl: coverFrom(event.image),
    /* Verified absent on a real event in this calendar, so every reader of
       these two has to tolerate null. */
    place: typeof location.name === 'string' ? location.name : null,
    locality: typeof address.addressLocality === 'string' ? address.addressLocality : null,
    region: typeof address.addressRegion === 'string' ? address.addressRegion : null,
    online: typeof event.eventAttendanceMode === 'string' && /Online/i.test(event.eventAttendanceMode)
  };
}
