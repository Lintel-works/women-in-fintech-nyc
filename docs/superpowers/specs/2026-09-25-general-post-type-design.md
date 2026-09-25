# Phase 6 — the general post type: Jobs & Happenings

*Design approved 2026-09-25.*

## Why

Phase 5 made posts data and gave the file format a `type` field, but nothing
reads it yet. `src/posts/posts.11tydata.js` hard-codes the FFF layout, the FFF
nav highlight and the `fff-<slug>.html` permalink, so a file written today with
`type: post` would publish at an FFF URL wearing FFF chrome — an interviewee
hero with no interviewee in it.

Authors publish more than interviews. The second type is **community news and
happenings**: event recaps, announcements, member, job and partner news. Short,
frequent, timely. It needs a layout, a URL, a listing page and a way in from
the nav.

## Operating assumption

Unchanged from Phase 5, and it still outranks convenience wherever they
conflict: **after handoff there is no developer.** A malformed post must not
break the build, validation belongs in the editor where the author sees it, and
every error message is read by someone with no terminal and no repository.

Three consequences specific to this phase:

- A news post with no title must be refused in the editor, not defaulted. The
  FFF title fallback ("FinTech Female Fridays: Meet {name}") is meaningless
  here, and a page with an empty `<h1>` is worse than a form that won't submit.
- `happenings.html` ships with nothing to list. The empty state is the first
  thing an author sees, so it is designed, not a consequence of an empty loop.
- An unrecognised `type` fails the build naming the file and the valid types,
  rather than silently dropping the post.

## What success looks like

An author picks "Jobs & Happenings" in the editor, writes a news post, and it
publishes at `post-<slug>.html` and appears on `happenings.html`, reachable from
the nav. The seven FFF pages, `fintech-female-fridays.html` and `index.html` are
unchanged, byte for byte.

## Decisions taken

| Question | Decision |
|---|---|
| What `type: post` carries | Community news and happenings — recaps, announcements, member, job and partner news |
| Section name | Jobs & Happenings |
| Listing page | `happenings.html` |
| Post URL pattern | `post-<slug>.html`, matching the flat `fff-<slug>.html` convention |
| Listing scope | Only `type: post`. `fintech-female-fridays.html` stays the sole FFF listing |
| Nav placement | Fourth child of **Our Programs**, in `primary` and `mobile`, plus one footer link |
| Homepage | No presence this phase |
| Featured card | None. A grid only |
| First post | Ship the empty state; the first author publish fills the page |

Two of these were taken against a stated objection and are recorded so the
reasoning is not relitigated later:

- **Jobs & Happenings under "Our Programs."** It is not a program. It was
  chosen over a seventh top-level link because the nav already wraps at six
  items on mid-size screens, and the dropdown reads acceptably as what the
  organisation runs and publishes.
- **The name itself.** It carries over from the old Wix site, where FFF posts
  lived at `/jobs-and-happenings/categories/fintech-female-fridays`. The
  community knows the name. On Wix, FFF was a *category inside* Jobs &
  Happenings; here the two are independent sections, which is a deliberate
  divergence from the old structure in favour of each page having one job.

## Architecture

### `lib/post-types.mjs` — the type registry

One new module holding the per-type facts the build needs, and nothing else:

```js
export const POST_TYPES = {
  fff: {
    label: 'Fintech Female Fridays',
    prefix: 'fff-',
    layout: 'post.njk',
    listing: 'fintech-female-fridays.html',
    cardBadge: 'FFF',
    titleFallback: (post) => 'FinTech Female Fridays: Meet ' + (post.name || '')
  },
  post: {
    label: 'Jobs & Happenings',
    prefix: 'post-',
    layout: 'happenings-post.njk',
    listing: 'happenings.html',
    cardBadge: 'News',
    titleFallback: null
  }
};
```

It lives in `lib/` for the same reason `post-file.mjs` does: the build imports
it from Node and the editor imports it over HTTP from the passthrough copy, so
the two sides cannot disagree about what a type is.

**The boundary with `src/admin/types.js`:** the registry owns type *identity* —
label, URLs, layout, card badge, title fallback. `src/admin/types.js` keeps the
form field lists, because those are UI and the build has no use for them. The
editor imports `POST_TYPES` for the label and the cover path rather than
restating them.

