# Manual Event Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a signed-in author a page at `/admin/events/` that adds an event to the site, corrects one that is already there, and takes a cancelled one down — without a checkout, a JSON file, or a developer.

**Architecture:** The data layer already exists and is tested. This plan splits its pure half into a module the browser can import, teaches it a site-relative cover path, moves manual events from one shared array to one file per event, adds three endpoints (add/update, list, remove) that each commit atomically, and builds the page that drives them.

**Tech Stack:** Node 22, ES modules, Eleventy 3, `node --test`, Clerk (session tokens), the GitHub Git Data API via `lib/github.mjs`, Vercel functions.

**Spec:** `docs/superpowers/specs/2026-10-04-manual-events-design.md`

## Global Constraints

- **Node 22, ES modules.** `package.json` sets `"type": "module"`. No CommonJS.
- **Tests are `node --test tools/*.test.mjs`,** run with `npm test`. A new test file goes in `tools/` and ends `.test.mjs`.
- **Two spaces for indentation. `async`/`await`, never `.then()` chains.**
- **`src/admin/**` is ignored by Eleventy** (`eleventyConfig.ignores.add('src/admin/**')`) and passthrough-copied verbatim to `/admin`. It is NOT a Nunjucks template: `{{ }}` and `{% %}` are literal text there, and there is no `{% include %}`. Anything shared between two admin pages has to be a real file the browser fetches — a `<link>` to a stylesheet or a `<script>` to a module — never a template include.
- **Only four `lib/*.mjs` modules are served to the browser** (`render-blocks`, `post-file`, `post-types`, `slug`). Any further module the admin pages import must be added to the `addPassthroughCopy` map in `eleventy.config.js`, or it 404s at runtime.
- **A module the browser imports may not import `node:fs`.** This is why Task 1 exists.
- **`http` is refused for every cover, both fields.** A mixed-content link from an https page is a broken link. Unchanged from today.
- **Cover images: 1600 × 1000 px, 16:10, JPG or PNG, under 3 MB.** `MAX_IMAGE_BYTES` is `3_000_000`; the allowlist is `jpg` and `png`.
- **Clerk session tokens live 60 seconds.** Call `clerk.session.getToken()` per request; never store one.
- **Author-readable refusals.** Every message an author can trigger is a sentence naming the field, not a code.

## Review Focus

These are the input classes the spec implies but does not give a task. Each one's test is written into the task that owns the code, named in brackets.

1. **A past event submitted through the form.** `normalizeEntry()` returns `{ expired: true }`, not `{ error }`. An endpoint that only checks `result.error` would commit a file that renders nowhere and gives the author a success message. It must refuse with its own sentence. [Task 5]
2. **A slug that collides only after slugifying.** "SVB Fintech Forward" and "SVB — Fintech Forward!" both slugify to `svb-fintech-forward`. The create/update check must run on the *slugified* slug, after `slugify()`, or the second event silently replaces the first. [Task 5]
3. **A `tags` value that is a string, not an array.** `normalizeEntry()` guards with `Array.isArray`, so it degrades to `[]` — but the form must not send one, and the test must pin the degradation rather than leave it to luck. [Task 3]
4. **A JSON file in the events directory that parses but is not an object** — `null`, `[]`, `42`, or an array of entries written by hand. `normalizeManualEvents()` receives it as one entry and `normalizeEntry()` returns `{ error: 'not an object' }`, which warns with a *position* and not a filename. The directory reader must name the file. [Task 4]
5. **A cover whose base64 carries a `data:image/jpeg;base64,` prefix.** `Buffer.from()` does not throw on it — it skips the non-alphabet characters and decodes to wrong bytes, committing a corrupt image. `isCleanBase64()` is the existing answer and must be applied here too, before any GitHub call. [Task 5]

---

### Task 1: Split the pure normalizer out of `lib/manual-events.mjs`

The spec requires the admin page to refuse in the browser exactly what `normalizeEntry()` refuses on the server. `lib/manual-events.mjs` imports `node:fs`, so the browser cannot import it — and writing the rules a second time in the page is precisely the bug `lib/slug.mjs`'s header documents ("One implementation, imported by both sides, is the only way … can hold").

This task moves every pure function into `lib/event-entry.mjs` and leaves `lib/manual-events.mjs` holding only the two functions that touch disk or merge lists. It re-exports what it moved, so `api/events.js` and `tools/manual-events.test.mjs` are untouched and must keep passing unchanged. **No behaviour changes in this task.**

**Files:**
- Create: `lib/event-entry.mjs`
- Modify: `lib/manual-events.mjs`
- Test: `tools/manual-events.test.mjs` (existing — must pass unchanged, not edited)

**Interfaces:**
- Consumes: `slugify` from `lib/slug.mjs`
- Produces:
  - `lib/event-entry.mjs` exports `normalizeEntry(entry, now, position)` → `{ event }` | `{ error: string }` | `{ expired: true }`, and `normalizeManualEvents(raw, now)` → `Array<event>`
  - `lib/manual-events.mjs` continues to export `normalizeManualEvents` (re-exported) and `mergeEvents`, and still exports `loadManualEvents`

- [ ] **Step 1: Run the existing tests to record the green baseline**

Run: `npm test -- --test-name-pattern='manual'`

Expected: PASS. Note the number of passing tests; the same number must pass at the end of this task.

- [ ] **Step 2: Create `lib/event-entry.mjs` with everything pure**

Move — do not retype — the following from `lib/manual-events.mjs`: `CITY_CHIPS`, `LOCATION_TYPES`, `MAX_TAGS`, `text()`, `httpsUrl()`, `timestamp()`, `normalizeEntry()` and `normalizeManualEvents()`, with their comments intact. Add the header below and export `normalizeEntry`.

```js
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

// … text(), httpsUrl(), timestamp() verbatim from lib/manual-events.mjs …

export function normalizeEntry(entry, now, position) {
  // … verbatim from lib/manual-events.mjs …
}

export function normalizeManualEvents(raw, now = new Date()) {
  // … verbatim from lib/manual-events.mjs …
}
```

- [ ] **Step 3: Reduce `lib/manual-events.mjs` to what is left**

Delete everything moved in Step 2. Keep the file header, `loadManualEvents()` and `mergeEvents()` exactly as they are. Add at the top, under the existing header:

```js
import fs from 'node:fs';
import { normalizeManualEvents } from './event-entry.mjs';

/* Re-exported so api/events.js and the tests import the normaliser from the
   module they always did. The rules themselves live in event-entry.mjs,
   which the admin page imports too -- see that file's header. */
export { normalizeEntry, normalizeManualEvents } from './event-entry.mjs';
```

The local `import { normalizeManualEvents }` is what `loadManualEvents()` calls; the `export { … } from` line is what everyone else imports. Both are needed. Delete the now-unused `import { slugify } from './slug.mjs';`.

- [ ] **Step 4: Run the tests to verify nothing changed**

Run: `npm test`

Expected: PASS, with the same count as Step 1. If `manual-events.test.mjs` fails, the move was not verbatim — diff the moved functions against `git show HEAD:lib/manual-events.mjs` rather than editing the test.

- [ ] **Step 5: Commit**

```bash
git add lib/event-entry.mjs lib/manual-events.mjs
git commit -m "Split the event normaliser out of the file reader

The admin page has to refuse what the build refuses, and lib/manual-events.mjs
imports node:fs, so the browser cannot have it. The pure half moves to
lib/event-entry.mjs and is re-exported, so nothing that imports it changes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `coverPath` — a site-relative cover

`normalizeEntry()` accepts a cover only as an absolute `https` URL. An uploaded image lives on this site, so it needs a site-relative path, which `httpsUrl()` refuses. This adds a second field beside `coverUrl` and leaves `coverUrl`'s meaning and validation exactly as they are.

The normalised output still emits a single `coverUrl`, so `src/luma-events.js` does not change: it sets `backgroundImage: url(…)` through `encodeURI`, which renders a relative path correctly.

**Files:**
- Modify: `lib/event-entry.mjs`
- Test: `tools/event-entry.test.mjs` (create)

**Interfaces:**
- Consumes: `normalizeEntry`, `normalizeManualEvents` from `lib/event-entry.mjs` (Task 1)
- Produces: `normalizeEntry()` accepts `entry.coverPath`; a valid one is emitted as the output's `coverUrl`. An invalid one returns `{ error }`.

- [ ] **Step 1: Write the failing tests**

Create `tools/event-entry.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEntry, normalizeManualEvents } from '../lib/event-entry.mjs';

/* A manual event's cover can come from two places, and they are not the same
   field: a partner hosts theirs, and an author uploads one that this site
   then serves. The second is site-relative, which httpsUrl() refuses by
   design -- so it gets its own field with its own rules, and those rules are
   the only thing standing between a submitted string and a repository path. */

const NOW = new Date('2026-06-01T12:00:00Z');
const future = '2026-07-01T18:00:00Z';

const valid = (extra) => Object.assign({
  name: 'Fintech Forward with SVB',
  startAt: future,
  url: 'https://www.svb.com/events/fintech-forward'
}, extra || {});

test('a site-relative coverPath becomes the card\'s coverUrl', () => {
  const { event } = normalizeEntry(
    valid({ coverPath: 'images/event-svb-fintech-forward.jpg' }), NOW, 1);
  assert.equal(event.coverUrl, 'images/event-svb-fintech-forward.jpg');
});

test('a png coverPath is accepted', () => {
  const { event } = normalizeEntry(valid({ coverPath: 'images/event-a.png' }), NOW, 1);
  assert.equal(event.coverUrl, 'images/event-a.png');
});

test('coverPath cannot traverse out of images/', () => {
  for (const path of [
    '../lib/github.mjs',
    'images/../../lib/github.mjs',
    'images/../secrets.json',
    '/images/event-a.jpg',
    '/etc/passwd'
  ]) {
    const result = normalizeEntry(valid({ coverPath: path }), NOW, 1);
    assert.ok(result.error, `${path} should be refused`);
    assert.match(result.error, /coverPath/);
  }
});

test('coverPath refuses an absolute URL — that is what coverUrl is for', () => {
  const result = normalizeEntry(
    valid({ coverPath: 'https://example.com/cover.jpg' }), NOW, 1);
  assert.ok(result.error);
});

test('coverPath refuses a file type the site does not serve as a cover', () => {
  const result = normalizeEntry(valid({ coverPath: 'images/event-a.svg' }), NOW, 1);
  assert.ok(result.error);
});

test('http is still refused for both cover fields', () => {
  const hosted = normalizeEntry(valid({ coverUrl: 'http://example.com/c.jpg' }), NOW, 1);
  /* coverUrl keeps its existing forgiving behaviour: an unusable one is no
     cover, not a refusal. The card falls back to its gradient. */
  assert.equal(hosted.event.coverUrl, null);

  const uploaded = normalizeEntry(valid({ coverPath: 'http://example.com/c.jpg' }), NOW, 1);
  assert.ok(uploaded.error);
});

test('coverPath wins when both are set — the author uploaded that one', () => {
  const { event } = normalizeEntry(valid({
    coverUrl: 'https://example.com/hosted.jpg',
    coverPath: 'images/event-a.jpg'
  }), NOW, 1);
  assert.equal(event.coverUrl, 'images/event-a.jpg');
});

test('no cover at all is still null', () => {
  const { event } = normalizeEntry(valid(), NOW, 1);
  assert.equal(event.coverUrl, null);
});

/* Review Focus 3: the form must never send this, and the degradation is
   pinned rather than left to luck. */
test('a tags string rather than an array degrades to no tags', () => {
  const { event } = normalizeEntry(valid({ tags: 'Partner event' }), NOW, 1);
  assert.deepEqual(event.tags, []);
});

