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
import { normalizeManualEvents } from './event-entry.mjs';

/* Re-exported so api/events.js and the tests import the normaliser from the
   module they always did. The rules themselves live in event-entry.mjs,
   which the admin page imports too -- see that file's header. */
export { normalizeEntry, normalizeManualEvents } from './event-entry.mjs';

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
