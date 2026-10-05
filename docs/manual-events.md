# Adding an event that isn't in Luma

Every event on the site normally comes from the Luma calendar. An event that
was never created there — a partner's event, a conference panel, a chapter
meetup organised somewhere else — is added at `/admin/events/` by any signed-in
author. That page writes the file described below; nothing here has to be
edited by hand.

Manual events are merged into the Luma list by `api/events.js`, on the server.
That matters for two reasons:

- The three chapter pages (`new-york.html`, `san-francisco.html`,
  `chicago.html`) already ask `/api/events` for their own city, so a manual
  event with the right `city` appears there without anything else being
  changed.
- If Luma is down, or its key is not configured, the manual events still
  render. Merging them in the browser would have hidden them exactly when
  they matter most.

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

### Required

| Field | Notes |
|---|---|
| `name` | The event title, as it should read on the card. |
| `startAt` | When it starts, as an ISO 8601 timestamp. Include the offset (`-04:00`) or a `Z` — without one it is read as UTC, which is four or five hours off. |
| `url` | Where "RSVP" goes. Must be `https://`. Any host is fine. |

An entry missing any of these is skipped, with a warning in the function logs
naming it. The rest of the calendar still renders.

### Optional

| Field | Default | Notes |
|---|---|---|
| `endAt` | `null` | When it finishes. Also decides when the event drops off the site — see below. Same format as `startAt`; an unreadable one is refused rather than ignored. |
| `city` | `"other"` | One of `nyc`, `sf`, `chi`, `other`. This is the filter chip key, not free text: anything else becomes `other`, which shows under "All cities" only. |
| `place` | `""` | Free text, e.g. `"Soho, NYC"`. An online event with no `place` reads "Online". |
| `coverUrl` | `null` | An `https://` image. See sizing below. Without one the card uses its gradient. |
| `coverPath` | `null` | A cover this site serves, as `images/<name>.jpg` or `.png`. Set by `/admin/events/` when an author uploads one. Wins over `coverUrl` if both are set. |
| `locationType` | `"offline"` | `offline` or `zoom`. |
| `membersOnly` | `false` | Shows the members-only badge. |
| `tags` | `[]` | Up to three short labels. Anything past the third is dropped. |
| `timezone` | `"America/New_York"` | |
| `slug` | from `name` | Sets the entry's internal id, which nothing currently displays. Worth setting only when two events share a name. |

### When an event disappears

Luma is asked only for events after the current moment, so its past events
never reach the site. Nothing does that for a file, so an entry retires
itself: once `endAt` has passed — or `startAt`, if there is no `endAt` — it
stops being served. An event that started this morning and ends tonight is
still shown all day.

Old entries can be deleted from the file at any time, but nothing breaks if
they are left there.

## Cover images

**1600 × 1000 px, 16:10, JPG, under about 400 KB.**

Covers are drawn as a CSS background at a fixed 16:10 aspect ratio, scaled to
fill and cropped from the centre. The largest place a cover is ever shown is
the two-up grid on a chapter page, which is about 577 × 361 — so 1600 × 1000
covers every placement on a 2× display with room to spare.

| Where | Rendered | On a 2× screen |
|---|---|---|
| Events page, three across | ~377 × 236 | ~755 × 472 |
| Chapter page, two across | ~577 × 361 | ~1154 × 721 |
| Narrow screens, one across | up to 600 × 375 | up to 1200 × 750 |

Two things to watch:

- **Any other aspect ratio is accepted, and will be cropped to 16:10 from the
  centre.** A tall poster loses its top and bottom. Keep faces, logos and text
  away from the edges.
- **A dark gradient sits over the top of the image**, fading out around
  halfway down, so the date chip in the top-left stays readable. Avoid putting
  anything light or important in the upper-left corner.

A cover uploaded at `/admin/events/` is committed to `src/images/` and
referenced with `coverPath`. A partner who supplies an image URL can be
pointed at directly with `coverUrl` instead, which must be `https`.