test('a manual event still has exactly the fields it had before', () => {
  const { event } = normalizeEntry(valid({ coverPath: 'images/event-a.jpg' }), NOW, 1);
  assert.deepEqual(Object.keys(event).sort(), [
    'city', 'coverUrl', 'endAt', 'id', 'locationType', 'membersOnly',
    'name', 'place', 'startAt', 'tags', 'timezone', 'url'
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tools/event-entry.test.mjs`

Expected: FAIL. The `coverPath` tests fail because the field is ignored — `event.coverUrl` is `null` where a path was expected, and the traversal cases return an `event` instead of an `error`.

- [ ] **Step 3: Add `sitePath()` and wire it into `normalizeEntry()`**

In `lib/event-entry.mjs`, beside `httpsUrl()`:

```js
/* A cover this site serves, as opposed to one a partner hosts.
 *
 * Deliberately a single literal shape rather than a path that is "cleaned":
 * `images/<name>.<jpg|png>`, one segment, no slash inside the name. There is
 * nothing to normalise away, so there is no normalisation to get wrong --
 * `../`, a leading slash, a second directory and an absolute URL all simply
 * fail to match. That matters because this string is interpolated into a
 * repository path by api/add-event.js.
 *
 * The extensions are the same two api/publish.js allows for a post cover: the
 * site serves jpg and png as covers and nothing else. */
const COVER_PATH = /^images\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpg|jpeg|png)$/;

function sitePath(value) {
  const path = text(value);
  return COVER_PATH.test(path) ? path : '';
}
```

Then in `normalizeEntry()`, after the `endAt` check and before the expiry check:

```js
  /* Refused rather than ignored, unlike a bad coverUrl. A coverUrl is typed
     by hand from somewhere else and a wrong one costs the card its image; a
     coverPath is derived by api/add-event.js from a slug it just validated,
     so a coverPath that does not match means something upstream is wrong, and
     quietly publishing an event with no cover would hide it. */
  const coverPath = sitePath(entry.coverPath);
  if (entry.coverPath != null && entry.coverPath !== '' && !coverPath) {
    return { error: `coverPath must look like images/<name>.jpg (${JSON.stringify(entry.coverPath)})` };
  }
```

And change the `coverUrl` line of the returned object:

```js
      /* An uploaded cover wins a hosted one: the author chose a file in the
         form, which is a later and more deliberate act than a URL left in a
         field. The form sends only one of the two, so this decides nothing in
         practice -- it is here so that a hand-written file with both in it
         has one answer rather than whichever the reader guesses. */
      coverUrl: coverPath || httpsUrl(entry.coverUrl) || null,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tools/event-entry.test.mjs`

Expected: PASS, all tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`

Expected: PASS. `tools/manual-events.test.mjs` must still pass untouched — `coverUrl` behaviour is unchanged for every entry that has no `coverPath`.

- [ ] **Step 6: Commit**

```bash
git add lib/event-entry.mjs tools/event-entry.test.mjs
git commit -m "Accept a site-relative cover on a manual event

An uploaded cover lives on this site, so it needs a path, which httpsUrl()
refuses by design. coverPath takes one literal shape and is interpolated into
a repository path, so it is matched rather than cleaned.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: One file per event — `loadManualEvents()` reads a directory

The spec's reasoning is worth re-reading before changing this (**Why one file per event**). In short: two authors appending to one shared array lose an event, because `commitWithRetry` replays stale content on retry and nothing is watching. Two authors writing two paths cannot.

`loadManualEvents()` gains an injectable directory so it is testable at all; today it hardcodes a URL and cannot be pointed at a fixture.

**Files:**
- Modify: `lib/manual-events.mjs`
- Delete: `src/_data/manual-events.json`
- Create: `src/_data/manual-events/.gitkeep`
- Modify: `vercel.json`
- Modify: `docs/manual-events.md`
- Test: `tools/manual-events-dir.test.mjs` (create)

**Interfaces:**
- Consumes: `normalizeManualEvents` from `lib/event-entry.mjs` (Task 1)
- Produces: `loadManualEvents(now = new Date(), dir = DEFAULT_DIR)` → `Array<event>`. `dir` is a `URL` ending in `/`, or a path string. Callers pass nothing.

- [ ] **Step 1: Write the failing tests**

Create `tools/manual-events-dir.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadManualEvents } from '../lib/manual-events.mjs';

/* One file per event, because one shared array loses events: two authors each
   append to the array they read, the second commit lands on a moved branch,
   and commitWithRetry replays the same stale content -- dropping the first
   author's event with no error anywhere. Two paths cannot collide that way.
   See the spec's "Why one file per event".

   The guarantee this file exists to hold: one bad file costs that one event,
   never the calendar. */

const NOW = new Date('2026-06-01T12:00:00Z');
const future = '2026-07-01T18:00:00Z';

function quiet(fn) {
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

function dirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-events-'));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name),
      typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  /* A trailing slash: the reader resolves each filename against this with
     new URL(), which drops the last segment without one. */
  return pathToFileURL(dir + path.sep);
}

const event = (name) => ({ name, startAt: future, url: 'https://example.com/rsvp' });

test('every json file in the directory becomes an event', () => {
  const dir = dirWith({
    'a-mixer.json': event('A Mixer'),
    'b-panel.json': event('B Panel')
  });
  const events = loadManualEvents(NOW, dir);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.name).sort(), ['A Mixer', 'B Panel']);
});

test('a missing directory is no manual events, not an error', () => {
  const { result } = quiet(() =>
    loadManualEvents(NOW, pathToFileURL(path.join(os.tmpdir(), 'not-here-at-all') + path.sep)));
  assert.deepEqual(result, []);
});

test('an unparseable file is skipped by name and the rest still ship', () => {
  const dir = dirWith({
    'good.json': event('Good One'),
    'broken.json': '{ not json at all'
  });
  const { result, messages } = quiet(() => loadManualEvents(NOW, dir));
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Good One');
  assert.ok(messages.some((m) => m.includes('broken.json')),
    'the warning must name the file, not a position');
});

/* Review Focus 4: valid JSON that is not an event. */
test('a file holding something that is not an object is skipped by name', () => {
  const dir = dirWith({
    'good.json': event('Good One'),
    'null.json': 'null',
    'array.json': '[{"name":"Hand-written array"}]',
    'number.json': '42'
  });
  const { result, messages } = quiet(() => loadManualEvents(NOW, dir));
  assert.equal(result.length, 1);
  for (const name of ['null.json', 'array.json', 'number.json']) {
    assert.ok(messages.some((m) => m.includes(name)), `${name} should be named`);
  }
});

test('non-json files are ignored, not read', () => {
  const dir = dirWith({
    'good.json': event('Good One'),
    '.gitkeep': '',
    'README.md': '# not an event'
  });
  const { result } = quiet(() => loadManualEvents(NOW, dir));
  assert.equal(result.length, 1);
});

test('files are read in sorted order, so ids are reproducible', () => {
  /* Two events sharing a name fall back to position for their id. Sorted
     filenames make that position the same on every read; readdir order is not
     guaranteed to be. */
  const dir = dirWith({
    'z-second.json': event('Chapter Mixer'),
    'a-first.json': event('Chapter Mixer')
  });
  const first = loadManualEvents(NOW, dir).map((e) => e.id);
  const second = loadManualEvents(NOW, dir).map((e) => e.id);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, 2, 'ids must be distinct');
});

