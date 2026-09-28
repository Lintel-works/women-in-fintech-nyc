# NYC Fintech Women

Static marketing website for NYC Fintech Women, a community for women building careers and companies in fintech.

## Pages

| Page | File |
|------|------|
| Home | `index.html` |
| Events | `events.html` |
| Fintech Female Fridays | `fintech-female-fridays.html` |
| Inspiring Fintech Females | `inspiring-fintech-females.html` |
| Co-Founder Matching | `co-founder-matching.html` |
| Meet the Team | `meet-the-team.html` |
| FFF post pages | `fff-<slug>.html` (built from `src/posts/<slug>.html`) |
| Jobs & Happenings | `happenings.html` |
| Jobs & Happenings post pages | `post-<slug>.html` (built from `src/posts/<slug>.html`) |
| Post editor | `admin/index.html` |

## Tech stack

- Plain HTML and CSS, built with [Eleventy](https://www.11ty.dev/)
- Shared styles in `src/site.css`
- Mobile-first, responsive layout

## Local development

```bash
npm install
npm run dev      # builds and serves with live reload
```

Then visit [http://localhost:8080](http://localhost:8080).

`npm run build` writes the site to `_site/`, which is what Vercel deploys.
`_site/` is generated — never edit it, and never commit it.

### Verifying a change didn't break anything

```bash
npm test                   # post-file round trip, the seven committed posts,
                           # and the renderer's escaping and links
npm run verify             # compare the build against the pre-eleventy baseline
npm run verify:self-test   # confirm the check can still detect a change
```

`npm run verify` canonicalizes HTML before comparing. It checks only the pages
that existed at the `pre-eleventy` git tag — pages added since, including
`happenings.html` and every `post-<slug>.html`, are not enumerated at all. Its
per-page comparison is against that same tag, a baseline the site has long
since diverged from, so a "changed" line is expected on every page and is not
by itself evidence of a regression — it only proves the page still built.

Because every page now differs from the baseline, **`npm run verify` always
exits non-zero.** A red exit is the expected result, not a regression signal.
To compare a change against something meaningful, build the tree before and
after, then compare the two `_site/` trees file by file — passing each through
the `canonicalize` export of `tools/htmlcanon.mjs` first, so template reflow is
ignored and a real content change is not. That module has no CLI; it is
imported.

## Project structure

```
.
├── src/                 # everything the site is built from
│   ├── _data/           # site content — edit these, not the markup
│   │   ├── site.json    # the member count, written once
│   │   ├── nav.json     # nav, mobile drawer and footer links
│   │   ├── team.json    # the 17 team members
│   │   └── home.json    # homepage hero, stats and why-join cards
│   ├── _includes/       # shared chrome, rendered into every page
│   │   ├── nav.njk
│   │   ├── mobile-drawer.njk
│   │   └── footer.njk
│   ├── index.html
│   ├── events.html
│   ├── fintech-female-fridays.html
│   ├── inspiring-fintech-females.html
│   ├── co-founder-matching.html
│   ├── meet-the-team.html
│   ├── posts/           # every post, one file each, any type: front matter
│   │                    # only, rendered to /<type prefix><slug>.html
│   ├── site.css
│   ├── nav-mobile.js
│   ├── robots.txt
│   ├── images/
│   └── admin/           # Post editor (not linked from the site)
├── api/                 # Vercel Functions — must stay at the repo root,
│   └── events.js        # NOT in src/, or Vercel won't detect them
├── lib/                 # Shared by the build and the editor; served at /lib/
│   ├── render-blocks.mjs   # Turns a post's blocks into HTML
│   └── post-file.mjs       # Reads and writes the src/posts/ file format
├── tools/               # Dev-only (not deployed)
│   ├── htmlcanon.mjs
│   ├── snapshot.mjs
│   ├── import-wix-post.mjs # One-shot: Wix archive -> src/posts/
│   ├── post-file.test.mjs
│   └── render-blocks.test.mjs
├── eleventy.config.js
├── _site/               # Build output — generated, gitignored
└── design/              # Reference PDFs from the design process
```

### Editing content

Most of what changes over time now lives in `src/_data/` as JSON, not markup:

| Change | File |
|---|---|
| Member count (appears on all 11 pages) | `site.json` |
| Where "Become a Member" points (50 links) | `site.json` |
| Team members, roles, LinkedIn links | `team.json` |
| Homepage hero copy, stats, why-join cards | `home.json` |
| Nav, drawer and footer links | `nav.json` |

Edit the JSON, run `npm run build`, done. The member count in particular is
written **once**: it feeds the hero, the animated counter, the partner stats,
the brand guide and every page's footer.

Two conventions worth knowing:

- `{memberCount}` inside a string is replaced with the current count, so
  taglines never restate the number.
- A link `href` of `{membershipUrl}` resolves to `site.membershipUrl`. JSON
  cannot interpolate, so data files reference site values by token.

> **Membership signup still lives on the old Wix site.** All 50 "Become a
> Member" links point there via `site.membershipUrl`. When the rebuild takes
> over the domain that URL dies, so a signup page has to exist here first —
> then change the one value in `site.json`. The Wix form is Wix-native, so its
> 18 fields and its submissions do not come across on their own.
- Fields rendered with `| safe` may contain HTML — the hero headline uses
  `<em>` and `<span class="underline">`. Everything else is escaped.

### Editing the navigation

The nav, mobile drawer and footer used to exist as 12 copy-pasted blocks. They
now live in [`src/_data/nav.json`](src/_data/nav.json) and render through
`src/_includes/`. **Change the nav in one place.**

Each page declares its own state in front matter:

```yaml
---
active: "chicago.html"    # which link is highlighted; omit for pages not in the nav
logo: "chi"               # nyc (default) | chi | sfo
selfPage: "events.html"   # links to this page become #anchors instead of reloads
---
```

`active` drives everything: the highlighted top-level link, its dropdown parent,
and which mobile drawer group starts open.

### Posts

Posts live in `src/posts/` as data, one file each. A post file is front matter
and nothing else: the metadata, an `intro`, and a `blocks` list of `paragraph`,
`heading`, `qa`, `quote`, `list` and `image` entries that
`lib/render-blocks.mjs` turns into the page.

Each file carries a `type`, and that one field decides everything about where
it publishes:

| `type` | Section | Publishes at | Lists on |
|---|---|---|---|
| `fff` | Fintech Female Fridays interview | `fff-<slug>.html` | `fintech-female-fridays.html` |
| `post` | Jobs & Happenings — recaps, announcements, news | `post-<slug>.html` | `happenings.html` |

A missing `type` means `fff`. The per-type facts live in one place,
[`lib/post-types.mjs`](lib/post-types.mjs) — URL prefix, listing page, card
badge, and the hero and foot partials `post.njk` includes. Adding a type takes
more than an entry there:

- an entry in `lib/post-types.mjs` — prefix, listing, collection, hero, foot,
  card badge, tag fallback, slug source
- a field list for the editor in `src/admin/types.js`
- `src/_includes/<hero>.njk` and `<foot>.njk` — missing, the build fails
  loudly and names the file
- a listing page, `src/<listing>.html` — missing, the build **succeeds** and
  publishes posts at a URL nothing links to, silently
- an entry in `src/_data/nav.json` so the listing page is reachable
- updates to the two hardcoded type lists in `tools/post-types.test.mjs`

`layout` is **not** one of those facts, and cannot be: Eleventy resolves a
template's layout before computed data runs, so every post type renders through
`src/_includes/post.njk` and varies only by the partials it includes.

Text in a block is the author's plain source, not HTML. Three inline markers
are understood — `**bold**`, `*italic*` and `[text](url)` — and the renderer
applies smart quotes and dashes on the way out. That pass is one-way, so never
paste rendered text back into a post file.

The six posts that used to live on Wix were imported from the HTML archive by
`tools/import-wix-post.mjs`, which is committed so the import can be rerun and
reviewed rather than taken on trust. It needs the archive at
`~/Desktop/Projects/wix-archive-nycfintechwomen/` and, for resizing the images
it pulls out, macOS `sips`:

```bash
node tools/import-wix-post.mjs --all            # rewrite every post file
node tools/import-wix-post.mjs --post mor-grisariu --dry-run
```

It overwrites `src/posts/`, so hand-edits to a post are lost on a rerun. Once
Wix is gone the tool has nothing to read and can go.

### Team member gradients

Each member in `team.json` carries an explicit `gradient` (`g1`–`g7`). Do not
compute it from position: the founders run `g1`–`g5` but the committee runs
`g6,g7,g1,g2,…`, so deriving it would silently restyle the page.

## Luma events integration

The **Upcoming** section of `events.html` is populated from a Luma calendar.

The Luma API key is scoped to an entire calendar and grants **full access** to
it — creating and cancelling events, reading guest lists. It can never be sent
to the browser, so `api/events.js` (a Vercel Function) is the only thing that
holds it. The browser calls `/api/events`, which returns a narrow allowlist of
public display fields.

### Setup

1. Get a key at `luma.com/calendar/manage/api-keys` (Settings → Developer).
   Requires a **Luma Plus** subscription on that calendar.
2. Local: `cp .env.example .env` and paste the key into `.env`. It is
   gitignored — never commit it.
3. Production: add `LUMA_API_KEY` in the Vercel dashboard under
   Settings → Environment Variables, then redeploy.

### Local development

`npm run dev` serves static files only and cannot run `/api`, so the events
section will show its fallback. To run the function locally use `vercel dev`
(Vercel CLI), which reads `.env` automatically.

### Behaviour

- Events are fetched at page load, sorted soonest-first, capped at 24.
- Private events are excluded; members-only events are shown and labelled.
- `geo_address_json.city` maps onto the New York / San Francisco / Chicago
  filter chips. Anything else appears only under "All cities".
- Responses are CDN-cached for 5 minutes (`s-maxage=300`) so traffic never
  approaches Luma's rate limit of 200 requests/minute per calendar.
- **If Luma is unreachable, unconfigured, or empty, the hardcoded events in
  `events.html` stay on the page.** That fallback is deliberate — edit those
  cards if you want a different safety net. Check the browser console for a
  `[events]` warning explaining which case was hit.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `LUMA_API_KEY` | `api/events.js` | Reads the Luma calendar for the events section. See [Luma events integration](#luma-events-integration). |
| `AUTH_SECRET` | `api/login.js`, `api/publish.js`, `api/unpublish.js` | Signs the editor's session cookie. Rotating it signs every author out. |
| `AUTH_USERS` | `api/login.js` | JSON map of author email → scrypt hash, produced by `node tools/hash-password.mjs`. |
| `GITHUB_TOKEN` | `api/publish.js`, `api/unpublish.js` | A GitHub App installation token with Contents: Read and write, used to commit published posts. |
| `GITHUB_OWNER` | `api/publish.js`, `api/unpublish.js` | The repository owner the editor commits to. |
| `GITHUB_REPO` | `api/publish.js`, `api/unpublish.js` | The repository name the editor commits to. |
| `GITHUB_BRANCH` | `api/publish.js`, `api/unpublish.js` | Optional; defaults to `main`. |

`.env.example` documents `LUMA_API_KEY`, `AUTH_SECRET` and `AUTH_USERS` for
local development. The `GITHUB_*` variables are Production-only in this
project's Vercel settings — publishing to a real repository from a local
`vercel dev` session isn't part of the intended workflow, so they aren't in
`.env.example`. Full setup for the publishing variables, including why a
GitHub App and not a personal access token, is in
[`docs/publishing-setup.md`](docs/publishing-setup.md).

## Post editor

`admin/index.html` is a client-side authoring tool for both post types —
Fintech Female Fridays interviews and Jobs & Happenings posts. There is no
backend and no database: it opens a post file from `src/posts/` and gives you
one back.

> **It has to be served.** The editor imports the same ES modules the build
> renders with (`/lib/render-blocks.mjs`, `/lib/post-file.mjs`), so opening
> `src/admin/index.html` from disk no longer works — every import fails and the
> page tells you so. Run `npm run dev` and open
> [http://localhost:8080/admin/](http://localhost:8080/admin/) with the trailing
> slash, or use the deployed `/admin`.

To edit an existing post:

1. **Pick the type** at the top of the form. It decides which fields you get
   and where the post publishes. Opening a post of the other type tells you to
   switch first, rather than loading it with fields missing.
2. **Open post** → pick the file from `src/posts/`. The form and the preview
   fill in; a file it cannot read is refused with the line to fix, rather than
   half-loaded.
3. Edit, watching the live preview. The preview is the article body only — the
   hero, nav and footer come from the build.
4. **Publish** → sign in (see below), then click **Publish**. The editor
   commits the post file — and its cover image, if it has one — straight to
   `main` in one commit, and the response gives back the live URL. No git
   checkout is needed for this. Publishing again with the same post open
   updates that same file instead of creating a new one.

A new post is the same minus step 1. Publishing a new post commits both the
post file and its cover image together the first time.

**Download post file** and **Download renamed image** are still there as a
fallback for anyone without a publish account, or when signing in isn't an
option: download both, save the post into `src/posts/` and the image into
`src/images/` under the path the form shows, then `npm run build` and check
the post, the listing page and the homepage.

### Signing in and publishing

Publishing and unpublishing need an author account — there is no self-service
sign-up. **Sign in to publish**, at the top of the editor, takes an email and
password; a successful sign-in shows "Signed in as `<email>`." Without signing
in, the editor still works fully for writing, previewing and downloading — only
the Publish and Unpublish buttons are disabled.

**Unpublish** removes a live post (and its cover image, if the post's own
`coverPath` still matches the convention the editor writes) in one commit. It
only unlocks for a post this session has actually opened or just published —
never for whatever the form's fields currently say — and requires typing the
post's slug to confirm, since it's destructive and there's no undo short of a
manual `git revert`.

Setting up the GitHub App and the first author account is a one-time,
human-only setup step — see [`docs/publishing-setup.md`](docs/publishing-setup.md).

**Nothing gets pasted.** The cards on `fintech-female-fridays.html` and the
homepage are generated from the post data, so adding a post to `src/posts/` is
all it takes to put it on both pages.

Drafts autosave to `localStorage`, so a reload won't lose work — but the image
file itself must be re-selected (only its path is stored). Use **Export JSON** to
move a draft between machines.

### Maintenance

The editor has no copy of anything. It imports `lib/render-blocks.mjs` for the
preview and `lib/post-file.mjs` for the file format, so a change to either is
picked up by the editor and the build at once — and the site nav, drawer and
footer live only in `src/_includes/`.

`admin/` is deployed but unlinked. `robots.txt` keeps it out of search
results; it does not make it private — anyone with the URL can open it, write,
preview and download. Publishing and unpublishing are the only actions behind
a password (see "Signing in and publishing" above); reaching the editor itself
still needs no credential.

**Known issue:** publishing a PNG cover image with "keep original" checked
produces a broken cover — the post records a `.png` path but the server always
writes the uploaded image as `.jpg`. See
[`docs/publishing-setup.md`](docs/publishing-setup.md#known-issues) for
detail and the workaround.

## Design

The site follows the v6 "Refresh" brand direction: pink-magenta and deep plum palette, Fraunces display type, and soft radial background washes. Design reference files live in `design/`.
