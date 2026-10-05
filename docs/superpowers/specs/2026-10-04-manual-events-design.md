# Manual event creation

## Why

Every event on the site comes from the Luma calendar. An event that was never
created there cannot be shown at all — and the ones that matter most are
exactly the ones that never will be: a partner's event, run on the partner's
own registration page.

The immediate case is SVB. The team needs to put a partner event on the site
with the partner's own cover image, and have **RSVP** send people to the
partner's landing page rather than to Luma.

The data layer for this already exists. `lib/manual-events.mjs` normalizes,
validates and merges manual events into the feed, and `api/events.js` serves
them alongside Luma's. It supports a custom `coverUrl`, and its `url` field
deliberately refuses lu.ma links — *"A manual event pointing at lu.ma would be
in Luma already; the whole point is that these link somewhere else."*

What is missing is any way for the team to use it. `src/_data/manual-events.json`
is hand-edited and committed, which means adding a partner event requires a
developer with a checkout. That is the same dependency the publishing phase was
built to remove, and it is why the file is still `[]`.

## What this adds

A page at `/admin/events/` where a signed-in author fills in one form, uploads a
cover image, and the event appears on the site — and where they can open an
event they already added, correct it, or take it down. No checkout, no JSON, no
developer, for the whole life of the event rather than only its first minute.

## Decisions taken