`type` defaults to `'fff'` when absent, so the seven existing post files need
no edit and the `fff` collection filter in `eleventy.config.js` keeps working
as written.

### What the registry replaces

**`src/posts/posts.11tydata.js`** stops hard-coding three things. `layout`,
`active` and `permalink` become computed from the post's type:

- `layout` — `POST_TYPES[type].layout`
- `active` — `POST_TYPES[type].listing`, so a news post keeps
  `happenings.html` highlighted in the nav exactly as an FFF post keeps
  `fintech-female-fridays.html`
- `permalink` — `POST_TYPES[type].prefix + slug + '.html'`

`layout` and `active` are static front-matter keys today, not computed ones.
They move into `eleventyComputed` alongside `permalink`, because the type is
only known per file.

**`lib/render-blocks.mjs`** takes the prefix from the registry in the two
places it is currently a literal:

```js
export function coverPath(post) {
  return post.coverPath || ('images/' + prefixFor(post) + (post.slug || 'post') + '.jpg');
}

export function postFilename(post) {
  return prefixFor(post) + (post.slug || 'post') + '.html';
}
```

For `type: 'fff'` both return exactly what they return today, which is what
keeps the seven post pages byte-identical.

**The title fallback** becomes a registry property. `buildPostView` and
`buildCardView` both resolve it the same way they resolve it now — the two must
agree, or a titleless post publishes with a filled `<h1>` and an empty card
`<h2>`, which is the bug Phase 5's comment on `buildCardView` warns about. For
`type: post`, `titleFallback` is `null` and a blank title is an error, not a
default.

**`lib/render-blocks.mjs`'s tag fallback** (`post.tag || 'Fintech Female
Fridays'`) is FFF-specific for the same reason. It becomes a registry value:
`'Fintech Female Fridays'` for `fff`, `'Jobs & Happenings'` for `post`.

### Collections

`eleventy.config.js` gains a `happenings` collection beside `fff` — same glob,
same explicit `isoDate` descending sort, filtered on `type === 'post'`. The
existing comment on `addCollection('fff', …)` already explains why membership
is filtered here rather than through `tags`, and why the sort is explicit; that
reasoning applies unchanged to the second collection.

Both filters should read from one place rather than repeating the string
literals, so a third type cannot be added to the registry and silently join no
collection.

### The duplicate-slug guard, corrected

The Phase 5 guard keys its registry on `slug` alone:

```js
const seen = (globalThis.__postSlugs ||= new Map());
```

With one type that is the same thing as keying on the output path. With two it
is not: an FFF interview and a news post that happen to share the slug
`jane-doe` write `fff-jane-doe.html` and `post-jane-doe.html`, which do not
collide — but the guard would fail the build and tell an author about a
collision that does not exist.

**The guard is re-keyed on the resolved permalink.** Two posts of the same type
sharing a slug still fail the build, which is the case that actually loses a
file. The per-build reset in the `eleventy.before` handler is unchanged.

### Unknown types

A post file whose `type` is not in the registry fails the build with a message
naming the file and listing the valid types. Only the editor writes these files
and it writes a registry type, so this should be unreachable — but a silent
drop is the failure mode the Operating assumption forbids, and an unpublishable
post is not something the build can paper over.

### Layouts

`src/_includes/post.njk` is **left untouched.** That is what guarantees the
seven FFF pages stay byte-identical, and it is cheaper than proving a
conditional produced the same bytes.

The news layout is a second file, `src/_includes/happenings-post.njk`. Only two
regions genuinely differ:

| Region | `post.njk` | `happenings-post.njk` |
|---|---|---|
| Hero | Interviewee identity card: headshot, name, role · company, LinkedIn link | Title, then `author · date · read time` |
| Foot | "← All Fintech Female Fridays" and "Connect with {first} →" | "← All Jobs & Happenings" |

Everything else is the same, and duplicating it is how the nav reached twelve
copies. The shared parts are extracted into partials included by both layouts:

- `post-head.njk` — title, description, canonical, OG and Twitter tags,
  the `post-article.css` include, the JSON-LD block
- `post-body.njk` — the cover figure, the lede, `blocksHtml`

`buildPostView` stays the one view builder. Its person fields already resolve
to `''` or `false` when absent (`roleLineText`, `hasLinkedin`,
`firstNameText`), so a news post prints nothing for them without a second code
path. The JSON-LD `author` fallback ("NYC Fintech Women") is already correct
for a news post.

