/* Events that are not in Luma.
 *
 * Every event on the site comes from the Luma calendar, which means an event
 * that was never created there -- a partner's event, a conference talk, a
 * chapter meetup organised elsewhere -- cannot be shown at all. These are
 * written into src/_data/manual-events/, one file each, and committed, so adding one is
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
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeManualEvents } from './event-entry.mjs';

/* Re-exported so api/events.js and the tests import the normaliser from the
   module they always did. The rules themselves live in event-entry.mjs,
   which the admin page imports too -- see that file's header. */
export { normalizeEntry, normalizeManualEvents } from './event-entry.mjs';

const DEFAULT_DIR = new URL('../src/_data/manual-events/', import.meta.url);

/* MANUAL_EVENTS_DIR exists so tests can point the loader at a temp directory
   instead of writing fixtures into src/_data/manual-events/, where a real
   event could be clobbered. It has no business being set in production: it
   would replace the committed events with whatever that path holds, and the
   endpoint would degrade to Luma-only with nothing in any log. An explicit
   `dir` argument still wins over it. */
function defaultDir() {
  const override = process.env.MANUAL_EVENTS_DIR;
  return override ? pathToFileURL(path.resolve(override) + path.sep) : DEFAULT_DIR;
}

export function loadManualEvents(now = new Date(), dir = defaultDir()) {
  /* A path string is accepted as well as a URL; new URL(name, base) needs a
     URL base with a trailing slash. */
  if (typeof dir === 'string') dir = pathToFileURL(path.resolve(dir) + path.sep);
  /* Read from disk on each call rather than imported as a module.
   *
   * A static or dynamic `import` of the JSON is cached by the ESM loader for
   * the life of the process, which makes the endpoint untestable: a test can
   * put a fixture in place, but every later call still sees whichever copy
   * was loaded first. Reading the files is also what vercel.json's
   * `includeFiles` for api/events.js exists to guarantee -- they sit outside
   * api/, so they are named there explicitly rather than left to the
   * bundler's tracing. Getting that glob wrong ships the endpoint with no
   * manual events at all, and it degrades to Luma-only in silence.
   *
   * One file per event rather than one array, because two authors appending
   * to an array lose an event and nothing reports it -- see the spec's "Why
   * one file per event".
   */
  let names;
  try {
    /* Sorted, so the input to normalizeManualEvents() is deterministic. The
       order does not survive mergeEvents(), which re-sorts chronologically,
       but it makes the id-collision fallback ("position in the list")
       reproducible between two reads of the same directory. */
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    /* The directory missing from the deployment degrades to "no manual
       events", exactly as a missing file did, so the Luma calendar still
       renders rather than the endpoint going down. */
    console.error('manual events: could not be loaded --', error && error.message);
    return [];
  }

  const entries = [];
  for (const name of names) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(new URL(name, dir), 'utf8'));
    } catch (error) {
      console.warn(`manual events: skipping ${name} -- ${error && error.message}`);
      continue;
    }
    /* Checked here rather than left to normalizeEntry(), which can only
       report a position in the list. A file is the unit an author thinks in,
       so the warning has to name one. */
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`manual events: skipping ${name} -- it does not hold a single event object`);
      continue;
    }
    entries.push(parsed);
  }

  return normalizeManualEvents(entries, now);
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