test('an expired event in a file is dropped without a warning', () => {
  const dir = dirWith({
    'past.json': { name: 'Last Year', startAt: '2020-01-01T00:00:00Z', url: 'https://example.com/x' },
    'future.json': event('Next Month')
  });
  const { result, messages } = quiet(() => loadManualEvents(NOW, dir));
  assert.equal(result.length, 1);
  assert.equal(messages.length, 0, 'an event being over is not a mistake');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tools/manual-events-dir.test.mjs`

Expected: FAIL — `loadManualEvents()` takes no second argument, so every test reads the real `src/_data/manual-events.json` and returns `[]`.

- [ ] **Step 3: Rewrite `loadManualEvents()`**

Replace the whole function in `lib/manual-events.mjs`:

```js
const DEFAULT_DIR = new URL('../src/_data/manual-events/', import.meta.url);

export function loadManualEvents(now = new Date(), dir = DEFAULT_DIR) {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tools/manual-events-dir.test.mjs`

Expected: PASS, all tests.

- [ ] **Step 5: Move the data file to a directory**

```bash
git rm src/_data/manual-events.json
mkdir -p src/_data/manual-events
printf '' > src/_data/manual-events/.gitkeep
```

The file holds `[]`, so there is nothing to migrate. `.gitkeep` is needed because git does not track an empty directory, and a missing directory on a deployment is the degraded path, not the normal one. Eleventy's data cascade reads only `.json` and `.js` under `_data/`, so `.gitkeep` is invisible to it.

- [ ] **Step 6: Update `vercel.json`'s `includeFiles`**

This is the quiet failure in the spec's **Risks**. Change:

```json
    "api/events.js": {
      "includeFiles": "src/_data/manual-events.json"
    }
```

to:

```json
    "api/events.js": {
      "includeFiles": "src/_data/manual-events/**"
    }
```

- [ ] **Step 7: Rewrite the "shape of an entry" section of `docs/manual-events.md`**

Replace every reference to the single array file. The two paragraphs that change:

```markdown
Every event on the site normally comes from the Luma calendar. An event that
was never created there — a partner's event, a conference panel, a chapter
meetup organised somewhere else — is added at `/admin/events/` by any signed-in
author. That page writes the file described below; nothing here has to be
edited by hand.

## The shape of an entry

Each event is its own file at `src/_data/manual-events/<slug>.json`, holding a
single JSON object. One file per event rather than one shared array, because
two authors appending to an array can each commit over the other's entry with
no error anywhere.

```json
{
  "name": "Fintech Women at Money20/20",
  "slug": "fintech-women-at-money2020",
  "startAt": "2026-10-26T18:00:00-04:00",
  "url": "https://example.com/rsvp",
  "city": "nyc",
  "place": "Las Vegas, NV",
  "coverPath": "images/event-fintech-women-at-money2020.jpg",
  "tags": ["Panel", "In person"]
}
```
```

Then add `coverPath` to the **Optional** table, immediately after `coverUrl`:

```markdown
| `coverPath` | `null` | A cover this site serves, as `images/<name>.jpg` or `.png`. Set by `/admin/events/` when an author uploads one. Wins over `coverUrl` if both are set. |
```

And replace the last line of the **Cover images** section — "The image has to be hosted somewhere public over `https` — this repository does not store event covers." — with:

```markdown
A cover uploaded at `/admin/events/` is committed to `src/images/` and
referenced with `coverPath`. A partner who supplies an image URL can be
pointed at directly with `coverUrl` instead, which must be `https`.
```

- [ ] **Step 8: Run the whole suite and a build**

Run: `npm test && npm run build`

Expected: tests PASS; the build completes. The build needs `CLERK_PUBLISHABLE_KEY` and `CLERK_FRONTEND_API_URL` set or it throws by design — if they are not in the local environment, say so rather than working around it.

- [ ] **Step 9: Commit**

```bash
git add lib/manual-events.mjs tools/manual-events-dir.test.mjs vercel.json docs/manual-events.md src/_data/manual-events/.gitkeep
git commit -m "Give each manual event its own file

One shared array loses events: two authors each append to what they read, and
commitWithRetry replays the stale copy on retry. Two paths cannot collide that
way. vercel.json's includeFiles follows the directory, or the endpoint ships
with no events and falls back to Luma in silence.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Serve `lib/event-entry.mjs` to the browser

One line of configuration, and the test that fails loudly if it is ever dropped. Without it the admin page's `import` 404s and the form renders with no validation at all.

**Files:**
- Modify: `eleventy.config.js`
- Test: `tools/eleventy-config.test.mjs` (modify)

**Interfaces:**
- Consumes: `lib/event-entry.mjs` (Task 1)
- Produces: `/lib/event-entry.mjs` is served by the built site.

- [ ] **Step 1: Read the existing config test to match its style**

Run: `sed -n '1,60p' tools/eleventy-config.test.mjs`

Note how it asserts on passthrough copies, and follow that shape exactly rather than inventing a second one.

- [ ] **Step 2: Write the failing test**

Append to `tools/eleventy-config.test.mjs`, adapting the assertion style to what Step 1 showed:

```js
test('lib/event-entry.mjs is served — the events page imports it', () => {
  /* /admin/events/ refuses what the build refuses by importing the same
     module. If this passthrough is dropped the import 404s, the page loads
     with no validation, and the first thing anyone notices is a committed
     event the renderer silently drops. */
  assert.ok(passthroughTargets().includes('lib/event-entry.mjs'));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tools/eleventy-config.test.mjs`

Expected: FAIL — `event-entry.mjs` is not in the passthrough map.

- [ ] **Step 4: Add the passthrough**

In `eleventy.config.js`, in the existing `addPassthroughCopy` map, and extend the comment above it so the count stays honest:

```js
  /* Only the five lib/ modules the browser actually imports (see
     src/admin/editor.js, src/admin/text.js and src/admin/events/events.js) --
     passing through the whole lib/ directory would also publish
     lib/clerk-jwt.mjs and lib/github.mjs, neither of which the editor needs
     and neither of which was meant to be public: they hold the session-token
     verification and the GitHub commit machinery. Nothing in them is a secret
     (no key or token lives in source), but there is no reason to serve them
     to anyone who asks. */
  eleventyConfig.addPassthroughCopy({
    'lib/render-blocks.mjs': 'lib/render-blocks.mjs',
    'lib/post-file.mjs': 'lib/post-file.mjs',
    'lib/post-types.mjs': 'lib/post-types.mjs',
    'lib/slug.mjs': 'lib/slug.mjs',
    'lib/event-entry.mjs': 'lib/event-entry.mjs'
  });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tools/eleventy-config.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add eleventy.config.js tools/eleventy-config.test.mjs
git commit -m "Serve lib/event-entry.mjs to the browser

The events page imports it so it refuses what the build refuses. Without the
passthrough the import 404s and the form validates nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `POST /api/add-event` — create and update

Named for the verb like `publish.js` and `unpublish.js`, and deliberately not `api/event.js` — one letter from `api/events.js` is a filename nobody should have to read twice.

Order matters and every step refuses before the next, the same order `api/publish.js` follows: verify the session, validate the payload, validate the image, and only then mint a credential and touch GitHub.

It carries a `mode` of `create` or `update`, exactly as `api/publish.js` does, and checks it against what is actually on the branch. **The slug is frozen on update** — it is the filename, so a changed slug would write a second file and leave the first, one event silently becoming two. Renaming is remove-then-add.

**Files:**
- Create: `api/add-event.js`
- Test: `tools/add-event.test.mjs` (create)

**Interfaces:**
- Consumes: `authenticateClerkRequest` from `lib/clerk-request.mjs`; `authorNameFromSub` from `lib/session.mjs`; `normalizeEntry` from `lib/event-entry.mjs` (Task 1, Task 2); `commitWithRetry`, `pathExists`, `getFileContent` from `lib/github.mjs`; `resolveGithubToken` from `lib/github-auth.mjs`; `slugify` from `lib/slug.mjs`; `isCleanBase64` from `api/publish.js`
- Produces: `POST /api/add-event`, body `{ mode: 'create' | 'update', event: {...}, image?: { base64, ext } }` → `200 { slug, commit, coverPath }` | `4xx/5xx { message }`. Also exports `eventPathFor(slug)`, `coverPathFor(slug, ext)` and `COVER_EXTS` for the tests and for Tasks 8–10.

- [ ] **Step 1: Read `tools/publish-handler.test.mjs` to match its harness**

Run: `sed -n '1,70p' tools/publish-handler.test.mjs`

It builds a fake request/response pair and a fake `fetch`. Reuse that shape exactly — a second harness for the same job is a second thing to keep working.

- [ ] **Step 2: Write the failing tests**

Create `tools/add-event.test.mjs`, using the request/response/fetch doubles from Step 1:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { eventPathFor, coverPathFor } from '../api/add-event.js';

/* The only other code in this project that can write to the repository.
   Everything local and pure runs before the first network call, for the
   reason api/publish.js records: a bad image should never cost a GitHub round
   trip, and an author with a too-large photo should never be told "GitHub is
   down" when GitHub was never asked. */

// … buildRequest / buildResponse / fakeFetch, copied from publish-handler.test.mjs …

const future = '2026-12-01T18:00:00-05:00';

const body = (extra) => Object.assign({
  event: {
    name: 'Fintech Forward with SVB',
    startAt: future,
    endAt: '2026-12-01T20:30:00-05:00',
    url: 'https://www.svb.com/events/fintech-forward',
    city: 'nyc',
    place: 'SVB, 1 Hudson Yards',
    locationType: 'offline',
    tags: ['Partner event']
  }
}, extra || {});

test('a request without a session token is refused', async () => {
  const response = await post(body(), { token: null });
  assert.equal(response.status, 401);
});

test('a valid event is committed as its own file', async () => {
  const { response, commits } = await post(body());
  assert.equal(response.status, 200);
  assert.equal(response.json.slug, 'fintech-forward-with-svb');
  const paths = commits[0].files.map((f) => f.path);
  assert.deepEqual(paths, ['src/_data/manual-events/fintech-forward-with-svb.json']);
  const written = JSON.parse(commits[0].files[0].content);
  assert.equal(written.slug, 'fintech-forward-with-svb');
  assert.equal(written.name, 'Fintech Forward with SVB');
});

test('the event and its cover land in one commit', async () => {
  const { response, commits } = await post(body({
    image: { base64: Buffer.from('fake jpeg bytes').toString('base64'), ext: 'jpg' }
  }));
  assert.equal(response.status, 200);
  assert.equal(commits.length, 1, 'an event must never be live with a missing cover');
  assert.deepEqual(commits[0].files.map((f) => f.path), [
    'src/_data/manual-events/fintech-forward-with-svb.json',
    'src/images/event-fintech-forward-with-svb.jpg'
  ]);
  const written = JSON.parse(commits[0].files[0].content);
  assert.equal(written.coverPath, 'images/event-fintech-forward-with-svb.jpg');
});

test('coverPath is derived here, never taken from the request', async () => {
  const { commits } = await post(body({
    event: Object.assign(body().event, { coverPath: 'images/something-else.jpg' }),
    image: { base64: Buffer.from('bytes').toString('base64'), ext: 'png' }
  }));
  const written = JSON.parse(commits[0].files[0].content);
  assert.equal(written.coverPath, 'images/event-fintech-forward-with-svb.png');
});

test('create onto an existing slug is refused, not overwritten', async () => {
  const { response, commits } = await post(body(), { existingPaths: [
    'src/_data/manual-events/fintech-forward-with-svb.json'
  ] });
  assert.equal(response.status, 409);
  assert.equal(commits.length, 0);
  assert.match(response.json.message, /already/i);
});

test('update onto a slug with no file is refused', async () => {
  /* It means the event was removed since the author opened it. Writing it
     back would quietly resurrect something somebody deliberately took down. */
  const { response, commits } = await post(body({ mode: 'update' }));
  assert.equal(response.status, 409);
  assert.equal(commits.length, 0);
});

test('update writes over the existing file', async () => {
  const path = 'src/_data/manual-events/fintech-forward-with-svb.json';
  const { response, commits } = await post(
    body({ mode: 'update', event: Object.assign(body().event, { place: 'Moved to the 4th floor' }) }),
    { existingPaths: [path], liveFiles: { [path]: JSON.stringify({ slug: 'fintech-forward-with-svb' }) } });
  assert.equal(response.status, 200);
  assert.deepEqual(commits[0].files.map((f) => f.path), [path]);
  assert.equal(JSON.parse(commits[0].files[0].content).place, 'Moved to the 4th floor');
});

/* Review Focus 2 */
test('the mode check runs on the slugified slug', async () => {
  const { response, commits } = await post(
    body({ event: Object.assign(body().event, { name: 'SVB — Fintech Forward!' }) }),
    { existingPaths: ['src/_data/manual-events/svb-fintech-forward.json'] });
  assert.equal(response.status, 409, 'a punctuation-only difference is the same file');
  assert.equal(commits.length, 0);
});

test('an update with no new image keeps the live cover', async () => {
  const path = 'src/_data/manual-events/fintech-forward-with-svb.json';
  const { commits } = await post(
    body({ mode: 'update' }),
    { existingPaths: [path], liveFiles: { [path]: JSON.stringify({
      slug: 'fintech-forward-with-svb',
      coverPath: 'images/event-fintech-forward-with-svb.jpg'
    }) } });
  const written = JSON.parse(commits[0].files[0].content);
  assert.equal(written.coverPath, 'images/event-fintech-forward-with-svb.jpg',
    'an author fixing a time must not lose the cover by not re-uploading it');
});

test('an update whose new cover changes extension deletes the old one', async () => {
  const path = 'src/_data/manual-events/fintech-forward-with-svb.json';
  const { commits } = await post(
    body({ mode: 'update', image: { base64: Buffer.from('bytes').toString('base64'), ext: 'png' } }),
    { existingPaths: [path], liveFiles: { [path]: JSON.stringify({
      slug: 'fintech-forward-with-svb',
      coverPath: 'images/event-fintech-forward-with-svb.jpg'
    }) } });
  const files = commits[0].files;
  assert.ok(files.some((f) => f.path === 'src/images/event-fintech-forward-with-svb.png' && !f.delete));
  assert.ok(files.some((f) => f.path === 'src/images/event-fintech-forward-with-svb.jpg' && f.delete),
    'or the jpg sits in src/images/ forever with nothing pointing at it');
});

test('an update does not delete a partner-hosted cover', async () => {
  const path = 'src/_data/manual-events/fintech-forward-with-svb.json';
  const { commits } = await post(
    body({ mode: 'update', image: { base64: Buffer.from('bytes').toString('base64'), ext: 'png' } }),
    { existingPaths: [path], liveFiles: { [path]: JSON.stringify({
      slug: 'fintech-forward-with-svb',
      coverUrl: 'https://partner.example.com/cover.jpg'
    }) } });
  assert.ok(!commits[0].files.some((f) => f.delete), 'it is not ours to delete');
});

/* Review Focus 1 */
test('an event that has already finished is refused with its own sentence', async () => {
  const { response, commits } = await post(body({
    event: Object.assign(body().event, {
      startAt: '2020-01-01T18:00:00-05:00',
      endAt: '2020-01-01T20:00:00-05:00'
    })
  }));
  assert.equal(response.status, 400);
  assert.equal(commits.length, 0);
  assert.match(response.json.message, /past|already|finished/i);
});

test('an event the normaliser refuses is refused, naming the field', async () => {
  const { response } = await post(body({
    event: Object.assign(body().event, { url: 'http://insecure.example.com/rsvp' })
  }));
  assert.equal(response.status, 400);
  assert.match(response.json.message, /url/i);
});

test('an oversized cover is refused with no GitHub call', async () => {
  const { response, calls } = await post(body({
    image: { base64: 'A'.repeat(4_200_000), ext: 'jpg' }
  }));
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0, 'GitHub must never be asked about a bad image');
});

/* Review Focus 5 */
test('a data: URI prefix in the base64 is refused with no GitHub call', async () => {
  const { response, calls } = await post(body({
    image: {
      base64: 'data:image/jpeg;base64,' + Buffer.from('bytes').toString('base64'),
      ext: 'jpg'
    }
  }));
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test('a cover that is not a jpg or png is refused with no GitHub call', async () => {
  const { response, calls } = await post(body({
    image: { base64: Buffer.from('bytes').toString('base64'), ext: 'webp' }
  }));
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test('a traversing slug cannot escape the events directory', async () => {
  for (const name of ['../../../etc/passwd', '../../lib/github.mjs']) {
    const { response, commits } = await post(body({
      event: Object.assign(body().event, { slug: name })
    }));
    /* Either refused outright, or slugified into harmlessness -- never a path
       outside src/_data/manual-events/. */
    for (const file of (commits[0] ? commits[0].files : [])) {
      assert.ok(file.path.startsWith('src/_data/manual-events/') ||
                file.path.startsWith('src/images/'), file.path);
      assert.ok(!file.path.includes('..'), file.path);
    }
    assert.ok(response.status === 400 || response.status === 200);
  }
});

test('a GET is refused', async () => {
  const response = await post(body(), { method: 'GET' });
  assert.equal(response.status, 405);
});

test('the committed file survives a round trip to a rendered event', async () => {
  const { commits } = await post(body());
  const written = JSON.parse(commits[0].files[0].content);
  const { normalizeManualEvents } = await import('../lib/event-entry.mjs');
  const [event] = normalizeManualEvents([written], new Date('2026-06-01T12:00:00Z'));
  assert.ok(event, 'the endpoint must never write a file the renderer drops');
  assert.equal(event.id, 'manual-fintech-forward-with-svb');
  assert.equal(event.city, 'nyc');
  assert.equal(event.url, 'https://www.svb.com/events/fintech-forward');
});

test('the path helpers agree with what the handler writes', () => {
  assert.equal(eventPathFor('a-slug'), 'src/_data/manual-events/a-slug.json');
  assert.equal(coverPathFor('a-slug', 'png'), 'images/event-a-slug.png');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tools/add-event.test.mjs`

Expected: FAIL — `api/add-event.js` does not exist.

- [ ] **Step 4: Write `api/add-event.js`**

```js
/* POST /api/add-event — put an event on the site that was never in Luma.
 *
 * The second piece of code in this project that can write to the repository,
 * and it follows api/publish.js's order for the same reasons: verify the
 * session, validate the payload, validate the image, and only then mint a
 * GitHub credential and touch GitHub. Minting a credential counts as touching
 * GitHub, so it happens after every local, pure check has passed. Nothing is
 * committed until the event is known to render.
 *
 * Authentication matches publish and unpublish: any signed-in author, no admin
 * check. Adding a partner event is the same kind of act as publishing a post.
 *
 * Add-only, deliberately: lib/event-entry.mjs retires an event once its end
 * time passes, so "it's over, take it down" needs no endpoint. Editing and
 * removing are the known gap -- see the spec's "Out of scope".
 *
 * Env: the same set api/publish.js documents (CLERK_PEM_PUBLIC_KEY,
 * CLERK_AUTHORIZED_PARTIES, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY,
 * GITHUB_INSTALLATION_ID or GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO,
 * GITHUB_BRANCH).
 */
import { authenticateClerkRequest } from '../lib/clerk-request.mjs';
import { authorNameFromSub } from '../lib/session.mjs';
import { normalizeEntry } from '../lib/event-entry.mjs';
import { commitWithRetry, getFileContent } from '../lib/github.mjs';
import { resolveGithubToken } from '../lib/github-auth.mjs';
import { slugify } from '../lib/slug.mjs';
import { isCleanBase64 } from './publish.js';

const MAX_IMAGE_BYTES = 3_000_000;

/* The two the site serves as a cover, matching api/publish.js and
   lib/event-entry.mjs's COVER_PATH. One allowlist disagreeing with another is
   how a cover gets committed that the renderer then refuses. Exported because
   api/remove-event.js deletes by the same convention. */
export const COVER_EXTS = ['jpg', 'png'];
const ALLOWED_COVER_EXTS = new Set(COVER_EXTS);

export function eventPathFor(slug) {
  return `src/_data/manual-events/${slug}.json`;
}

/* The WEB path, as a post's coverPath already is: the file is committed to
   src/images/ and referenced as images/…, because Eleventy passes src/images/
   through to the site root and every page that renders an event card is
   itself at the root. */
export function coverPathFor(slug, ext) {
  return `images/event-${slug}.${ext}`;
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const hasGithubCredential = !!process.env.GITHUB_TOKEN ||
    !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_INSTALLATION_ID);
  if (!owner || !repo || !hasGithubCredential) {
    console.error('Publishing is not configured: missing GITHUB_OWNER/GITHUB_REPO, or no usable GitHub credential');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }

  const { email: authorEmail, refusal } = authenticateClerkRequest(request);
  if (refusal) {
    return response.status(refusal.status).json({ message: refusal.message });
  }

  const payload = typeof request.body === 'object' && request.body ? request.body : {};
  const submitted = typeof payload.event === 'object' && payload.event ? payload.event : {};

  /* Defaults to create: a client that forgets to send one is adding, and the
     worst a wrong guess can do here is a 409 the author can read. */
  const mode = payload.mode === 'update' ? 'update' : 'create';

  /* The slug is the filename and the identity, and it is interpolated into a
     repository path -- so it is slugified before it is used for anything, the
     check that makes api/post.js safe. Derived from the name when the form
     does not send one, exactly as normalizeEntry() derives the id. */
  const slug = slugify(submitted.slug) || slugify(submitted.name);
  if (!slug) {
    return response.status(400).json({
      message: 'That event name cannot be turned into an address. Add a few letters or numbers to it.'
    });
  }

  /* The cover is written only under src/images/ with a name derived from the
     slug, never from the uploaded filename. */
  let ext = null;
  if (payload.image && payload.image.base64) {
    const bytes = Math.floor(String(payload.image.base64).length * 0.75);
    if (bytes > MAX_IMAGE_BYTES) {
      return response.status(400).json({
        message: 'That cover image is too large to publish. Choose a smaller one.'
      });
    }
    if (!isCleanBase64(payload.image.base64)) {
      return response.status(400).json({
        message: 'That cover image could not be read. Try choosing it again.'
      });
    }
    ext = String(payload.image.ext || 'jpg').toLowerCase();
    if (!ALLOWED_COVER_EXTS.has(ext)) {
      return response.status(400).json({
        message: `That cover image's file type (.${ext}) cannot be published. Use a JPG or a PNG.`
      });
    }
  }

  /* Written to the file, never taken from the request: an author cannot
     choose where an image lands, which is what keeps the path check in
     lib/event-entry.mjs meaningful. */
  const entry = {
    name: typeof submitted.name === 'string' ? submitted.name.trim() : '',
    slug,
    startAt: submitted.startAt,
    endAt: submitted.endAt || null,
    timezone: submitted.timezone || 'America/New_York',
    url: submitted.url,
    city: submitted.city,
    place: submitted.place || '',
    locationType: submitted.locationType,
    membersOnly: submitted.membersOnly === true,
    tags: Array.isArray(submitted.tags) ? submitted.tags : []
  };
  if (ext) entry.coverPath = coverPathFor(slug, ext);
  else if (submitted.coverUrl) entry.coverUrl = submitted.coverUrl;

  /* Run through the SAME normaliser the build uses, so the page cannot write
     a file the renderer would later drop. The event this produces is
     discarded; only its verdict is wanted. */
  const verdict = normalizeEntry(entry, new Date(), 1);
  if (verdict.expired) {
    /* Not an { error }, so a handler checking only verdict.error would commit
       a file that renders nowhere and report success. */
    return response.status(400).json({
      message: 'That event has already finished, so it would not appear on the site. Check the date and time.'
    });
  }
  if (verdict.error) {
    return response.status(400).json({ message: `This event cannot be added: ${verdict.error}.` });
  }

  const path = eventPathFor(slug);

  let token;
  try {
    token = await resolveGithubToken();
  } catch (error) {
    if (error.code === 'key') {
      console.error("The site's GitHub private key could not be used", error);
      return response.status(503).json({ message: error.message });
    }
    if (error.code === 'auth') {
      console.error('GitHub rejected the publishing credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Could not obtain a GitHub credential', error);
    return response.status(502).json({ message: 'Adding the event failed. Nothing was changed.' });
  }

  /* Create versus update checked against the branch, the rule
     api/publish.js enforces: two different names can slugify the same way, so
     a "new" event landing on an existing path would silently replace somebody
     else's. The live file is read rather than merely probed, because an
     update needs what is in it -- see the cover carry-over below. */
  let live = null;
  try {
    const text = await getFileContent({ token, owner, repo, branch, path });
    if (mode === 'create' && text !== null) {
      return response.status(409).json({
        message: 'An event already exists at that address. Change the event name, or edit the address field.'
      });
    }
    if (mode === 'update' && text === null) {
      return response.status(409).json({
        message: 'That event is no longer on the site — someone may have removed it. Add it again as a new event.'
      });
    }
    if (text !== null) {
      try {
        live = JSON.parse(text);
      } catch (error) {
        /* A hand-edited file that will not parse must not block a correction
           -- that is exactly when someone needs this page. The cover
           carry-over below simply finds nothing. */
        console.warn(`add-event: the live ${path} does not parse; updating it anyway`);
      }
    }
  } catch (error) {
    if (error.code === 'auth') {
      console.error('GitHub rejected the publishing credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Could not check whether the event already exists', error);
    return response.status(502).json({ message: 'Adding the event failed. Nothing was changed.' });
  }

  /* Cover carry-over. An author editing a start time does not re-upload the
     cover, and losing it silently is worse than any error this file reports.
     Taken from the LIVE file rather than the client's copy, which may be a
     stale draft -- the rule api/unpublish.js follows for the same field. */
  const liveCover = live && typeof live.coverPath === 'string' ? live.coverPath : '';
  if (!ext && !entry.coverUrl && liveCover) {
    entry.coverPath = liveCover;
    /* Re-validated rather than trusted: the live file may have been edited by
       hand into something the renderer would drop, and carrying that forward
       would launder it. */
    const recheck = normalizeEntry(entry, new Date(), 1);
    if (recheck.error) delete entry.coverPath;
  }

  /* The event and its cover in ONE commit, so an event is never live with a
     missing cover, nor an image orphaned by a failed event write. */
  const files = [{ path, content: JSON.stringify(entry, null, 2) + '\n', encoding: 'utf-8' }];
  if (ext) {
    files.push({
      path: `src/${coverPathFor(slug, ext)}`,
      content: String(payload.image.base64),
      encoding: 'base64'
    });
    /* A PNG replacing a JPG leaves event-<slug>.jpg behind with nothing
       pointing at it. Deleted only when the live cover is a path THIS endpoint
       could have written -- a partner-hosted or hand-set one is not ours to
       remove (the rule api/unpublish.js follows, extended to the other
       extension here). */
    for (const other of COVER_EXTS) {
      if (other !== ext && liveCover === coverPathFor(slug, other)) {
        files.push({ path: `src/${liveCover}`, delete: true });
      }
    }
  }

  try {
    const result = await commitWithRetry({
      token, owner, repo, branch,
      message: `Add event ${slug}\n\nAdded from the events page by ${authorEmail}.`,
      author: { name: authorNameFromSub(authorEmail), email: authorEmail },
      files
    });
    return response.status(200).json({
      slug,
      commit: result.sha,
      coverPath: ext ? coverPathFor(slug, ext) : null
    });
  } catch (error) {
    if (error.code === 'stale_head') {
      return response.status(409).json({ message: 'Someone else just published. Try again.' });
    }
    if (error.code === 'auth') {
      console.error('GitHub rejected the publishing credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Add event failed', error);
    return response.status(502).json({ message: 'Adding the event failed. Nothing was changed.' });
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tools/add-event.test.mjs`

Expected: PASS, all tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/add-event.js tools/add-event.test.mjs
git commit -m "Add an endpoint that commits a manual event

Validates through the same normaliser the build uses, so the page cannot write
a file the renderer drops. The event and its cover go in one commit, and every
local check runs before GitHub is asked anything.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Move the admin chrome into a shared stylesheet

`src/admin/index.html` carries ~410 lines of CSS inline. The events page needs the same tokens, fields, buttons, drawer and status lines. Copying them is two stylesheets drifting apart from the first edit.

`src/admin/**` is ignored by Eleventy and copied verbatim, so there is no `{% include %}` available — the shared chrome has to be a real stylesheet both pages `<link>`.

**This task changes no rendering.** The editor must look and behave exactly as it does now; the only difference is where the bytes live.

**Files:**
- Create: `src/admin/admin.css`
- Modify: `src/admin/index.html`

**Interfaces:**
- Produces: `/admin/admin.css`, holding the `:root` tokens, buttons, fields, sections, status lines, drawer, toast and banner. Page-specific rules stay inline on the page that owns them.

- [ ] **Step 1: Move the shared rules into `src/admin/admin.css`**

Cut from `src/admin/index.html`'s `<style>` block, with every comment intact, and head the new file:

```css
/* The admin chrome — shared by /admin/ (the post editor) and /admin/events/.
 *
 * A real stylesheet rather than a template include: src/admin/** is ignored
 * by Eleventy (see eleventy.config.js) and copied verbatim, so these pages
 * have no include mechanism. A <link> is the only way two of them can share
 * anything.
 *
 * Deliberately does NOT build on ../site.css: these are tools, not pages, and
 * their chrome should not drift every time the brand CSS moves.
 *
 * What belongs here: anything both pages use -- tokens, buttons, fields,
 * sections, status lines, the drawer, the toast, the banner. What does not:
 * a rule only one page needs, which stays inline on that page.
 */
```

Move these blocks: `:root`, `* { box-sizing }`, `html, body`, `body`, `---- top bar ----`, `---- buttons ----`, `---- sections ----`, `---- fields ----`, `.check`, `---- status lines ----`, `---- empty states ----`, `.hint`, `.toast`, `.banner`, `.load-error`, the drawer block (`#drawer-backdrop`, `.drawer`, `.drawer-head`, `.drawer-body`, `.drawer-sticky`, `.drawer-foot-note`, `.btn-link`, `.drawer-body .sec`), `.pill`, `.field-spaced`, `.check-spaced`, `.btn-spaced`, `.field-flush`, `.hint-spaced`, `.sec > h2.stacked`.

Leave inline in `index.html` — these are the editor's own: `---- layout ----` (`.panes`, `.pane*`), `---- blocks ----` (`.blk*`, `.blk-empty`, `.add-row`), `---- image ----` (`.img-row`, `.img-thumb`, `.img-ctl`, `input[type="file"]`, `.path-hint`, `.steps`), `---- preview ----` (`.preview-*`, `#preview`), `.checklist`, `details.sec-danger`, `#posts-drawer`, `.post-row`, `.post-open`, `.post-meta`, `.author-row`.

- [ ] **Step 2: Link it from the editor**

In `src/admin/index.html`, replace the comment above `<style>` and add the link before it:

```html
<!-- Deliberately does NOT link ../site.css: the preview is an iframe, and
     linking it would make this tool's chrome drift with the brand CSS. -->
<link rel="stylesheet" href="admin.css" />
<style>
  /* The editor's own: the three-pane workspace, the block list, the cover
     controls and the preview. Everything shared with /admin/events/ is in
     admin.css. */
```

- [ ] **Step 3: Verify the editor is unchanged**

Run: `npm run build`

Then open `_site/admin/index.html` in a browser served over HTTP (`npx http-server _site` or `npm run dev` and visit `/admin/`) and confirm, by eye against `git stash`-ing this task's changes if needed:

- the topbar is plum with the pink Publish button and the grouped separators
- a field focuses with the pink ring
- the account drawer slides in from the right over a dimmed backdrop
- `_site/admin/admin.css` exists and is non-empty

Record what you checked. **If the page is visibly different in any respect, the move was not verbatim — fix it rather than accepting the difference.**

- [ ] **Step 4: Commit**

```bash
git add src/admin/admin.css src/admin/index.html
git commit -m "Move the admin chrome into a shared stylesheet

The events page needs the same tokens, fields, buttons and drawer, and
src/admin is copied verbatim by Eleventy so there is no include to use. A
second copy of 400 lines of CSS drifts from the first edit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The `/admin/events/` page

A single-column page, a sibling of the post editor rather than a copy of it. An event is a flat form: no body blocks, no slug-driven filename, no article preview, so two of the editor's three panes would have nothing to show.

**Files:**
- Create: `src/admin/events/index.html`
- Create: `src/admin/events/events.js`
- Modify: `src/admin/index.html` (one link in the topbar)
- Modify: `vercel.json` (the trailing-slash redirect)

**Interfaces:**
- Consumes: `/admin/admin.css` (Task 6); `/admin/clerk-config.js` (generated, served at `admin/clerk-config.js`); `normalizeEntry` from `/lib/event-entry.mjs` (Tasks 1, 2, 4); `slugify` from `/lib/slug.mjs`; `POST /api/add-event` (Task 5)
- Produces: the page at `/admin/events/`

- [ ] **Step 1: Add the trailing-slash redirect**

In `vercel.json`, beside the existing `/admin` redirect:

```json
    {
      "source": "/admin/events",
      "destination": "/admin/events/",
      "permanent": false
    }
```

Without it, `/admin/events` loads the page with a base URL one level up, every relative import resolves to `/admin/…` instead of `/admin/events/…`, and the form renders with no validation — the same failure the editor's `load-error` script was written for.

- [ ] **Step 2: Write `src/admin/events/index.html`**

Note the relative paths: `../admin.css` and `../clerk-config.js` sit one level up.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Add an event — NYC Fintech Women</title>
<link rel="stylesheet" href="../admin.css" />
<style>
  /* This page's own. One column, because an event is a flat form: the
     editor's preview and output panes would both have nothing to show. */
  .column { width: min(680px, 100%); margin: 0 auto; padding: 0 0 48px; }
  .row { display: flex; gap: 12px; }
  .row > .field { flex: 1; min-width: 0; }
  .img-row { display: flex; gap: 14px; align-items: flex-start; }
  .img-thumb {
    width: 112px; height: 70px; border-radius: 10px; flex-shrink: 0;
    background: var(--soft) center/cover no-repeat; border: 1px solid var(--line);
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; color: var(--muted); text-align: center; overflow: hidden;
  }
  .img-ctl { flex: 1; min-width: 0; }
  input[type="file"] { font-size: 12px; max-width: 100%; color: var(--muted); }
  input[type="file"]::file-selector-button {
    font: inherit; font-size: 12px; font-weight: 600; margin-right: 10px;
    padding: 5px 11px; border-radius: 7px; cursor: pointer;
    background: #fff; color: var(--plum); border: 1px solid var(--line);
  }
  .sec-submit { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
</style>
</head>
<body>

<header class="topbar">
  <div class="brand"><span class="dot"></span> Add an event</div>
  <div class="spacer"></div>
  <div class="bar-group">
    <a class="btn btn-sm" href="../">Post editor</a>
  </div>
  <div class="bar-group">
    <button type="button" class="btn btn-sm" id="btn-account">Sign in</button>
  </div>
  <p id="add-status" class="status-line" role="status"></p>
</header>

<div id="drawer-backdrop" hidden></div>
<aside id="account-drawer" class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" hidden>
  <div class="drawer-head">
    <h2 id="drawer-title">Account</h2>
    <button type="button" class="btn-icon" id="btn-drawer-close" aria-label="Close">&times;</button>
  </div>
  <div class="drawer-body">
    <section id="signin" class="sec">
      <p class="hint">Adding an event needs an account.</p>
      <div id="clerk-auth"></div>
      <p id="signin-status" class="status-line" role="status"></p>
    </section>
  </div>
</aside>

<div class="column">

  <section class="sec">
    <h2>What and when</h2>
    <div class="field">
      <label for="f-name">Event name <span class="req">*</span></label>
      <input type="text" id="f-name" autocomplete="off" placeholder="Fintech Forward with SVB" />
      <div class="help">How it reads on the card.</div>
    </div>
    <div class="row">
      <div class="field">
        <label for="f-start-date">Starts <span class="req">*</span></label>
        <input type="date" id="f-start-date" />
      </div>
      <div class="field">
        <label for="f-start-time">&nbsp;</label>
        <input type="time" id="f-start-time" />
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label for="f-end-date">Ends</label>
        <input type="date" id="f-end-date" />
      </div>
      <div class="field">
        <label for="f-end-time">&nbsp;</label>
        <input type="time" id="f-end-time" />
      </div>
    </div>
    <div class="field">
      <label for="f-timezone">Time zone <span class="req">*</span></label>
      <select id="f-timezone">
        <option value="America/New_York">New York (Eastern)</option>
        <option value="America/Chicago">Chicago (Central)</option>
        <option value="America/Denver">Denver (Mountain)</option>
        <option value="America/Los_Angeles">San Francisco (Pacific)</option>
        <option value="UTC">UTC</option>
      </select>
      <div class="help">
        Decides when the event drops off the site, as well as what the card says.
        An event with no end time retires when it starts.
      </div>
    </div>
  </section>

  <section class="sec">
    <h2>Where it sends people</h2>
    <div class="field">
      <label for="f-url">RSVP link <span class="req">*</span></label>
      <input type="url" id="f-url" class="mono" autocomplete="off" placeholder="https://www.svb.com/events/…" />
      <div class="help">
        Must start with <code>https://</code>. This is the whole point of this page:
        the event lives on somebody else's registration page, and RSVP goes there.
      </div>
      <p class="warn" id="f-url-warn" hidden>
        That is a Luma link. An event already in Luma appears on the site on its own —
        this page is for the ones that are not.
      </p>
    </div>
  </section>

  <section class="sec">
    <h2>Where it is</h2>
    <div class="field">
      <label for="f-city">City <span class="req">*</span></label>
      <select id="f-city">
        <option value="nyc">New York</option>
        <option value="sf">San Francisco</option>
        <option value="chi">Chicago</option>
        <option value="other">Somewhere else</option>
      </select>
      <div class="help">Decides which chapter page it appears on. "Somewhere else" shows under All cities only.</div>
    </div>
    <div class="field">
      <label for="f-locationType">In person or online <span class="req">*</span></label>
      <select id="f-locationType">
        <option value="offline">In person</option>
        <option value="zoom">Online</option>
      </select>
    </div>
    <div class="field">
      <label for="f-place">Place</label>
      <input type="text" id="f-place" autocomplete="off" placeholder="SVB, 1 Hudson Yards" />
      <div class="help">Free text. An online event with no place reads "Online".</div>
    </div>
  </section>

  <section class="sec">
    <h2>Cover image</h2>
    <div class="img-row">
      <div class="img-thumb" id="img-thumb">No image</div>
      <div class="img-ctl">
        <input type="file" id="img-file" accept="image/jpeg,image/png" />
        <div class="help">1600 × 1000, JPG or PNG, under 3 MB. Anything else is cropped to 16:10 from the centre. A dark gradient covers the top-left, where the date sits — keep logos and faces away from it.</div>
        <p class="status-line" id="img-status" role="status"></p>
      </div>
    </div>
    <div class="field field-spaced">
      <label for="f-coverUrl">Or an image the partner hosts</label>
      <input type="url" id="f-coverUrl" class="mono" placeholder="https://example.com/cover.jpg" />
      <div class="help">Used only when no file is chosen above. Must be <code>https://</code>.</div>
    </div>
  </section>

  <section class="sec">
    <h2>Labels</h2>
    <div class="field">
      <label for="f-tags">Tags</label>
      <input type="text" id="f-tags" autocomplete="off" placeholder="Partner event, Panel" />
      <div class="help">Up to three, separated by commas. Anything past the third is dropped.</div>
    </div>
    <label class="check check-spaced">
      <input type="checkbox" id="f-membersOnly" /> Members only
    </label>
  </section>

  <section class="sec">
    <h2>Address</h2>
    <div class="field">
      <label for="f-slug">Web address</label>
      <input type="text" id="f-slug" class="mono" autocomplete="off" />
      <div class="help">Filled in from the event name. Change it only when two events share a name.</div>
    </div>
  </section>

  <section class="sec sec-submit">
    <button type="button" class="btn btn-pink" id="btn-add" disabled title="Sign in to add an event">Add this event</button>
    <span class="hint">It appears on the site once the deploy finishes, a minute or two later.</span>
  </section>

</div>

<div class="toast" id="toast"></div>

<script src="../clerk-config.js"></script>
<script type="module" src="events.js"></script>
<script>
  /* The page is an ES module importing /lib/*.mjs, so it needs an HTTP origin
     AND the trailing slash — at /admin/events the relative imports resolve
     one directory up and every one of them 404s, leaving a form that
     validates nothing. vercel.json redirects to the slash; this is what says
     so when something else went wrong. */
  window.addEventListener('load', function () {
    if (window.WIF_EVENTS) return;
    document.body.insertAdjacentHTML('afterbegin',
      '<div class="load-error" role="alert">' +
      'This page did not load. It imports ES modules, so it has to be served: ' +
      'open <code>/admin/events/</code> with the trailing slash.</div>');
  });
</script>
</body>
</html>
```

- [ ] **Step 3: Write `src/admin/events/events.js`**

ES5 syntax in the body, matching `src/admin/editor.js`, which is ES5 throughout.

```js
/* /admin/events/ — add an event that was never in Luma.
 *
 * The form refuses what lib/event-entry.mjs refuses, in the field, where the
 * author can see it — the same bargain the post editor strikes in
 * buildPostObject(). It does that by importing the very module the build
 * uses, rather than restating its rules: a second copy of them is the drift
 * lib/slug.mjs's header was written about.
 *
 * The server validates again regardless. This is for the author's benefit,
 * not the repository's.
 */
import { normalizeEntry } from '/lib/event-entry.mjs';
import { slugify } from '/lib/slug.mjs';

window.WIF_EVENTS = true;

var MAX_IMAGE_BYTES = 3000000;

function $(id) { return document.getElementById(id); }

function setStatus(target, message, tone) {
  var el = typeof target === 'string' ? $(target) : target;
  if (!el) return;
  el.textContent = message || '';
  el.className = 'status-line' + (message && tone ? ' is-' + tone : '');
}

/* ------------------------------------------------------------------ dates */

/* A local date and time plus a named zone, as an ISO string WITH an offset.
 *
 * Sending a naive "2026-11-12T18:00" is how an evening event retires at the
 * wrong moment: lib/event-entry.mjs reads it through new Date(), which treats
 * a bare timestamp as UTC — five hours off in New York, and in the wrong
 * direction. The offset is computed for the chosen zone ON THAT DATE, so an
 * event either side of a daylight-saving change gets the offset it actually
 * has rather than today's.
 */
function offsetFor(zone, date) {
  var format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, timeZoneName: 'longOffset'
  });
  var part = format.formatToParts(date).filter(function (p) {
    return p.type === 'timeZoneName';
  })[0];
  /* "GMT-05:00", or plain "GMT" at zero. */
  var name = part ? part.value : 'GMT';
  var match = name.match(/GMT([+-]\d{2}:\d{2})/);
  return match ? match[1] : '+00:00';
}

function isoWithOffset(dateValue, timeValue, zone) {
  if (!dateValue) return '';
  var time = timeValue || '00:00';
  /* The offset depends on the instant, and the instant depends on the offset.
     One pass at UTC gets within an hour of the answer, which is always enough
     to land on the right side of a daylight-saving boundary; the second pass
     uses the offset from that instant. */
  var guess = new Date(dateValue + 'T' + time + ':00Z');
  if (isNaN(guess.getTime())) return '';
  var offset = offsetFor(zone, guess);
  var settled = new Date(dateValue + 'T' + time + ':00' + offset);
  return dateValue + 'T' + time + ':00' + offsetFor(zone, settled);
}

/* ------------------------------------------------------------------- form */

var cover = { file: null, base64: '', ext: '', blobUrl: '' };
var signedIn = false;

function readForm() {
  var zone = $('f-timezone').value;
  var entry = {
    name: $('f-name').value.trim(),
    slug: slugify($('f-slug').value) || slugify($('f-name').value),
    startAt: isoWithOffset($('f-start-date').value, $('f-start-time').value, zone),
    endAt: isoWithOffset($('f-end-date').value, $('f-end-time').value, zone) || null,
    timezone: zone,
    url: $('f-url').value.trim(),
    city: $('f-city').value,
    place: $('f-place').value.trim(),
    locationType: $('f-locationType').value,
    membersOnly: $('f-membersOnly').checked,
    /* Split and trimmed here rather than sent as a string: normalizeEntry()
       guards with Array.isArray and would silently drop a string, leaving an
       author who typed tags with none and nothing to say why. */
    tags: $('f-tags').value.split(',').map(function (tag) {
      return tag.trim();
    }).filter(Boolean).slice(0, 3)
  };
  /* coverPath is the endpoint's to write, never the form's — so the form
     sends the BYTES and lets the server name the file. A hosted URL is a
     different field and goes as itself. */
  if (!cover.base64 && $('f-coverUrl').value.trim()) {
    entry.coverUrl = $('f-coverUrl').value.trim();
  }
  return entry;
}

/* What the build would say about this event, asked of the build's own code. */
function validate(entry) {
  if (!entry.startAt) return 'Choose a start date.';
  var verdict = normalizeEntry(entry, new Date(), 1);
  if (verdict.expired) {
    return 'That event has already finished, so it would not appear on the site.';
  }
  if (verdict.error) return 'This event cannot be added: ' + verdict.error + '.';
  return '';
}

function refresh() {
  $('f-slug').placeholder = slugify($('f-name').value) || 'event-address';
  var url = $('f-url').value.trim();
  /* An author pasting a lu.ma link has misunderstood what this page is for,
     so it is explained rather than reported as a validation error. */
  $('f-url-warn').hidden = !/^https?:\/\/(www\.)?(lu\.ma|luma\.com)\//i.test(url);
  updateAvailability();
}

function updateAvailability() {
  var button = $('btn-add');
  button.disabled = !signedIn;
  button.title = signedIn ? '' : 'Sign in to add an event';
}

/* ------------------------------------------------------------------ cover */

function onCoverChosen() {
  var file = $('img-file').files[0];
  cover = { file: null, base64: '', ext: '', blobUrl: '' };
  $('img-thumb').style.backgroundImage = '';
  $('img-thumb').textContent = 'No image';
  if (!file) { setStatus('img-status', ''); return; }

  var ext = /\.png$/i.test(file.name) || file.type === 'image/png' ? 'png' : 'jpg';
  /* The same two the site serves as a cover, and the same two
     api/add-event.js allows. Refused here so an author learns it from the
     field rather than from a failed submit. */
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
    setStatus('img-status', 'Use a JPG or a PNG.', 'error');
    $('img-file').value = '';
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    setStatus('img-status', 'That image is too large. Keep it under 3 MB.', 'error');
    $('img-file').value = '';
    return;
  }

  var reader = new FileReader();
  reader.onload = function () {
    /* readAsDataURL gives "data:image/jpeg;base64,…"; the prefix has to come
       off. Buffer.from() on the server does not throw on it — it skips the
       characters outside the alphabet and decodes to wrong bytes — so sending
       it would commit a corrupt image. isCleanBase64() catches that, but the
       author should never reach it. */
    var comma = String(reader.result).indexOf(',');
    cover = {
      file: file, ext: ext,
      base64: String(reader.result).slice(comma + 1),
      blobUrl: URL.createObjectURL(file)
    };
    $('img-thumb').textContent = '';
    $('img-thumb').style.backgroundImage = 'url(' + cover.blobUrl + ')';
    setStatus('img-status', file.name + ' ready.', 'ok');
    refresh();
  };
  reader.onerror = function () {
    setStatus('img-status', 'That image could not be read. Try choosing it again.', 'error');
  };
  reader.readAsDataURL(file);
}

/* ------------------------------------------------------------------ submit */

async function addEvent() {
  var entry = readForm();
  var problem = validate(entry);
  if (problem) { setStatus('add-status', problem, 'error'); return; }

  $('btn-add').disabled = true;
  setStatus('add-status', 'Adding the event…', 'busy');

  var payload = { event: entry };
  if (cover.base64) payload.image = { base64: cover.base64, ext: cover.ext };

  try {
    var response = await fetch('/api/add-event', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(payload)
    });
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      if (response.status === 401) handleUnauthorized();
      setStatus('add-status', result.message || 'Adding the event failed. Nothing was changed.', 'error');
      updateAvailability();
      return;
    }
    setStatus('add-status',
      'Added. It appears on the site once the deploy finishes, a minute or two from now.', 'ok');
    resetForm();
  } catch (error) {
    setStatus('add-status', 'Adding the event failed. Check your connection and try again.', 'error');
  }
  updateAvailability();
}

function resetForm() {
  ['f-name', 'f-start-date', 'f-start-time', 'f-end-date', 'f-end-time',
   'f-url', 'f-place', 'f-tags', 'f-coverUrl', 'f-slug'].forEach(function (id) {
    $(id).value = '';
  });
  $('f-membersOnly').checked = false;
  $('img-file').value = '';
  onCoverChosen();
  refresh();
}

// … authHeaders(), handleUnauthorized(), waitForClerk(), initClerk(),
//     openDrawer(), closeDrawer(), updateAccountButton(), startClerk():
//     copy verbatim from src/admin/editor.js's "auth" and "account drawer"
//     sections, dropping renderAdminTools()/isAdminUser() (this page has no
//     admin tools) and replacing updatePublishAvailability() with
//     updateAvailability(). …

window.addEventListener('DOMContentLoaded', function () {
  startClerk();
  ['f-name', 'f-url', 'f-slug'].forEach(function (id) {
    $(id).addEventListener('input', refresh);
  });
  $('img-file').addEventListener('change', onCoverChosen);
  $('btn-add').addEventListener('click', addEvent);
  $('btn-account').addEventListener('click', function () {
    openDrawer('account-drawer', 'btn-account');
  });
  $('btn-drawer-close').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && drawerIsOpen()) closeDrawer();
  });
  refresh();
});
```

**On the commented block:** the auth and drawer code is genuinely identical to the editor's and is copied rather than shared, because extracting it is a third refactor on top of two this plan already carries. Note it as the next thing to tidy; do not leave the comment in place of working code.

- [ ] **Step 4: Link the page from the editor**

In `src/admin/index.html`, in the last `.bar-group` beside the account button:

```html
  <div class="bar-group">
    <a class="btn btn-sm" href="events/">Add an event</a>
    <button type="button" class="btn btn-sm" id="btn-account">Sign in</button>
  </div>
```

- [ ] **Step 5: Build and exercise the page locally**

Run: `npm run build && npx http-server _site -p 8080 -s`

Open `http://localhost:8080/admin/events/` and confirm:

- no `load-error` banner, and no 404 for `/lib/event-entry.mjs` in the network tab
- the page is styled — if it is unstyled, `../admin.css` did not resolve
- **Add this event** is disabled and reads "Sign in to add an event"
- typing a name fills the address placeholder beneath it
- pasting `https://lu.ma/abc123` shows the Luma warning
- choosing a JPG shows the thumbnail; choosing a `.webp` is refused in the field
- a date in 2020 is refused with the "already finished" sentence, not a 500

Record the result of each. The submit path needs a Clerk session and a GitHub credential, so it is verified on a deployment in Step 7.

- [ ] **Step 6: Run the whole suite**

Run: `npm test && npm run build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/admin/events src/admin/index.html vercel.json
git commit -m "Add the events page

A single-column form at /admin/events/ that validates by importing the module
the build validates with, so it cannot submit an event the renderer would
drop. The trailing-slash redirect matters: without it every module import
resolves a directory up and the form validates nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: `listDirectory()` and `GET /api/manual-events`

The list is read from **GitHub, not the deployed bundle**, and that is the decision this task exists to get right. `api/events.js` reads events out of its own function bundle, which is a build artifact — correct for rendering, because a page can only show what was built. It is wrong for editing: the bundle is as old as the last deploy, so an author would open a stale copy, change one field, and write back a file that silently reverts whatever someone else changed in between.

**Files:**
- Modify: `lib/github.mjs`
- Create: `api/manual-events.js`
- Test: `tools/github.test.mjs` (modify), `tools/manual-events-endpoint.test.mjs` (create)

**Interfaces:**
- Consumes: `normalizeEntry` from `lib/event-entry.mjs`; `authenticateClerkRequest`; `resolveGithubToken`
- Produces:
  - `listDirectory({ token, owner, repo, branch, path, fetchImpl })` → `Array<string>` of filenames, `[]` for a missing directory
  - `GET /api/manual-events` → `200 { events: [{ slug, name, startAt, endAt, place, city, over, broken, entry }] }`, where `entry` is the whole committed object — Task 10 fills the form from it without a second request

- [ ] **Step 1: Write the failing test for `listDirectory()`**

Append to `tools/github.test.mjs`, following the fake-fetch style already in that file:

```js
test('listDirectory returns the filenames on the branch', async () => {
  const fetchImpl = fakeFetch({
    '/repos/o/r/contents/src/_data/manual-events': {
      status: 200,
      json: [
        { name: 'a-mixer.json', type: 'file' },
        { name: 'b-panel.json', type: 'file' },
        { name: 'nested', type: 'dir' }
      ]
    }
  });
  const names = await listDirectory({
    token: 't', owner: 'o', repo: 'r', branch: 'main',
    path: 'src/_data/manual-events', fetchImpl
  });
  assert.deepEqual(names, ['a-mixer.json', 'b-panel.json'], 'directories are not files');
});

test('listDirectory returns [] for a directory that is not there', async () => {
  const fetchImpl = fakeFetch({ '/repos/o/r/contents/nope': { status: 404 } });
  assert.deepEqual(await listDirectory({
    token: 't', owner: 'o', repo: 'r', branch: 'main', path: 'nope', fetchImpl
  }), []);
});

test('listDirectory raises auth on a rejected credential', async () => {
  const fetchImpl = fakeFetch({ '/repos/o/r/contents/x': { status: 401 } });
  await assert.rejects(
    () => listDirectory({ token: 't', owner: 'o', repo: 'r', branch: 'main', path: 'x', fetchImpl }),
    (error) => error.code === 'auth');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/github.test.mjs`

Expected: FAIL — `listDirectory` is not exported.

- [ ] **Step 3: Add `listDirectory()` to `lib/github.mjs`**

Beside `getFileContent()`, which it mirrors:

```js
/* The filenames in a directory on the branch, or [] if it is not there.
 *
 * The one piece of GitHub plumbing this project did not already have. It
 * exists because /admin/events/ lists events for editing, and a list read out
 * of the deployed function bundle is as old as the last deploy -- an author
 * would open a stale event, change one field, and write back a file that
 * reverts whatever somebody else changed in between. Rendering can read the
 * bundle; editing has to read the branch.
 *
 * Directories within the directory are dropped rather than returned: callers
 * want files, and nothing here nests.
 */
export async function listDirectory({ token, owner, repo, branch, path, fetchImpl = fetch }) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`${API}/repos/${owner}/${repo}/contents/${encodedPath}`);
  url.searchParams.set('ref', branch);
  const response = await fetchImpl(String(url), {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'nyc-fintech-women-admin'
    }
  });
  if (response.status === 404) return [];
  if (response.status === 401 || response.status === 403) {
    throw fail('GitHub rejected the credential', 'auth');
  }
  if (!response.ok) throw fail(`GitHub returned ${response.status}`, 'github');
  const json = await response.json();
  /* A path that is a FILE comes back as an object, not an array. Nothing
     should be calling this on one, but returning [] beats throwing a
     TypeError from .filter deep inside an endpoint. */
  if (!Array.isArray(json)) return [];
  return json.filter((entry) => entry && entry.type === 'file' && typeof entry.name === 'string')
    .map((entry) => entry.name);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/github.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write the failing tests for the endpoint**

Create `tools/manual-events-endpoint.test.mjs`, reusing the request/response/fetch doubles from `tools/add-event.test.mjs` (Task 5):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/manual-events.js';

/* What the events page lists for editing. Read from the branch rather than
   from this function's own bundle: the bundle is as old as the last deploy,
   and an edit form that opens a stale copy writes back a clobber. */

test('a request without a session token is refused', async () => {
  const response = await get({ token: null });
  assert.equal(response.status, 401);
});

test('every event file on the branch is listed', async () => {
  const response = await get({ files: {
    'a-mixer.json': { name: 'A Mixer', slug: 'a-mixer', startAt: '2026-12-01T18:00:00-05:00', url: 'https://example.com/a' },
    'b-panel.json': { name: 'B Panel', slug: 'b-panel', startAt: '2026-12-02T18:00:00-05:00', url: 'https://example.com/b' }
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.events.map((e) => e.slug).sort(), ['a-mixer', 'b-panel']);
});

test('each row carries the whole entry, so opening one needs no second request', async () => {
  const entry = {
    name: 'A Mixer', slug: 'a-mixer', startAt: '2026-12-01T18:00:00-05:00',
    url: 'https://example.com/a', place: 'Soho', tags: ['Mixer']
  };
  const response = await get({ files: { 'a-mixer.json': entry } });
  assert.deepEqual(response.json.events[0].entry, entry);
});

test('an event that has already passed is listed, and marked as over', async () => {
  /* The site hides it, but the FILE is still there, and housekeeping is the
     one job that needs to see it. */
  const response = await get({ files: {
    'old.json': { name: 'Last Year', slug: 'old', startAt: '2020-01-01T18:00:00-05:00', url: 'https://example.com/x' }
  } });
  assert.equal(response.json.events.length, 1);
  assert.equal(response.json.events[0].over, true);
});

test('a file that will not parse is skipped, and the rest still list', async () => {
  const response = await get({
    files: { 'good.json': { name: 'Good', slug: 'good', startAt: '2026-12-01T18:00:00-05:00', url: 'https://example.com/g' } },
    rawFiles: { 'broken.json': '{ not json' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.events.length, 1);
});

test('a GitHub failure costs the list, not the page', async () => {
  const response = await get({ failWith: 500 });
  assert.equal(response.status, 502);
  assert.ok(response.json.message, 'an author-readable sentence, not a stack');
});

test('a POST is refused', async () => {
  const response = await get({ method: 'POST' });
  assert.equal(response.status, 405);
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `node --test tools/manual-events-endpoint.test.mjs`

Expected: FAIL — `api/manual-events.js` does not exist.

- [ ] **Step 7: Write `api/manual-events.js`**

```js
/* GET /api/manual-events — the manual events on the branch, for the editor.
 *
 * Deliberately NOT what api/events.js serves. That reads this function's own
 * bundle, which is a build artifact: right for rendering, because a page can
 * only show what was built, and wrong for editing, because an author would
 * open a copy as old as the last deploy and write back over whatever changed
 * since. This reads the branch.
 *
 * Also deliberately not filtered by expiry. An event that is over is invisible
 * on the site but its file is still in the repository, and clearing those out
 * is the one job that needs to see them.
 *
 * Authenticated like the rest of /admin: any signed-in author.
 */
import { authenticateClerkRequest } from '../lib/clerk-request.mjs';
import { normalizeEntry } from '../lib/event-entry.mjs';
import { listDirectory, getFileContent } from '../lib/github.mjs';
import { resolveGithubToken } from '../lib/github-auth.mjs';

const DIR = 'src/_data/manual-events';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!owner || !repo) {
    console.error('Listing events is not configured: missing GITHUB_OWNER/GITHUB_REPO');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }

  const { refusal } = authenticateClerkRequest(request);
  if (refusal) {
    return response.status(refusal.status).json({ message: refusal.message });
  }

  try {
    const token = await resolveGithubToken();
    const names = (await listDirectory({ token, owner, repo, branch, path: DIR }))
      .filter((name) => name.endsWith('.json'))
      .sort();

    const now = new Date();
    const events = [];
    for (const name of names) {
      let entry;
      try {
        entry = JSON.parse(await getFileContent({ token, owner, repo, branch, path: `${DIR}/${name}` }));
      } catch (error) {
        /* One unreadable file must not cost the whole list -- the same
           guarantee lib/manual-events.mjs holds for the calendar. */
        console.warn(`manual events: skipping ${name} -- ${error && error.message}`);
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      /* `over` is computed here rather than in the browser so the page and the
         site agree on when an event retires: normalizeEntry() is the only
         thing that decides that, and it says so by returning `expired`. */
      const verdict = normalizeEntry(entry, now, 1);
      events.push({
        slug: name.replace(/\.json$/, ''),
        name: typeof entry.name === 'string' ? entry.name : '(unnamed)',
        startAt: entry.startAt || null,
        endAt: entry.endAt || null,
        place: entry.place || '',
        city: entry.city || 'other',
        over: verdict.expired === true,
        /* So the page can show which events it cannot open cleanly rather
           than failing silently when the author clicks one. */
        broken: !!verdict.error,
        /* The whole entry, so opening one into the form costs no second
           request -- these files are a few hundred bytes and the author is
           already authenticated. It also carries the fields the form does not
           show, so a save cannot silently drop them. */
        entry
      });
    }
    return response.status(200).json({ events });
  } catch (error) {
    if (error.code === 'auth') {
      console.error('GitHub rejected the credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Could not list manual events', error);
    return response.status(502).json({ message: 'The event list could not be loaded. You can still add an event.' });
  }
}
```

- [ ] **Step 8: Run both test files, then the suite**

Run: `node --test tools/manual-events-endpoint.test.mjs tools/github.test.mjs && npm test`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/github.mjs api/manual-events.js tools/github.test.mjs tools/manual-events-endpoint.test.mjs
git commit -m "List the manual events on the branch

Read from GitHub rather than the function's own bundle: the bundle is as old
as the last deploy, and an edit form that opens a stale copy writes back a
clobber. Events that are over are listed too -- the file outlives the card.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: `POST /api/remove-event`

Modelled directly on `api/unpublish.js`, including its rule for the cover: delete it only when the **live** file's `coverPath` is a path this project could have written. A partner-hosted or hand-set cover is not ours to remove.

**Files:**
- Create: `api/remove-event.js`
- Test: `tools/remove-event.test.mjs` (create)

**Interfaces:**
- Consumes: `eventPathFor`, `coverPathFor`, `COVER_EXTS` from `api/add-event.js` (Task 5); `getFileContent`, `commitWithRetry` from `lib/github.mjs`; `authenticateClerkRequest`; `authorNameFromSub`; `resolveGithubToken`; `slugify`
- Produces: `POST /api/remove-event`, body `{ slug }` → `200 { slug, commit }` | `4xx/5xx { message }`

- [ ] **Step 1: Read `api/unpublish.js` in full**

Run: `cat api/unpublish.js`

This task is that file with a different path convention. Follow its structure and its refusal wording rather than inventing a parallel set.

- [ ] **Step 2: Write the failing tests**

Create `tools/remove-event.test.mjs`, reusing the doubles from `tools/add-event.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/remove-event.js';

/* The only irreversible thing an author can do on this page. The page asks
   them to type the address first; this file makes sure that what gets deleted
   is exactly the event named and nothing else. */

test('a request without a session token is refused', async () => {
  const response = await remove({ slug: 'a-mixer' }, { token: null });
  assert.equal(response.status, 401);
});

test('a slug with no file is refused rather than reported as removed', async () => {
  const { response, commits } = await remove({ slug: 'never-existed' });
  assert.equal(response.status, 404);
  assert.equal(commits.length, 0);
});

test('the event file is deleted', async () => {
  const path = 'src/_data/manual-events/a-mixer.json';
  const { response, commits } = await remove({ slug: 'a-mixer' }, {
    liveFiles: { [path]: JSON.stringify({ slug: 'a-mixer', name: 'A Mixer' }) }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(commits[0].files, [{ path, delete: true }]);
});

test('a cover this project wrote goes with it, in the same commit', async () => {
  const path = 'src/_data/manual-events/a-mixer.json';
  const { commits } = await remove({ slug: 'a-mixer' }, {
    liveFiles: { [path]: JSON.stringify({
      slug: 'a-mixer', coverPath: 'images/event-a-mixer.jpg'
    }) }
  });
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].files.map((f) => f.path).sort(), [
    'src/_data/manual-events/a-mixer.json',
    'src/images/event-a-mixer.jpg'
  ]);
  assert.ok(commits[0].files.every((f) => f.delete));
});

test('a png cover is cleaned up as reliably as a jpg one', async () => {
  const path = 'src/_data/manual-events/a-mixer.json';
  const { commits } = await remove({ slug: 'a-mixer' }, {
    liveFiles: { [path]: JSON.stringify({ slug: 'a-mixer', coverPath: 'images/event-a-mixer.png' }) }
  });
  assert.ok(commits[0].files.some((f) => f.path === 'src/images/event-a-mixer.png' && f.delete));
});

test('a partner-hosted cover is left alone', async () => {
  const path = 'src/_data/manual-events/a-mixer.json';
  const { commits } = await remove({ slug: 'a-mixer' }, {
    liveFiles: { [path]: JSON.stringify({
      slug: 'a-mixer', coverUrl: 'https://partner.example.com/cover.jpg'
    }) }
  });
  assert.deepEqual(commits[0].files.map((f) => f.path), [path]);
});

test('a hand-set coverPath pointing somewhere else is left alone', async () => {
  /* It may be an image another page uses. Only a path this project's own
     convention produces is safe to delete. */
  const path = 'src/_data/manual-events/a-mixer.json';
  const { commits } = await remove({ slug: 'a-mixer' }, {
    liveFiles: { [path]: JSON.stringify({ slug: 'a-mixer', coverPath: 'images/fff-shira-amrany.jpg' }) }
  });
  assert.deepEqual(commits[0].files.map((f) => f.path), [path]);
});

test('a traversing slug cannot delete anything outside the events directory', async () => {
  for (const slug of ['../../../etc/passwd', '../../lib/github.mjs']) {
    const { response, commits } = await remove({ slug });
    for (const file of (commits[0] ? commits[0].files : [])) {
      assert.ok(file.path.startsWith('src/_data/manual-events/') ||
                file.path.startsWith('src/images/'), file.path);
      assert.ok(!file.path.includes('..'), file.path);
    }
    assert.ok(response.status === 400 || response.status === 404);
  }
});

test('a GET is refused', async () => {
  const response = await remove({ slug: 'a-mixer' }, { method: 'GET' });
  assert.equal(response.status, 405);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tools/remove-event.test.mjs`

Expected: FAIL — `api/remove-event.js` does not exist.

- [ ] **Step 4: Write `api/remove-event.js`**

```js
/* POST /api/remove-event — take a manual event off the site.
 *
 * api/unpublish.js with a different path convention, and it keeps that file's
 * one careful rule: the cover is deleted only when the LIVE file's coverPath
 * is a path this project's own convention produces. A partner-hosted cover is
 * not ours to delete, and a hand-set one may be an image another page uses.
 * The live file is read for this rather than trusting the client, whose copy
 * may be a stale draft.
 *
 * There is no undo. The page asks the author to type the address first; this
 * endpoint does not second-guess that, but it does refuse a slug with no file
 * rather than reporting a success that removed nothing.
 */
import { authenticateClerkRequest } from '../lib/clerk-request.mjs';
import { authorNameFromSub } from '../lib/session.mjs';
import { commitWithRetry, getFileContent } from '../lib/github.mjs';
import { resolveGithubToken } from '../lib/github-auth.mjs';
import { slugify } from '../lib/slug.mjs';
import { eventPathFor, coverPathFor, COVER_EXTS } from './add-event.js';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const hasGithubCredential = !!process.env.GITHUB_TOKEN ||
    !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_INSTALLATION_ID);
  if (!owner || !repo || !hasGithubCredential) {
    console.error('Publishing is not configured');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }

  const { email: authorEmail, refusal } = authenticateClerkRequest(request);
  if (refusal) {
    return response.status(refusal.status).json({ message: refusal.message });
  }

  const payload = typeof request.body === 'object' && request.body ? request.body : {};
  /* Slugified before it builds a path, the check that makes api/post.js safe.
     A traversing slug becomes a harmless one rather than escaping. */
  const slug = slugify(payload.slug);
  if (!slug) {
    return response.status(400).json({ message: 'Name the event to remove.' });
  }

  const path = eventPathFor(slug);

  let token;
  try {
    token = await resolveGithubToken();
  } catch (error) {
    if (error.code === 'key') {
      console.error("The site's GitHub private key could not be used", error);
      return response.status(503).json({ message: error.message });
    }
    console.error('Could not obtain a GitHub credential', error);
    return response.status(502).json({ message: 'Removing the event failed. Nothing was changed.' });
  }

  let live = null;
  try {
    const text = await getFileContent({ token, owner, repo, branch, path });
    if (text === null) {
      return response.status(404).json({
        message: 'There is no event at that address. It may already have been removed.'
      });
    }
    try {
      live = JSON.parse(text);
    } catch (error) {
      /* A file that will not parse still has to be removable -- that is
         exactly when somebody wants it gone. Its cover is simply not matched. */
      console.warn(`remove-event: the live ${path} does not parse; removing it anyway`);
    }
  } catch (error) {
    if (error.code === 'auth') {
      console.error('GitHub rejected the credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Could not read the event being removed', error);
    return response.status(502).json({ message: 'Removing the event failed. Nothing was changed.' });
  }

  const files = [{ path, delete: true }];

  /* Only a path this endpoint's own convention produces. Anything else --
     a partner's URL, or images/fff-someone.jpg set by hand -- is left where
     it is. Deleting an image another page renders is not recoverable from
     here. */
  const liveCover = live && typeof live.coverPath === 'string' ? live.coverPath.trim() : '';
  const conventional = COVER_EXTS.map((ext) => coverPathFor(slug, ext));
  if (liveCover && conventional.includes(liveCover)) {
    files.push({ path: `src/${liveCover}`, delete: true });
  }

  try {
    const result = await commitWithRetry({
      token, owner, repo, branch,
      message: `Remove event ${slug}\n\nRemoved from the events page by ${authorEmail}.`,
      author: { name: authorNameFromSub(authorEmail), email: authorEmail },
      files
    });
    return response.status(200).json({ slug, commit: result.sha });
  } catch (error) {
    if (error.code === 'stale_head') {
      return response.status(409).json({ message: 'Someone else just published. Try again.' });
    }
    if (error.code === 'auth') {
      console.error('GitHub rejected the credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Remove event failed', error);
    return response.status(502).json({ message: 'Removing the event failed. Nothing was changed.' });
  }
}
```

- [ ] **Step 5: Run the tests, then the suite**

Run: `node --test tools/remove-event.test.mjs && npm test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/remove-event.js tools/remove-event.test.mjs
git commit -m "Add an endpoint that removes a manual event

api/unpublish.js with a different path convention, including its rule for the
cover: only a path this project's own convention produces is deleted. A
partner's image is not ours to remove.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: The events drawer — open, edit and remove in the page

Task 7 built the form. This gives it a list, an open-into-the-form path, an update mode and a remove control. It reuses the drawer, `.post-row` and `.sec-danger` patterns the editor already has.

**Do Task 7 first.** This task edits the files Task 7 creates.

**Files:**
- Modify: `src/admin/events/index.html`
- Modify: `src/admin/events/events.js`
- Modify: `src/admin/index.html` (the `.post-row` rules move to `admin.css`)
- Modify: `src/admin/admin.css`

**Interfaces:**
- Consumes: `GET /api/manual-events` (Task 8); `POST /api/remove-event` (Task 9); `POST /api/add-event` with `mode` (Task 5)
- Produces: a drawer at `#events-drawer`, and `openedSlug` state in `events.js` that decides `mode`

- [ ] **Step 1: Move the row rules into the shared stylesheet**

`.post-row`, `.post-open`, `.post-meta` were left inline in `src/admin/index.html` by Task 6 because only the editor used them. The events drawer uses the same rows, so they move to `src/admin/admin.css` now — and the comment above them generalises:

```css
/* A row in a list drawer: published posts in the editor, added events on the
   events page. The row itself opens the thing, so the target is the whole row
   rather than a small control, and a destructive action sits apart from it. */
```

Verify the editor's drawer still renders identically afterwards.

- [ ] **Step 2: Add the drawer and the edit controls to `index.html`**

In the topbar, before the account group:

```html
  <div class="bar-group" role="group" aria-label="Events">
    <span class="status" id="edit-status">New event</span>
    <button type="button" class="btn btn-sm" id="btn-new">New event</button>
    <button type="button" class="btn btn-sm" id="btn-open-event">Open event</button>
  </div>
```

After the account drawer:

```html
<!-- The events already added. "Open event" opens this rather than a file
     picker: an author signed in here has no clone of the repository. The list
     is read from the branch, not from the last deploy, so an event added a
     moment ago is already in it. -->
<aside id="events-drawer" class="drawer" role="dialog" aria-modal="true" aria-labelledby="events-drawer-title" hidden>
  <div class="drawer-head">
    <h2 id="events-drawer-title">Events you have added</h2>
    <button type="button" class="btn-icon" id="btn-events-close" aria-label="Close">&times;</button>
  </div>
  <div class="drawer-body">
    <div class="drawer-sticky">
      <p id="events-status" class="status-line" role="status"></p>
      <p class="hint">Events that have finished are still listed — the site hides them, but the file stays until it is removed.</p>
    </div>
    <div id="events-list"></div>
  </div>
</aside>
```

And at the end of the column, the removal panel, modelled on the editor's:

```html
  <details id="remove-panel" class="sec sec-danger" hidden>
    <summary>Remove this event</summary>
    <p class="hint">This takes the event off the site, along with a cover uploaded here. It cannot be undone. Type the event's address to confirm.</p>
    <div class="field field-spaced">
      <label for="remove-confirm">Event address <span class="req">*</span></label>
      <input id="remove-confirm" type="text" class="mono" autocomplete="off" placeholder="the-event-address" />
    </div>
    <button id="btn-remove" type="button" class="btn btn-sm btn-danger" disabled>Remove</button>
    <p id="remove-status" class="status-line" role="status"></p>
  </details>
```

`details.sec-danger` must move from the editor's inline styles to `admin.css` in Step 1 as well.

- [ ] **Step 3: Add the open/update/remove behaviour to `events.js`**

```js
/* The event this session has actually opened, or '' for a new one.
 *
 * This is what decides mode, and it is set ONLY by opening an event from the
 * drawer or by a successful add -- never by what is typed in the address
 * field. An author who types an existing address into a new event gets the
 * 409 from api/add-event.js, which is the correct answer: it is a different
 * event that happens to want a taken name.
 */
var openedSlug = '';

function setOpened(slug) {
  openedSlug = slug || '';
  $('edit-status').textContent = openedSlug ? 'Editing ' + openedSlug : 'New event';
  /* The slug is the filename, so changing it on an existing event would write
     a second file and leave the first -- one event silently becoming two.
     Renaming is remove-then-add, which is honest: a renamed event is a new
     address. */
  $('f-slug').disabled = !!openedSlug;
  $('f-slug').title = openedSlug
    ? 'An event\'s address cannot change. Remove it and add it again under the new name.' : '';
  $('remove-panel').hidden = !openedSlug;
  $('remove-confirm').value = '';
  $('btn-remove').disabled = true;
  $('btn-add').textContent = openedSlug ? 'Save changes' : 'Add this event';
}

async function loadEvents() {
  setStatus('events-status', 'Loading…', 'busy');
  $('events-list').innerHTML = '';
  try {
    var response = await fetch('/api/manual-events', { headers: await authHeaders() });
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      if (response.status === 401) handleUnauthorized();
      setStatus('events-status', result.message || 'The list could not be loaded.', 'error');
      return;
    }
    setStatus('events-status', '');
    renderEvents(result.events || []);
  } catch (error) {
    setStatus('events-status', 'The list could not be loaded. Check your connection.', 'error');
  }
}

function renderEvents(events) {
  var list = $('events-list');
  if (!events.length) {
    list.innerHTML = '<p class="empty-note">No events added yet.</p>';
    return;
  }
  events.forEach(function (event) {
    var row = document.createElement('div');
    row.className = 'post-row';
    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'post-open';
    var when = event.startAt ? new Date(event.startAt).toLocaleString() : 'no date';
    open.innerHTML = '<strong></strong><span class="post-meta"></span>';
    open.querySelector('strong').textContent = event.name;
    open.querySelector('.post-meta').textContent =
      event.slug + ' · ' + when + (event.over ? ' · over' : '');
    open.addEventListener('click', function () { openEvent(event.slug); });
    row.appendChild(open);
    list.appendChild(row);
  });
}

/* Opened from the LIST's own data rather than re-fetching the file: the list
   already came from the branch a moment ago, so a second request would buy
   nothing. The fields the form does not show are carried on the object so a
   save does not drop them. */
var openedEntry = null;

function openEvent(slug) {
  /* … find the row's entry, fill every field from it, set openedEntry,
       call setOpened(slug), closeDrawer() … */
}
```

Each row from `GET /api/manual-events` already carries its whole `entry` (Task 8), so `openEvent()` fills the form from data it has and makes no request.

Then in `addEvent()`, send the mode and carry the unshown fields:

```js
  var payload = { mode: openedSlug ? 'update' : 'create', event: entry };
```

And on success:

```js
    if (openedSlug) {
      setStatus('add-status', 'Saved. The change is live once the deploy finishes.', 'ok');
    } else {
      setStatus('add-status', 'Added. It appears on the site once the deploy finishes.', 'ok');
      resetForm();
      setOpened('');
    }
```

Removal, modelled on the editor's unpublish:

```js
/* The confirm field matches against the slug this session actually opened,
   not against anything typed elsewhere -- the editor's rule, for the same
   reason: the point is to make the author name what they are destroying. */
$('remove-confirm').addEventListener('input', function () {
  $('btn-remove').disabled = slugify($('remove-confirm').value) !== openedSlug;
});

async function removeEvent() {
  if (slugify($('remove-confirm').value) !== openedSlug) return;
  $('btn-remove').disabled = true;
  setStatus('remove-status', 'Removing…', 'busy');
  try {
    var response = await fetch('/api/remove-event', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ slug: openedSlug })
    });
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      if (response.status === 401) handleUnauthorized();
      setStatus('remove-status', result.message || 'Removing the event failed.', 'error');
      return;
    }
    setStatus('add-status', 'Removed. It comes off the site once the deploy finishes.', 'ok');
    resetForm();
    setOpened('');
  } catch (error) {
    setStatus('remove-status', 'Removing the event failed. Check your connection.', 'error');
  }
}
```

Wire the new controls in the `DOMContentLoaded` block, and call `setOpened('')` there so the page starts in its new-event state.

- [ ] **Step 4: Build and exercise the page**

Run: `npm run build && npx http-server _site -p 8080 -s`

At `http://localhost:8080/admin/events/`, confirm:

- the page starts on "New event", the address field is editable, and the removal panel is hidden
- **Open event** opens the drawer (it will show a sign-in error without a session — that is the expected unauthenticated behaviour, not a failure)
- the editor at `/admin/` still renders identically after the CSS moves in Step 1

The authenticated paths are verified on a deployment below.

- [ ] **Step 5: Run the suite**

Run: `npm test && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/admin
git commit -m "Open, edit and remove an event from the page

The address is frozen while editing: it is the filename, so changing it would
write a second file and leave the first, one event silently becoming two.
Renaming is remove-then-add.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification on a deployment

Local tests cannot cover the two things most likely to be wrong, both of which only exist on a deployment.

- [ ] **Push and let the deploy finish.**
- [ ] **Add a real partner event** at `/admin/events/` on the deployed site, signed in, with an uploaded cover and an external RSVP URL.
- [ ] **Confirm it renders** on `/events.html` and on the chapter page matching its city, with the cover showing and RSVP leaving the site.
- [ ] **Confirm `includeFiles` is right** — this is the spec's quiet risk. Call `/api/events` directly and check the new event is in the JSON. If the calendar shows Luma events but not this one, `vercel.json`'s glob is wrong and the endpoint shipped without the directory.
- [ ] **Confirm retirement** — add an event whose end time is in the past through a committed file (the page refuses one), and confirm it does not appear.
- [ ] **Confirm the duplicate refusal** — submit the same event name twice; the second gets the 409 sentence, and the first event is still there.
- [ ] **Confirm the list is live, not built** — add an event, and *before* the deploy finishes, open the drawer. The new event must already be listed. If it only appears after the deploy, the list is reading the bundle and Task 8's central decision was lost.
- [ ] **Edit it** — open the event, change the place and the start time, save. Confirm the change is live, the cover survived (it was not re-uploaded), and the address field was disabled throughout.
- [ ] **Replace the cover with a different file type** — open the event, upload a PNG over a JPG, save. Confirm the new cover renders and `src/images/event-<slug>.jpg` is gone from the repository.
- [ ] **Remove it** — type the address, remove, and confirm the event and its cover are both gone from the repository in one commit, and the card disappears from the Events page after the deploy.
- [ ] **Confirm a partner-hosted cover survives removal** — add an event using `coverUrl` rather than an upload, remove it, and confirm the commit deletes only the JSON.

## What this deliberately leaves undone

Carried from the spec's **Out of scope**, so the next reader does not take it for an oversight:

- **Renaming an event in place.** The address is frozen once an event exists; renaming is remove-then-add. A renamed event is a new address.
- **An undo for removal.** A removed event is a deleted file. Typing the address is the only thing between a mis-click and losing it; recovering one is a developer with the git history.
- **Two authors editing one event at once.** `commitWithRetry` is safe for two authors writing two paths, and editing reintroduces two authors writing *one*. The window is seconds and the cost is one event rather than the calendar, so it is accepted — but it is the one place the per-file design stops protecting us.
- **Sharing the auth and drawer code** between `editor.js` and `events.js`. Copied for now; see Task 7 Step 3.
- **Recurring events.** A series is added as separate events.