### Cards

`src/_includes/post-card.njk`'s `grid()` macro prints a hard-coded `FFF`
badge:

```njk
<span class="num">FFF</span>
```

That becomes `{{ card.badgeText | safe }}`, sourced from the registry's
`cardBadge` through `buildCardView`. For `fff` the string is identical, so the
FFF listing page output does not change.

**The card's tag line** needs stating, because it does not resolve for a news
post today. `buildCardView` builds it from `post.cardTag`, falling back to
`role · company` — both interviewee fields. A news post would therefore render
no chip at all. The fallback chain gains a third step: `cardTag`, then
`role · company`, then `post.tag`. For the seven FFF posts nothing changes,
because all of them resolve at one of the first two steps.

`happenings.html` uses `grid(card)` only. No `featured()` and no starred card:
news is short and frequent, and a rotating hero card earns nothing on a page
whose value is the list.

### Card CSS

`.feature`, `.blog-grid`, `.post`, `.post-img`, `.post-body`, `.post-foot` and
the `g1`–`g7` gradient classes live in a 40-line inline `<style>` on
`fintech-female-fridays.html`. `happenings.html` needs the same rules.

They move to `src/_includes/post-cards.css`, included by both pages — the
pattern `post-article.css` already established. The `.feature` rules travel
with them even though `happenings.html` does not use them, because splitting
the block invites the two halves to drift; unused CSS on one page is the
cheaper problem.

This is the one change in this phase that touches an existing page's output.
`npm run verify` canonicalizes whitespace, so a reflowed `<style>` block is
invisible to it, but the rules themselves must be identical and in the same
order — `.g1` through `.g7` are defined after the `.post-img` rules that
reference them, and the duotone overlay rules at the end depend on that
ordering.

### The listing page

`src/happenings.html`, front matter `active: "happenings.html"`, following the
structure of `fintech-female-fridays.html`:

- Page hero: kicker "Jobs & Happenings", a headline and one paragraph of
  standing copy
- The grid, looping `collections.happenings`, newest first
- No "See all" footer link — there is no other archive to point at, unlike the
  FFF page's link to the Wix category, which dies at cutover anyway

**Empty state.** With no `type: post` files the grid has nothing to loop. The
page prints one line instead — "Nothing here yet — check back soon." — rather
than an empty grid with a visible gap. This is the state the page ships in and
the state an author sees before their first publish, so it is verified as a
deliberate output, not discovered later.

### Nav and footer

`src/_data/nav.json` only. One entry appended to the Our Programs children in
`primary`, the same entry appended to the Our Programs children in `mobile`,
and one link in the footer's Events column beside "Fintech Female Fridays":

```json
{ "label": "Jobs & Happenings", "href": "happenings.html" }
```

The `isCurrent` filter already highlights a dropdown parent when any child
matches, so a news post — whose `active` is `happenings.html` — highlights Our
Programs with no filter change.

### The editor

`src/admin/types.js` gains a `post` entry in `TYPES`:

| Field | Required | Note |
|---|---|---|
| `title` | yes | No fallback for this type. Drives the slug |
| `slug` | yes | Auto-filled from `title`, not `name`. Downloads as `<slug>.html`; the build adds the `post-` prefix |
| `tag` | | The chip above the headline and on the card. Blank = "Jobs & Happenings" |
| `author` | | Byline |
| `date` | | Display string, as typed |
| `isoDate` | | Sort and SEO |
| `readTime` | | |
| `gradient` | | `g1`–`g7`, the card wash |
| `intro` | yes | Also the default source for the excerpt and meta description |
| `excerpt` | | Blank = first ~240 characters of the intro |
| `metaDescription` | | Blank = first ~155 characters of the intro |
| `ogTitle` | | Blank = the post title |
| `ogImage` | | Blank = the cover image |

Dropped from the FFF field list: `name`, `role`, `company`, `linkedin`. Those
describe an interviewee.

Two behaviours in `src/admin/main.js` are currently FFF-shaped and become
type-aware:

- **Slug auto-fill** follows `name` today. For `type: post` it follows
  `title`. It still stops following once edited by hand.
- **The renamed cover image** downloads as `images/fff-<slug>.jpg`. The prefix
  comes from `POST_TYPES`, so a news post's cover is
  `images/post-<slug>.jpg`.