1. **Add, edit and remove.** *(Revised 2026-10-05. This was originally
   add-only, on the reasoning that `lib/manual-events.mjs` retires an event
   once its end time passes, so "it's over, take it down" needs no UI. That
   holds, and it is the wrong question: an event does not only end, it also
   **changes** and gets **cancelled**. A partner moves the room, the start
   slips an hour, the RSVP link breaks, the whole thing is called off in
   October for a date in November. Add-only leaves every one of those live and
   wrong until a developer with a checkout edits the file — and the author
   cannot even correct it by re-adding, because a duplicate slug is refused.
   The original text named this "the known gap and the most likely thing to
   want next"; it was wanted immediately.)*

   The consequence for the rest of this document: `POST /api/add-event` grows
   a `mode`, exactly as `api/publish.js` has one, and two more endpoints join
   it. See **Editing and removing**.
2. **Its own page**, not a type inside the post editor. An event is a flat form:
   no body blocks, no slug-driven filename, no article preview. The post
   editor's three panes exist to serve exactly those, and two of the three would
   have nothing to show.
3. **One file per event**, not an array. See **Why one file per event**.
4. **An uploaded cover is committed to the repository** and referenced by a
   site-relative path. A hosted URL is still accepted, so a partner who supplies
   an image URL does not have to be downloaded and re-uploaded.

## Why one file per event

This is the decision with the most consequence, so it is recorded with its
reasoning.

`manual-events.json` is a single array. The obvious implementation — read it,
append, commit it — loses events. Two authors adding a partner event in the same
minute each read the file, each append their own entry, and each commit. The
second commit fails on a moved branch and `commitWithRetry` retries it, and the
retry **replays the same stale content**: the first author's event is gone, with
no error anywhere and nobody watching.

`commitWithRetry`'s own comment says retrying "cannot clobber their commit". That
is true for posts, because every author writes a different path. It is not true
for a shared array, and reusing it there would quietly import a guarantee that
does not hold.

Rather than solve that with a careful read-modify-write inside the retry, each
event becomes its own file:

```
src/_data/manual-events/<slug>.json
```

Two authors adding events now write two different paths, and the existing retry
is correct for the same reason it is correct for posts. The failure mode is
removed structurally rather than handled.

The cost is a change to `loadManualEvents()`, which is working, tested code: it
reads a directory instead of a file. That is a small, well-covered change, and
it is worth it to make "a partner event silently vanished" impossible rather
than unlikely.

Two consequences to carry:

- `vercel.json`'s `includeFiles` for `api/events.js` names
  `src/_data/manual-events.json` explicitly, because the file sits outside
  `api/`. It becomes `src/_data/manual-events/**`. Getting this wrong means the
  endpoint ships without the events and degrades to Luma-only — quietly, which
  is the failure this project keeps designing against.
- A directory under `src/_data/` becomes a nested object in Eleventy's data
  cascade instead of an array. Nothing reads `manualEvents` through the cascade
  — `api/events.js` reads from disk via `loadManualEvents()` — so this is inert.
  It is noted so the next reader does not mistake it for the source of truth.

Migration is nothing: the array is currently `[]`.

## Architecture

### `src/_data/manual-events/<slug>.json`

One event, in the shape `normalizeEntry()` already accepts:

```json
{
  "name": "Fintech Forward with SVB",
  "slug": "svb-fintech-forward",
  "startAt": "2026-11-12T18:00:00-05:00",
  "endAt": "2026-11-12T20:30:00-05:00",
  "timezone": "America/New_York",
  "url": "https://www.svb.com/events/fintech-forward",
  "coverPath": "images/event-svb-fintech-forward.jpg",
  "city": "nyc",
  "place": "SVB, 1 Hudson Yards",
  "locationType": "offline",
  "membersOnly": false,
  "tags": ["Partner event"]
}
```

The slug is the filename and the identity. `normalizeEntry()` already derives
its id from `entry.slug` before falling back to the name, so this needs no
change.

`coverPath` is **derived by the endpoint, not submitted**. The author uploads
bytes; the endpoint names the file from the slug and writes the field. An author
cannot choose where an image lands, which is what keeps the path check in
**Security** meaningful.

### `lib/manual-events.mjs` — read a directory

`loadManualEvents()` reads every `*.json` in the directory instead of one file,
and hands the collected array to the unchanged `normalizeManualEvents()`.

Everything that makes the current function safe is kept and extended:

- A missing directory degrades to "no manual events", exactly as a missing file
  does today, so the Luma calendar still renders.
- A file that will not parse is skipped **with a warning naming the file**, and
  the rest still ship. Today one bad entry is dropped from an array; now one bad
  file is dropped from a directory. The guarantee is the same: one bad event
  must never take the calendar down.
- Files are read in sorted filename order so the input to
  `normalizeManualEvents()` is deterministic. Order does not survive
  `mergeEvents()`, which re-sorts chronologically, but a stable input makes the
  id-collision fallback (`position in the file`) reproducible.

### `coverPath` — a site-relative cover

`normalizeEntry()` accepts `coverUrl` only as an absolute `https` URL. An
uploaded image lives on this site, so it needs a site-relative path, and
`httpsUrl()` refuses one.

A `coverPath` field is added beside `coverUrl`:

- `coverUrl` keeps its exact current meaning and validation — an absolute
  `https` URL, for a partner-hosted image.
- `coverPath` accepts a site-relative path under `images/`, validated as such
  and nothing else. `../` and absolute URLs are refused.
- The path is the **web** path, as a post's `coverPath` already is: the file is
  committed to `src/images/event-<slug>.<ext>` and referenced as
  `images/event-<slug>.<ext>`. Eleventy passes `src/images/` through to the site
  root, and every page that renders an event card is itself at the root, so a
  root-relative reference resolves from all of them.
- The normalized output still emits a single `coverUrl`, so
  `src/luma-events.js` does not change. It sets `backgroundImage: url(...)`
  through `encodeURI`, which renders a relative path correctly.

`http` stays refused for both, for the reason already recorded: a
mixed-content link from an https page is a broken link.

### `POST /api/add-event`

Named for the verb, like `publish.js` and `unpublish.js`, and deliberately not
`api/event.js` — one letter from the existing `api/events.js` is a filename
nobody should have to read twice.

Authenticated with `authenticateClerkRequest`, matching `publish` and
`unpublish`: any signed-in author, no admin check. Adding a partner event is
the same kind of act as publishing a post.

It:

1. Validates the submitted event by running it through the **same**
   `normalizeEntry()` the build uses, so the editor cannot write a file the
   renderer would later drop. A refusal names the field.
2. Reads `mode`, which is `create` or `update`, and checks it against what is
   actually on the branch — the rule `api/publish.js` already enforces.
   `create` onto an existing file is refused, because a silent overwrite is
   how the second SVB event replaces the first. `update` onto a file that is
   not there is refused, because it means the author is editing something that
   has since been removed, and writing it back would quietly resurrect it.
   Neither refusal can be reached by accident: the page sends `update` only
   for an event it opened.
3. Validates an uploaded cover with the checks `api/publish.js` already
   applies: the size cap, the clean-base64 round-trip, and the JPG/PNG
   allowlist. An event cover is the same problem as a post cover and gets the
   same answer.
4. Commits the event JSON and, when present, the image, in **one** commit via
   `commitWithRetry` — so an event is never live with a missing cover, nor an
   image orphaned by a failed event write.

### Editing and removing

*(Added 2026-10-05, with decision 1.)*

Three decisions carry this, and the first is the one with consequences.

**The slug is frozen once an event exists.** It is the filename, so changing it
on update would write a second file and leave the first — one event silently
becoming two, both live, differing by a typo. The form shows the address field
disabled when editing. Renaming is therefore remove-then-add, which is
honest: a renamed event *is* a new address. This is the same reason
`api/publish.js` recomputes a slug rather than trusting one.

**The list and the open both read GitHub, not the deployed bundle.** This is
the decision that separates editing from adding. `api/events.js` reads the
events out of its own function bundle, which is a build artifact — correct for
rendering, because a page can only ever show what was built. It is wrong for
editing: the bundle is as old as the last deploy, so an author would open a
stale copy of an event, change one field, and write back a file that silently
reverts whatever someone else changed in between. The posts drawer gets away
with a built index because it only ever *opens* a post, and the post file it
then reads is fetched live. An edit form has no such second step, so it reads
live from the start.

The cost is a new function in `lib/github.mjs`: `listDirectory()`, returning
the names in a directory on the branch, or `[]` when it does not exist. It is
the one piece of GitHub plumbing this project does not already have.

**A removed event takes its cover with it**, by exactly the rule
`api/unpublish.js` follows: the cover is deleted only when the **live** file's
`coverPath` matches a path this endpoint could have written
(`images/event-<slug>.jpg` or `.png`). A hand-set or partner-hosted cover is
left alone, because it is not ours to delete. The live file is read for this
rather than trusting the client's copy, which may be a stale draft.

#### `GET /api/manual-events`

Authenticated like the rest. Returns every event file on the branch — not
filtered by expiry, because an event that is over still has a file, and
housekeeping is the one job that needs to see it. Each row carries the slug,
the name, the start, and whether it has already passed, so the page can show
"over" rather than pretending it is upcoming.

A failure here costs the list, not the page: the form still adds.

#### `POST /api/remove-event`

Takes a slug, reads the live file, and deletes it — and its cover, under the
rule above — in **one** commit. Refuses a slug with no file rather than
reporting a success that removed nothing.

It asks for confirmation in the page, not in the endpoint. Removal is the one
irreversible thing an author can do here, and `api/unpublish.js` already
settled what that looks like: type the address to confirm.

#### Cover images on update

Three cases, and the third is the one that leaks files:

- **No new image.** The live file's `coverPath` is carried over unchanged. The
  author editing a time must not lose the cover by not re-uploading it.
- **A new image, same extension.** It overwrites at the same path. Nothing to
  clean up.
- **A new image, different extension** — a PNG replacing a JPG. The new file is
  written *and* the old conventional path is deleted in the same commit, or
  `event-<slug>.jpg` sits in `src/images/` forever with nothing pointing at it.

### `/admin/events/`

A single-column page reusing `src/admin/index.html`'s stylesheet, its field and
button components, its drawer for sign-in, and its status-line component. It is
a sibling of the post editor, not a copy of it: the shared chrome moves into a
file both include rather than being duplicated.

Fields map one-to-one to the JSON above. The form refuses what
`normalizeEntry()` refuses, in the browser, where the author can see the field —
the same bargain the post editor strikes in `buildPostObject()`.

Two fields need care:

- **Start and end** are entered as a local date and time with an explicit
  timezone, and sent as an ISO string with an offset. A naive string is how an
  evening event retires at the wrong moment.
- **RSVP URL** is the whole point of the feature. The form says so, and rejects
  a lu.ma link with an explanation rather than a validation error — an author
  pasting one has misunderstood what this page is for.

## Error handling

Every failure an author can cause is named in the field, not in a console. The
endpoint's refusals are author-readable sentences, as `publish`'s are.

Failures nobody is watching degrade rather than break: a missing directory, an
unparseable file, or an event the normalizer rejects costs that one event, never
the calendar.

## Security

The slug builds a repository path, so it is run through `slugify()` before it is
interpolated — the check that makes `api/post.js` safe, for the same reason.

The cover is written only under `src/images/` with a name derived from the
slug, never from the uploaded filename.

Image bytes are validated before any GitHub call, so a bad upload costs no round
trip — the rule `api/publish.js` already follows.

## Testing

- `normalizeEntry()` accepts `coverPath`, refuses `../` and absolute URLs in it,
  and still refuses `http` for both cover fields.
- `loadManualEvents()` reads a directory, skips an unparseable file while
  keeping the rest, names the skipped file, and returns `[]` for a missing
  directory.
- `POST /api/add-event`: refused without a token; `create` onto an existing
  slug and `update` onto a missing one are both refused; refuses an oversized
  or non-JPG/PNG cover **with no GitHub call**; commits the JSON and the image
  in one commit; a traversing slug cannot escape; an update with no new image
  keeps the live cover; an update whose new image changes the extension deletes
  the old one in the same commit.
- `listDirectory()`: returns names on the branch, `[]` for a missing directory,
  and raises `auth` on a rejected credential like its neighbours.
- `GET /api/manual-events`: refused without a token; lists events that have
  already passed as well as upcoming ones; a GitHub failure costs the list and
  not the page.
- `POST /api/remove-event`: refused without a token; refused for a slug with no
  file; deletes the JSON and a conventionally-named cover in one commit; leaves
  a partner-hosted or hand-set cover alone.
- An event written by the endpoint survives a round trip through
  `normalizeManualEvents()` and reaches `mergeEvents()` in the right order.

## Verification

Add a partner event through the page on the deployed site, with an uploaded
cover and an external RSVP URL. It appears on the Events page and on the chapter
page matching its city, the cover renders, and RSVP leaves the site. An event
whose end time has passed does not appear.

## Out of scope

- **Renaming an event in place.** The slug is the filename and is frozen once
  the event exists; renaming is remove-then-add. See **Editing and removing**.
- **Recurring events.** A series is added as separate events; the id-collision
  fallback already handles two entries sharing a name.
- **Any change to the Luma sync.** This merges alongside it and touches none of
  it.
- **An undo for removal.** A removed event is a deleted file; recovering one is
  a developer with the git history, which is why the page asks the author to
  type the address first.

## Risks

- **`includeFiles` is the quiet one.** If `vercel.json` is not updated to the
  directory glob, the endpoint ships without any events and silently falls back
  to Luma-only. The verification step above is what catches it, and it has to be
  done on a deployment rather than locally.
- **Timezones.** The existing normalizer defaults to `America/New_York`, which is
  right for most of these and wrong for a Chicago or SF partner event. The form
  must send an explicit offset rather than leaning on that default.
- **Two authors editing one event.** `commitWithRetry` is safe for two authors
  writing two paths; editing reintroduces two authors writing *one* path, and
  the retry replays the second author's content over the first's. The window
  is seconds and the blast radius is one event rather than the whole array, so
  this is accepted rather than solved — but it is the one place the
  per-file design does not protect us, and it should not be forgotten.
- **Removal is irreversible from the page.** Typing the address is the only
  thing between a mis-click and a deleted event. That is the same bar
  `api/unpublish.js` set, so it is consistent rather than lax — but it is a
  real floor, not a safety net.