The block types are unchanged — a news post uses the same `paragraph`,
`heading`, `quote`, `image`, `list` and `qa` set, and there is no reason to
withhold `qa` from a recap that quotes a speaker.

## Error handling

| Case | Behaviour |
|---|---|
| Blank title on a news post | Refused in the editor before download. No build-time default |
| Unknown `type` in a file | Build fails, naming the file and the valid types |
| Two posts of one type sharing a slug | Build fails, naming both files. This is the case that loses a file |
| Same slug across two types | Builds. Different output paths, no collision |
| No `type: post` files | `happenings.html` prints its empty state |
| Missing cover image file | Unchanged from Phase 5: a broken `<img>`, not a build failure |

## Testing

Added to `npm test` (`node --test tools/`):

| Test | What it pins |
|---|---|
| `postFilename` / `coverPath` per type | `fff` returns today's strings exactly; `post` returns the `post-` prefix |
| Title fallback per type | `fff` falls back to "Meet {name}"; `post` does not, and a blank title is reported rather than filled |
| Tag fallback per type | Registry-sourced, not the `'Fintech Female Fridays'` literal |
| `cardBadge` per type | `fff` still renders the string `FFF` |
| Permalink collision guard | Same slug across types passes; same slug within a type fails |
| Card tag line per type | `fff` resolves at `cardTag` or `role · company` for all seven; `post` resolves at `tag` |
| Unknown type | Throws, and the message names the type and the file |
| Registry completeness | Every type in `POST_TYPES` has form fields in `src/admin/types.js`, and vice versa — the guard against half-adding a type |
| Round trip, both types | `parsePost(serializePost(x))` deep-equals `x` for a `type: post` model as well as an `fff` one |

The existing seven-post tests and the escaping and link-integrity tests are
unchanged and must stay green.

## Verification

- `npm test` and `npm run build` pass.
- `npm run verify` reports no change to the seven post pages,
  `fintech-female-fridays.html` or `index.html`. The card-CSS extraction and
  the `badgeText` substitution must be invisible to it.
- `npm run verify:self-test` still detects a deliberate change, confirming the
  check above means something.
- `happenings.html` builds and renders its empty state with no post files
  present.
- A fixture `type: post` file is written through the editor, saved into
  `src/posts/`, and: publishes at `post-<slug>.html`, wears the news hero with
  no interviewee fields, appears on `happenings.html`, highlights Our Programs
  in the nav, and links back to `happenings.html` from its foot. The fixture is
  then removed, and the empty state returns.
- The nav, mobile drawer and footer show the new link on all pages, from the
  one edit to `nav.json`.

## Out of scope

- **Publishing.** Authentication and committing from the browser stay in Phase
  7. A news post still reaches the repository as a downloaded file.
- **Image resizing on upload.** Phase 7, with publishing.
- **The homepage.** No Jobs & Happenings section, strip or link this phase.
- **Categories within Jobs & Happenings.** The `tag` field exists and prints,
  but nothing filters or groups on it. Build it when there are enough posts to
  need it.
- **Pagination.** Same answer as the FFF grid: a problem for when the page is
  long.
- **A combined feed.** The two sections stay independent, contrary to the old
  Wix structure.
- **The signup page,** which remains its own piece of work and still needs a
  decision about where submissions go.

## Risks

- **The card CSS move is the only change to an existing page's bytes.** It is
  mechanical but order-sensitive: the gradient classes and the duotone overlay
  rules depend on being declared after the rules they modify. `npm run verify`
  catches a mistake here, which is why the move happens in its own commit
  rather than folded into the new page.
- **Two layouts can drift.** `post.njk` and `happenings-post.njk` share their
  head and body through partials, so the drift surface is the hero and the
  foot — regions that genuinely differ. If a third type appears and the
  partials start growing conditionals, that is the signal to reconsider, not to
  add a fourth file.
- **`cardBadge: 'News'`** is a guess at copy, not a structural decision. It is
  one registry string to change.
- **The type registry is a second place a type is declared,** next to
  `src/admin/types.js`'s form fields. The split is deliberate — identity in
  `lib/`, form in `admin/` — but a new type still needs both. The test that
  every registry type has form fields is the cheap guard against half-adding
  one.
