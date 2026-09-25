# General Post Type (Jobs & Happenings) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second post type — community news and happenings — that publishes at `post-<slug>.html`, lists on a new `happenings.html`, and is reachable from the nav, without changing a single byte of the seven published FFF pages.

**Architecture:** One new module, `lib/post-types.mjs`, owns the per-type facts (URL prefix, listing page, hero and foot partials, card badge, title and tag fallbacks). Everything that currently hard-codes `fff-` or an interview-shaped fallback reads that registry instead. `src/_includes/post.njk` stays the only post layout — Eleventy cannot compute a `layout` — and the two regions that genuinely differ by type become partials it includes by variable.

**Tech Stack:** Eleventy 3.1.6 (ESM config, `type: module`), Nunjucks templates, plain ES modules in `lib/` and `src/admin/`, `node --test` for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-25-general-post-type-design.md`

## Global Constraints

- **No new dependencies.** `npm test` is `node --test tools/*.test.mjs`; nothing is added to `package.json`.
- **The seven FFF post pages, `fintech-female-fridays.html` and `index.html` must not change.** `npm run verify` compares against the `pre-eleventy` tag and is the gate. It has a **known, pre-existing divergence** — capture its output before Task 1 and compare against that, not against a clean run.
- **ES modules, 2-space indent, `async`/`await`, descriptive names.** Comments explain WHY only, never restate WHAT.
- **`layout` cannot come from `eleventyComputed`.** Eleventy resolves the layout before computed data runs; `permalink` is the one documented exception (`/11ty/docs`, `docs/data-computed.md`). `layout: 'post.njk'` stays a static key.
- **Exact copy strings:** type labels are `Fintech Female Fridays` and `Jobs & Happenings`. Card badges are `FFF` and `News`. Tag fallbacks are `Fintech Female Fridays` and `Jobs & Happenings`. The nav/footer label is `Jobs & Happenings`, href `happenings.html`.
- **Error messages are read by an author with no terminal and no repository.** No line numbers, no type names from the codebase, no jargon.
- **Never `git add -A`.** Stage the named files. Commit messages follow the repo's style: imperative sentence, no Conventional Commits prefix, no attribution trailers.

## Review Focus

Five things the spec implies, that no task's happy-path test would catch, each with the test that pins it named in the owning task:

1. **A card's `<img alt>` is empty on a news post.** `buildCardView` sets `nameAttr` from `post.name`, which a news post does not have, so a screen reader would get nothing. Alt text falls back to the title. → Task 2.
2. **A post file whose `type:` line is blank or missing must publish as FFF, not throw.** The seven migrated posts predate the field and a hand-edit can drop it. → Task 1.
3. **A news post with no `isoDate` must not throw and must sort deterministically (last).** `isoDate` is optional in the editor. → Task 1.
4. **A news post whose `author`, `date` and `readTime` are all blank must not render a dangling `·` or an empty meta element.** All three are optional. → Tasks 2 and 7.
5. **Opening a `type: post` file while the editor is set to FFF must not silently drop the fields the FFF form has no input for.** The editor builds its model from the current type's field list. → Task 9 (manual browser verification; `src/admin/` has no test harness, by Phase 5's design).

---

### Task 1: The type registry

**Files:**
- Create: `lib/post-types.mjs`
- Test: `tools/post-types.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `POST_TYPES` (object keyed `fff`, `post`), `DEFAULT_TYPE` (string `'fff'`), `typeKeyOf(post) -> string`, `typeOf(post) -> typeObject` (throws on unknown), `postTitle(post) -> string`, `sortedPostsOfType(posts, key) -> array`. Each type object has `label`, `prefix`, `listing`, `collection`, `hero`, `foot`, `cardBadge`, `tagFallback`, `slugSource`, `titleFallback` (a function or `null`).

- [ ] **Step 1: Record the current `npm run verify` output**

Run: `npm run build && npm run verify | tail -5 > /tmp/verify-baseline.txt; cat /tmp/verify-baseline.txt`

This is the known pre-existing divergence. Every later verify step compares against these numbers, not against zero. Do not try to fix the divergence — it is out of scope.

- [ ] **Step 2: Write the failing test**

Create `tools/post-types.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POST_TYPES, DEFAULT_TYPE, typeKeyOf, typeOf, postTitle, sortedPostsOfType
} from '../lib/post-types.mjs';

test('the registry holds exactly the two types the site publishes', () => {
  assert.deepEqual(Object.keys(POST_TYPES).sort(), ['fff', 'post']);
  assert.equal(DEFAULT_TYPE, 'fff');
});

/* The seven posts migrated from Wix predate the type field. A file that loses
   the line by hand-edit must still publish, not fail the build. */
for (const value of [undefined, '', '   ', null]) {
  test(`a blank type (${JSON.stringify(value)}) is an fff post`, () => {
    assert.equal(typeKeyOf({ type: value }), 'fff');
    assert.equal(typeOf({ type: value }).prefix, 'fff-');
  });
}

test('typeKeyOf survives being handed nothing at all', () => {
  assert.equal(typeKeyOf(undefined), 'fff');
});

test('a news post resolves to the post type', () => {
  assert.equal(typeKeyOf({ type: 'post' }), 'post');
  assert.equal(typeOf({ type: 'post' }).prefix, 'post-');
  assert.equal(typeOf({ type: 'post' }).listing, 'happenings.html');
});

test('an unknown type names itself and the valid types', () => {
  assert.throws(() => typeOf({ type: 'newsletter' }), (err) => {
    assert.match(err.message, /newsletter/);
    assert.match(err.message, /fff/);
    assert.match(err.message, /post/);
    return true;
  });
});

test('an fff post with no title falls back to the interviewee', () => {
  assert.equal(postTitle({ type: 'fff', name: 'Shira Amrany' }),
    'FinTech Female Fridays: Meet Shira Amrany');
});

test('a news post with no title has no fallback', () => {
  assert.equal(postTitle({ type: 'post', name: 'Shira Amrany' }), '');
});

test('an explicit title wins for either type', () => {
  assert.equal(postTitle({ type: 'fff', title: 'A Title', name: 'X' }), 'A Title');
  assert.equal(postTitle({ type: 'post', title: 'A Title' }), 'A Title');
});

test('sortedPostsOfType filters by type and sorts newest first', () => {
  const posts = [
    { data: { type: 'post', isoDate: '2026-01-01', slug: 'old-news' } },
    { data: { type: 'fff', isoDate: '2026-09-01', slug: 'an-interview' } },
    { data: { type: 'post', isoDate: '2026-06-01', slug: 'new-news' } }
  ];
  assert.deepEqual(
    sortedPostsOfType(posts, 'post').map((p) => p.data.slug),
    ['new-news', 'old-news']
  );
  assert.deepEqual(
    sortedPostsOfType(posts, 'fff').map((p) => p.data.slug),
    ['an-interview']
  );
});

/* isoDate is optional in the editor. A post without one must not throw and
   must not land somewhere different on every build. */
test('a post with no isoDate sorts last rather than throwing', () => {
  const posts = [
    { data: { type: 'post', slug: 'undated' } },
    { data: { type: 'post', isoDate: '2026-06-01', slug: 'dated' } }
  ];
  assert.deepEqual(
    sortedPostsOfType(posts, 'post').map((p) => p.data.slug),
    ['dated', 'undated']
  );
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tools/post-types.test.mjs`
Expected: FAIL — `Cannot find module` for `../lib/post-types.mjs`.

- [ ] **Step 4: Write the implementation**

Create `lib/post-types.mjs`:

```js
/* The post types, and the per-type facts the build needs.
 *
 * Imported by the build from Node and by the editor over HTTP from the
 * passthrough copy of lib/, so the two sides cannot disagree about what a type
 * is. The form field lists stay in src/admin/types.js: those are UI, and the
 * build has no use for them.
 *
 * There is deliberately no `layout` here. Eleventy resolves a template's
 * layout before computed data runs, so eleventyComputed cannot set it --
 * permalink is the one documented exception. Both types render through
 * src/_includes/post.njk and differ only in the hero and foot partials it
 * includes.
 */

export const DEFAULT_TYPE = 'fff';

export const POST_TYPES = {
  fff: {
    label: 'Fintech Female Fridays',
    prefix: 'fff-',
    listing: 'fintech-female-fridays.html',
    collection: 'fff',
    hero: 'hero-fff.njk',
    foot: 'foot-fff.njk',
    cardBadge: 'FFF',
    tagFallback: 'Fintech Female Fridays',
    slugSource: 'name',
    titleFallback: (post) => 'FinTech Female Fridays: Meet ' + (post.name || '')
  },
  post: {
    label: 'Jobs & Happenings',
    prefix: 'post-',
    listing: 'happenings.html',
    collection: 'happenings',
    hero: 'hero-happenings.njk',
    foot: 'foot-happenings.njk',
    cardBadge: 'News',
    tagFallback: 'Jobs & Happenings',
    slugSource: 'title',
    titleFallback: null
  }
};

/* A blank or absent type is an FFF interview: the seven posts migrated from
   Wix were written before the field existed, and a file that loses the line to
   a hand-edit must still publish rather than fail a build nobody is watching. */
export function typeKeyOf(post) {
  return String((post && post.type) || '').trim() || DEFAULT_TYPE;
}

/* Throws rather than falling back. An unrecognised type has no URL, no listing
   page and no hero, so there is nothing sensible to publish it as -- and a
   silent drop is the failure mode the spec's operating assumption forbids. The
   message names what was found and what is allowed, because the person reading
   it is an author. */
export function typeOf(post) {
  const key = typeKeyOf(post);
  const type = POST_TYPES[key];
  if (!type) {
    throw new Error(
      `Unknown post type "${key}". A post's type must be one of: ` +
      Object.keys(POST_TYPES).join(', ') + '.'
    );
  }
  return type;
}

/* The title, resolved the one way the post page and its card must both resolve
   it -- they disagreed once already, which is why buildCardView carries a
   comment about it. An FFF interview with no title falls back to the
   interviewee's name; a news post has no such fallback and resolves to '', so
   the editor can refuse it before a file is ever written. */
export function postTitle(post) {
  const explicit = String((post && post.title) || '').trim();
  if (explicit) return explicit;
  const fallback = typeOf(post).titleFallback;
  return fallback ? fallback(post) : '';
}

/* Newest first. The comparator is the one eleventy.config.js has used for the
   fff collection since Phase 5, kept verbatim: no post sets Eleventy's
   reserved `date` key, so the ordering has to be explicit, and a different
   comparator risks silently reordering the seven published cards. A post with
   no isoDate sorts last. */
export function sortedPostsOfType(posts, key) {
  return posts
    .filter((item) => typeKeyOf(item.data) === key)
    .sort((a, b) => ((a.data.isoDate || '') < (b.data.isoDate || '') ? 1 : -1));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tools/post-types.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. Nothing imports the new module yet, so the existing 54 tests are untouched.

- [ ] **Step 7: Commit**

```bash
git add lib/post-types.mjs tools/post-types.test.mjs
git commit -m "Add the post type registry

One place that knows what a post type is: its URL prefix, its listing page,
its hero and foot partials, its card badge and its title and tag fallbacks.
Nothing reads it yet.

No layout key. Eleventy resolves a layout before computed data runs, so
eleventyComputed cannot set one -- both types render through post.njk and
vary by the partials it includes."
```

---

### Task 2: The renderer reads the registry

**Files:**
- Modify: `lib/render-blocks.mjs` — `coverPath`, `postFilename`, `buildPostView`, `buildCardView`
- Test: `tools/render-blocks.test.mjs` (append)

**Interfaces:**
- Consumes: `typeOf`, `postTitle` from `lib/post-types.mjs` (Task 1).
- Produces: `buildCardView(post)` gains `badgeText` (escaped string) and changes `nameAttr` to fall back to the title. `buildPostView(post)` gains `coverAltAttr`, `authorText` and `dateMetaText` (all escaped strings). `coverPath` and `postFilename` take their prefix from the registry.

- [ ] **Step 1: Write the failing tests**

Append to `tools/render-blocks.test.mjs`. Note the import line at the top of that file must also gain the new names — do that in this step:

```js
/* Replace the existing import at the top of the file with: */
import {
  renderInline, escText, escAttr, safeUrl, makeExcerpt,
  buildCardView, buildPostView, coverPath, postFilename
} from '../lib/render-blocks.mjs';
```

```js
/* --------------------------------------------------- type-aware file paths */

test('an fff post keeps the filename and cover path it has always had', () => {
  const post = { type: 'fff', slug: 'shira-amrany' };
  assert.equal(postFilename(post), 'fff-shira-amrany.html');
  assert.equal(coverPath(post), 'images/fff-shira-amrany.jpg');
});

test('a post with no type still gets the fff paths', () => {
  const post = { slug: 'shira-amrany' };
  assert.equal(postFilename(post), 'fff-shira-amrany.html');
  assert.equal(coverPath(post), 'images/fff-shira-amrany.jpg');
});

test('a news post gets the post- prefix', () => {
  const post = { type: 'post', slug: 'october-recap' };
  assert.equal(postFilename(post), 'post-october-recap.html');
  assert.equal(coverPath(post), 'images/post-october-recap.jpg');
});

test('an explicit coverPath still wins', () => {
  assert.equal(coverPath({ type: 'post', slug: 'x', coverPath: 'images/custom.jpg' }),
    'images/custom.jpg');
});

/* ------------------------------------------------------- type-aware fallbacks */

test('a news post tag chip falls back to the type, not to Fintech Female Fridays', () => {
  assert.equal(buildPostView({ type: 'post', title: 'A Recap' }).tagText,
    'Jobs &amp; Happenings');
  assert.equal(buildPostView({ type: 'fff', name: 'X' }).tagText,
    'Fintech Female Fridays');
});

test('the card badge comes from the type', () => {
  assert.equal(buildCardView({ type: 'fff', name: 'X' }).badgeText, 'FFF');
  assert.equal(buildCardView({ type: 'post', title: 'A Recap' }).badgeText, 'News');
});

/* The chip resolved only through cardTag and role · company, both interviewee
   fields, so a news post rendered no chip at all. */
test('a news post card chip falls back to its own tag', () => {
  assert.equal(buildCardView({ type: 'post', title: 'A Recap', tag: 'Event recap' }).tagHtml,
    'Event recap');
});

test('an fff card chip still resolves at role and company', () => {
  const card = buildCardView({
    type: 'fff', name: 'X', role: 'Data & Analytics Lead', company: 'Indagari', tag: 'Ignored'
  });
  assert.equal(card.tagHtml, 'Data &amp; Analytics Lead · Indagari');
});

test('cardTag still outranks everything', () => {
  const card = buildCardView({
    type: 'fff', name: 'X', role: 'R', company: 'C', cardTag: 'Hand-written', tag: 'Ignored'
  });
  assert.equal(card.tagHtml, 'Hand-written');
});

/* Review Focus 1: a news post has no `name`, so the card image had no alt
   text at all -- a screen reader got nothing. */
test('a news post card image is described by its title', () => {
  const card = buildCardView({ type: 'post', title: 'October Recap', slug: 'october-recap' });
  assert.equal(card.nameAttr, 'October Recap');
});

test('an fff card image is still described by the interviewee', () => {
  const card = buildCardView({ type: 'fff', name: 'Shira Amrany', title: 'Anything' });
  assert.equal(card.nameAttr, 'Shira Amrany');
});

test('a news post cover image is described by its title', () => {
  assert.equal(buildPostView({ type: 'post', title: 'October Recap' }).coverAltAttr,
    'October Recap');
});

/* Review Focus 4: author, date and read time are all optional. */
test('a news post with no byline fields renders no separators', () => {
  const view = buildPostView({ type: 'post', title: 'A Recap' });
  assert.equal(view.authorText, '');
  assert.equal(view.dateMetaText, '');
  assert.equal(view.metaLineText, '');
});

test('a news post byline joins only what is there', () => {
  const view = buildPostView({
    type: 'post', title: 'A Recap', author: 'Manvir Singh', readTime: '4 min'
  });
  assert.equal(view.authorText, 'Manvir Singh');
  assert.equal(view.dateMetaText, '4 min');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tools/render-blocks.test.mjs`
Expected: FAIL. `coverPath` and `postFilename` are already exported, so the failures are specific: `badgeText`, `coverAltAttr`, `authorText` and `dateMetaText` come back `undefined`; the news post's tag chip and card alt come back `''`; and the `post-` prefix assertions get `fff-`.

- [ ] **Step 3: Import the registry**

In `lib/render-blocks.mjs`, directly under the existing `const SITE_ORIGIN = …` line:

```js
import { typeOf, postTitle } from './post-types.mjs';
```

Move it above `const SITE_ORIGIN` so all imports sit at the top of the file, matching the rest of the codebase.

- [ ] **Step 4: Make the two path helpers type-aware**

Replace:

```js
export function coverPath(post) {
  return post.coverPath || ('images/fff-' + (post.slug || 'post') + '.jpg');
}

export function postFilename(post) {
  return 'fff-' + (post.slug || 'post') + '.html';
}
```

with:

```js
export function coverPath(post) {
  return post.coverPath || ('images/' + typeOf(post).prefix + (post.slug || 'post') + '.jpg');
}

export function postFilename(post) {
  return typeOf(post).prefix + (post.slug || 'post') + '.html';
}
```

- [ ] **Step 5: Make `buildPostView` type-aware**

In `buildPostView`, replace:

```js
  const title = String(post.title || '').trim() ||
    ('FinTech Female Fridays: Meet ' + (post.name || ''));
```

with:

```js
  const title = postTitle(post);
```

Replace the `tagText` line in the returned object:

```js
    tagText: escText(post.tag || 'Fintech Female Fridays'),
```

with:

```js
    tagText: escText(post.tag || typeOf(post).tagFallback),
```

And add three fields to the returned object, directly after `coverAttr`:

```js
    /* The cover's alt text. A news post has no interviewee to name, so it is
       described by its title instead of shipping an empty alt. */
    coverAltAttr: escAttr(post.name || title),

    /* The news hero prints the byline in two pieces where the FFF hero prints
       one line: the author in .article-who, the date and read time in
       .article-meta. Both drop out entirely when blank. */
    authorText: escText(String(post.author || '').trim()),
    dateMetaText: escText(
      [post.date, post.readTime]
        .map((part) => String(part == null ? '' : part).trim())
        .filter(Boolean)
        .join(' · ')
    ),
```

- [ ] **Step 6: Make `buildCardView` type-aware**

Replace the `tagLine` assignment:

```js
  const tagLine = String(post.cardTag || '').trim() ||
    [post.role, post.company].map((p) => String(p == null ? '' : p).trim()).filter(Boolean).join(' · ');
```

with:

```js
  /* cardTag, then role · company, then the post's own tag. The first two are
     interviewee fields, so a news post resolves at the third -- without it the
     card printed no chip at all. */
  const tagLine = String(post.cardTag || '').trim() ||
    [post.role, post.company].map((p) => String(p == null ? '' : p).trim()).filter(Boolean).join(' · ') ||
    String(post.tag || '').trim();
```

Replace the title block and its comment:

```js
  // Same fallback buildPostView uses -- the editor's own help text on the
  // title field says "Leave blank to use ...Meet {name}", so a card must
  // resolve the same way the post page does or a titleless post publishes
  // with an empty <h2>.
  const title = String(post.title || '').trim() ||
    ('FinTech Female Fridays: Meet ' + (post.name || ''));
```

with:

```js
  /* postTitle() is the one resolution both the page and the card use. They
     disagreed once: the editor's help text promises a "Meet {name}" fallback,
     and a card that did not honour it published an empty <h2>. */
  const title = postTitle(post);
```

Change the `nameAttr` line in the returned object:

```js
    nameAttr: escAttr(post.name),
```

to:

```js
    /* The card image's alt text. A news post has no name, so it is described
       by its title rather than shipping an empty alt. */
    nameAttr: escAttr(post.name || title),
```

And add, after `featuredMetaHtml`:

```js
    badgeText: escText(typeOf(post).cardBadge)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tools/render-blocks.test.mjs`
Expected: PASS.

- [ ] **Step 8: Run the whole suite and the build**

Run: `npm test && npm run build`
Expected: PASS, and a clean build. The seven post files re-render.

- [ ] **Step 9: Verify nothing published changed**

Run: `npm run verify | tail -5`
Expected: identical to `/tmp/verify-baseline.txt` from Task 1. If a post page or a listing page now differs, the cause is a fallback that resolved differently — stop and find it rather than proceeding.

- [ ] **Step 10: Commit**

```bash
git add lib/render-blocks.mjs tools/render-blocks.test.mjs
git commit -m "Take the FFF assumptions out of the renderer

The URL prefix, the cover path prefix, the title fallback and the tag chip
fallback all came from the registry's fff entry by way of a literal. They
now come from the post's own type.

Two latent bugs fixed while here, both of which only appear once a second
type exists: a card with no interviewee resolved to no tag chip at all, and
its image shipped an empty alt attribute."
```

---

### Task 3: The post data file reads the registry

**Files:**
- Modify: `src/posts/posts.11tydata.js`
- Test: `tools/post-data.test.mjs` (create)

**Interfaces:**
- Consumes: `typeOf`, `typeKeyOf` from `lib/post-types.mjs` (Task 1).
- Produces: the default export's `eleventyComputed` gains `active`, `heroInclude`, `footInclude`; `permalink` now keys its collision registry on the output URL. `layout` stays the static string `'post.njk'`.

- [ ] **Step 1: Write the failing test**

Create `tools/post-data.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import postData from '../src/posts/posts.11tydata.js';

const { active, heroInclude, footInclude, permalink } = postData.eleventyComputed;

/* Eleventy resolves a layout before computed data runs, so this one key
   cannot be computed. If it ever moves into eleventyComputed, every post
   renders as a bare fragment with no nav and no footer. */
test('layout is a static key, not a computed one', () => {
  assert.equal(postData.layout, 'post.njk');
  assert.equal(postData.eleventyComputed.layout, undefined);
});

test('a post highlights its own listing page in the nav', () => {
  assert.equal(active({ type: 'fff' }), 'fintech-female-fridays.html');
  assert.equal(active({ type: 'post' }), 'happenings.html');
  assert.equal(active({}), 'fintech-female-fridays.html');
});

test('the hero and foot partials come from the type', () => {
  assert.equal(heroInclude({ type: 'fff' }), 'hero-fff.njk');
  assert.equal(footInclude({ type: 'fff' }), 'foot-fff.njk');
  assert.equal(heroInclude({ type: 'post' }), 'hero-happenings.njk');
  assert.equal(footInclude({ type: 'post' }), 'foot-happenings.njk');
});

const at = (file) => ({ page: { inputPath: `./src/posts/${file}` } });

test('each type publishes under its own prefix', () => {
  globalThis.__postSlugs = new Map();
  assert.equal(permalink({ type: 'fff', slug: 'shira-amrany', ...at('a.html') }),
    'fff-shira-amrany.html');
  assert.equal(permalink({ type: 'post', slug: 'october-recap', ...at('b.html') }),
    'post-october-recap.html');
});

/* The Phase 5 guard keyed on the slug alone. With two types that is no longer
   the same thing as the output path, and an author would have been told about
   a collision that does not exist. */
test('one slug in two types does not collide', () => {
  globalThis.__postSlugs = new Map();
  assert.equal(permalink({ type: 'fff', slug: 'jane-doe', ...at('a.html') }),
    'fff-jane-doe.html');
  assert.equal(permalink({ type: 'post', slug: 'jane-doe', ...at('b.html') }),
    'post-jane-doe.html');
});

test('one slug twice within a type fails the build, naming both files', () => {
  globalThis.__postSlugs = new Map();
  permalink({ type: 'post', slug: 'jane-doe', ...at('a.html') });
  assert.throws(
    () => permalink({ type: 'post', slug: 'jane-doe', ...at('b.html') }),
    (err) => {
      assert.match(err.message, /post-jane-doe\.html/);
      assert.match(err.message, /a\.html/);
      assert.match(err.message, /b\.html/);
      return true;
    }
  );
});

test('rebuilding the same file is not a collision', () => {
  globalThis.__postSlugs = new Map();
  permalink({ type: 'post', slug: 'jane-doe', ...at('a.html') });
  assert.equal(permalink({ type: 'post', slug: 'jane-doe', ...at('a.html') }),
    'post-jane-doe.html');
});

test('a post with no slug says so', () => {
  globalThis.__postSlugs = new Map();
  assert.throws(() => permalink({ type: 'post', slug: '  ', ...at('a.html') }),
    /no slug/);
});

test('an unknown type fails before it can get a URL', () => {
  globalThis.__postSlugs = new Map();
  assert.throws(() => permalink({ type: 'newsletter', slug: 'x', ...at('a.html') }),
    /newsletter/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tools/post-data.test.mjs`
Expected: FAIL — `active`, `heroInclude` and `footInclude` are not functions.

- [ ] **Step 3: Write the implementation**

Replace the whole of `src/posts/posts.11tydata.js` with:

```js
/* Everything under src/posts/ is a post. Which kind it is comes from its own
 * `type` field, via lib/post-types.mjs.
 *
 * A post file is front matter and nothing else: the body is the `blocks` list,
 * rendered by src/_includes/post.njk through lib/render-blocks.mjs.
 */
import { buildPostView, buildCardView } from '../../lib/render-blocks.mjs';
import { typeOf } from '../../lib/post-types.mjs';

export default {
  /* Static, and it has to be. Eleventy resolves a template's layout before
     computed data runs, so this is one of the keys eleventyComputed cannot set
     -- permalink is the documented exception. Both types render through
     post.njk and differ only in the hero and foot partials it includes. */
  layout: 'post.njk',

  eleventyComputed: {
    /* A post keeps its own listing page highlighted in the nav, not itself --
       matching what fff-shira-amrany.html did by hand. */
    active: (data) => typeOf(data).listing,

    /* The two regions of the layout that differ by type. Ordinary computed
       keys, not Eleventy's special `layout`, so the restriction above does not
       reach them. */
    heroInclude: (data) => typeOf(data).hero,
    footInclude: (data) => typeOf(data).foot,

    /* The view model does every derivation — title fallback, description from
       the intro, absolute OG URLs — so the template only prints.
       `date` is deliberately not an Eleventy front-matter key: Eleventy
       reserves it and would try to parse "Jul 10" as a timestamp. The display
       string is `displayDate`; `isoDate` is the sortable one. Collection
       membership and ordering are handled explicitly in eleventy.config.js,
       not by `tags` or Eleventy's default date sort -- see the comment there
       for why. */
    post: (data) => buildPostView({ ...data, date: data.displayDate }),

    /* The listing pages and the homepage all print this, so it is derived once
       here rather than in three templates. */
    card: (data) => buildCardView(data),

    /* src/src.11tydata.js derives every URL from page.filePathStem, which is
       the *template's* path. Left alone that puts posts at /posts/<slug>.html,
       and once several posts share a generating template it would collide
       them all at one URL. Posts stay flat at the root, under their type's
       prefix, where every inbound link already points.

       Two posts that write one file would lose one of them. Nobody is
       watching this build after handoff to notice, so a collision fails the
       build. The registry is keyed on the *output URL*, not the slug: two
       types share a slug space but not an output path, so fff-jane-doe.html
       and post-jane-doe.html must not be reported as a collision. It is reset
       per build (see eleventy.config.js's eleventy.before handler) so a
       renamed or deleted post does not leave a stale entry that
       false-positives the next rebuild in the same `npm run dev` process. */
    permalink: (data) => {
      const here = data.page.inputPath;
      if (!String(data.slug || '').trim()) {
        throw new Error(`Post has no slug, so it cannot get a URL: ${here}`);
      }
      const url = typeOf(data).prefix + data.slug + '.html';
      const seen = (globalThis.__postSlugs ||= new Map());
      const previous = seen.get(url);
      if (previous && previous !== here) {
        throw new Error(`Two posts both publish to ${url}: ${previous} and ${here}`);
      }
      seen.set(url, here);
      return url;
    }
  }
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tools/post-data.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite, build, and verify**

Run: `npm test && npm run build && npm run verify | tail -5`
Expected: tests PASS, build clean, verify output identical to `/tmp/verify-baseline.txt`. The seven posts still land at `fff-<slug>.html`.

`heroInclude` and `footInclude` are computed but nothing includes them yet — `post.njk` still has its hero inline. That is expected at this point; Task 5 wires them up.

- [ ] **Step 6: Commit**

```bash
git add src/posts/posts.11tydata.js tools/post-data.test.mjs
git commit -m "Derive a post's URL, nav state and partials from its type

layout stays static because Eleventy cannot compute one; the hero and foot
partial paths are ordinary computed keys instead, and nothing includes them
yet.

The duplicate guard now keys on the output URL rather than the slug. Keyed
on the slug it would have told an author that fff-jane-doe.html and
post-jane-doe.html collide, which they do not."
```

---

### Task 4: One collection per type

**Files:**
- Modify: `eleventy.config.js` — the `addCollection('fff', …)` block
- Test: `tools/post-types.test.mjs` (append)

**Interfaces:**
- Consumes: `POST_TYPES`, `sortedPostsOfType` from `lib/post-types.mjs` (Task 1).
- Produces: `collections.fff` (unchanged in content and order) and `collections.happenings`, available to templates in Tasks 7–8.

- [ ] **Step 1: Write the failing test**

Append to `tools/post-types.test.mjs`:

```js
/* The collection names are what the listing templates loop. A type added to
   the registry without one would publish posts that appear on no page. */
test('every type names a collection, and the names are distinct', () => {
  const names = Object.values(POST_TYPES).map((type) => type.collection);
  assert.deepEqual(names, ['fff', 'happenings']);
  assert.equal(new Set(names).size, names.length);
});

test('every type names a hero, a foot, a listing page and a prefix', () => {
  for (const [key, type] of Object.entries(POST_TYPES)) {
    for (const field of ['label', 'prefix', 'listing', 'collection', 'hero', 'foot', 'cardBadge', 'tagFallback', 'slugSource']) {
      assert.equal(typeof type[field], 'string', `${key}.${field} must be a string`);
      assert.ok(type[field].length, `${key}.${field} must not be empty`);
    }
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tools/post-types.test.mjs`
Expected: FAIL — `collection` is undefined on both types if Task 1 was implemented without it. If Task 1 included `collection`, these pass immediately; that is fine, proceed to Step 3.

- [ ] **Step 3: Replace the collection block**

In `eleventy.config.js`, add the import at the top of the file, above `export default function`:

```js
import { POST_TYPES, sortedPostsOfType } from './lib/post-types.mjs';
```

Replace:

```js
  eleventyConfig.addCollection('fff', (api) =>
    api.getFilteredByGlob('src/posts/*.html')
      .filter((post) => (post.data.type || 'fff') === 'fff')
      .sort((a, b) => ((a.data.isoDate || '') < (b.data.isoDate || '') ? 1 : -1)));
```

with:

```js
  /* One collection per registered type, named by the registry, so a type
     cannot be added there and silently join no collection -- its posts would
     publish at a URL with nothing linking to them. The filter and the sort
     live in lib/post-types.mjs, where they are testable. */
  for (const [key, type] of Object.entries(POST_TYPES)) {
    eleventyConfig.addCollection(type.collection, (api) =>
      sortedPostsOfType(api.getFilteredByGlob('src/posts/*.html'), key));
  }
```

Leave the long comment above the old block in place — it explains why membership is filtered here rather than through `tags`, and why the sort is explicit, and both still apply. Update only its closing sentence that refers to "this collection" so it reads as covering both.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tools/post-types.test.mjs`
Expected: PASS.

- [ ] **Step 5: Verify the FFF collection is byte-identical in use**

Run: `npm test && npm run build && npm run verify | tail -5`
Expected: tests PASS, and verify identical to `/tmp/verify-baseline.txt`. `fintech-female-fridays.html` renders from `collections.fff`, so any reordering shows up here.

- [ ] **Step 6: Confirm the new collection exists and is empty**

Run: `node -e "import('./lib/post-types.mjs').then(m => console.log(Object.values(m.POST_TYPES).map(t => t.collection)))"`
Expected: `[ 'fff', 'happenings' ]`

There are no `type: post` files yet, so `collections.happenings` is an empty array. Task 8 handles what the page shows then.

- [ ] **Step 7: Commit**

```bash
git add eleventy.config.js tools/post-types.test.mjs
git commit -m "Build one collection per post type from the registry

The fff collection was the only one, with its filter and sort inline. Both
now come from lib/post-types.mjs and loop the registry, so adding a type
cannot leave its posts on a page nobody links to. collections.happenings
exists and is empty."
```

---

### Task 5: Extract the hero and foot from `post.njk`

This is the highest-risk edit in the plan: seven published pages render through this file. It gets its own commit so the diff is reviewable alone.

**Files:**
- Create: `src/_includes/hero-fff.njk`, `src/_includes/foot-fff.njk`
- Modify: `src/_includes/post.njk`

**Interfaces:**
- Consumes: `heroInclude`, `footInclude` computed keys (Task 3); `post.coverAltAttr` (Task 2).
- Produces: `post.njk` as the single layout for both types, including its hero and foot by variable.

- [ ] **Step 1: Create `src/_includes/hero-fff.njk`**

Move the hero out of `post.njk` verbatim — the `<section class="page-hero article-hero">` element and everything inside it:

```njk
{#
  The Fintech Female Fridays hero: the interviewee is the subject. Values
  arrive already escaped from lib/render-blocks.mjs, so each needs `| safe`.
-#}
<section class="page-hero article-hero">
  <div class="wrap inner">
    <div class="article-tag">{{ post.tagText | safe }}</div>
    <h1>{{ post.titleText | safe }}</h1>
    <div class="article-byline">
      <img src="{{ post.headshotAttr | safe }}" alt="{{ post.nameAttr | safe }}" width="52" height="52">
      <div class="article-who">{{ post.nameText | safe }}
        {%- if post.roleLineText %}
        <small>{{ post.roleLineText | safe }}</small>
        {%- endif %}
        {%- if post.hasLinkedin %}
        <a href="{{ post.linkedinAttr | safe }}" target="_blank" rel="noopener">LinkedIn &rarr;</a>
        {%- endif %}
      </div>
      <div class="article-meta">{{ post.metaLineText | safe }}</div>
    </div>
  </div>
</section>
```

- [ ] **Step 2: Create `src/_includes/foot-fff.njk`**

Move the foot out of `post.njk` verbatim — the `<div class="article-foot">` element and its contents:

```njk
{#
  The Fintech Female Fridays foot: back to the listing, and an invitation to
  connect with the interviewee.
-#}
<div class="article-foot">
  <a href="fintech-female-fridays.html" class="back-link">&larr; All Fintech Female Fridays</a>
  {%- if post.hasLinkedin %}
  <a href="{{ post.linkedinAttr | safe }}" class="btn btn-ghost" target="_blank" rel="noopener">Connect with {{ post.firstNameText | safe }} &rarr;</a>
  {%- endif %}
</div>
```

- [ ] **Step 3: Point `post.njk` at the partials**

In `src/_includes/post.njk`, replace the whole `<!-- ARTICLE HERO -->` section with:

```njk
<!-- ARTICLE HERO -->
{% include heroInclude %}
```

Replace the `<div class="article-foot">…</div>` block with:

```njk
    {% include footInclude %}
```

And change the cover image's alt so a news post is not described by a name it does not have:

```njk
      <img src="{{ post.coverAttr | safe }}" alt="{{ post.coverAltAttr | safe }}">
```

Update the comment at the top of `post.njk` to say it is the layout for every post type and that the hero and foot come from the type:

```njk
{#
  The layout for every post type. Eleventy cannot compute a `layout`, so this
  one file serves both types and the two regions that differ by type — the
  hero and the foot — are included by path from `heroInclude` / `footInclude`
  (see src/posts/posts.11tydata.js).

  Every value in `post` arrives already escaped by lib/render-blocks.mjs — for
  the attribute or the element it is printed into — so each one needs `| safe`.
  Without it Nunjucks escapes a second time and "Data &amp; Analytics" ships as
  "Data &amp;amp; Analytics".
-#}
```

- [ ] **Step 4: Build and verify — this is the gate**

Run: `npm run build && npm run verify | tail -5`
Expected: identical to `/tmp/verify-baseline.txt`. A variable `{% include %}` that failed to resolve would produce a page missing its hero, which shows as seven changed files.

- [ ] **Step 5: Confirm the hero really rendered, not silently emptied**

Run: `grep -c "article-byline" _site/fff-shira-amrany.html`
Expected: `1`

Run: `grep -c "All Fintech Female Fridays" _site/fff-shira-amrany.html`
Expected: `1`

`npm run verify` canonicalizes whitespace, so this pair is the check that the partial's *content* arrived, independent of how it was reflowed.

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/_includes/post.njk src/_includes/hero-fff.njk src/_includes/foot-fff.njk
git commit -m "Include the post hero and foot by path

post.njk is the layout for both post types, because Eleventy cannot compute
a layout key. The two regions that actually differ -- the interviewee hero
and the foot -- move into partials it includes from computed keys.

Moved verbatim. npm run verify confirms the seven published pages are
unchanged, and the cover's alt text now falls back to the title for a post
with no interviewee."
```

---

### Task 6: Extract the card CSS

**Files:**
- Create: `src/_includes/post-cards.css`
- Modify: `src/fintech-female-fridays.html`

**Interfaces:**
- Consumes: nothing.
- Produces: `post-cards.css`, included by `fintech-female-fridays.html` here and by `happenings.html` in Task 8.

- [ ] **Step 1: Move the style block**

Copy the entire contents of the `<style>` element in `src/fintech-female-fridays.html` — everything from the `/* featured post */` comment through the final `.post-body h3 { text-wrap: balance; }` — into a new file `src/_includes/post-cards.css`, **byte for byte and in the same order**. Prepend one comment line:

```css
  /* Post cards: the featured card, the grid, the gradient washes and the
     duotone cover treatment. Shared by fintech-female-fridays.html and
     happenings.html. Order matters: the g1-g7 gradients and the ::after
     overlay rules modify the .post-img and .feature-img rules above them. */
```

Order is load-bearing. `.g1`–`.g7` are declared after the `.post-img` rules they paint, and the duotone `::after` overlays come last.

- [ ] **Step 2: Replace the inline block with an include**

In `src/fintech-female-fridays.html`, the `<style>` element becomes:

```html
<style>
{% include "post-cards.css" %}
</style>
```

No passthrough copy is needed: the file is inlined at build time, not fetched. (`post-article.css` is also passthrough-copied, but only because the editor's preview iframe loads it over HTTP.)

- [ ] **Step 3: Build and verify**

Run: `npm run build && npm run verify | tail -5`
Expected: identical to `/tmp/verify-baseline.txt`. The comparison canonicalizes whitespace, so reflow is invisible, but a dropped or reordered rule is not.

- [ ] **Step 4: Confirm the rules actually arrived and kept their order**

Run: `grep -o "\.g[1-7], \.g[1-7]::after" _site/fintech-female-fridays.html | head -7`
Expected: seven lines, `.g1, .g1::after` through `.g7, .g7::after`.

Run: `node -e "const s=require('fs').readFileSync('_site/fintech-female-fridays.html','utf8'); console.log(s.indexOf('.post-img {') < s.indexOf('.g1, .g1::after'))"`
Expected: `true` — the gradients still come after the rules they modify.

- [ ] **Step 5: Commit**

```bash
git add src/_includes/post-cards.css src/fintech-female-fridays.html
git commit -m "Move the post card CSS into an include

happenings.html needs the same card rules, and copy-pasting them is how the
nav ended up with twelve copies. Moved verbatim, order preserved: the
gradients and the duotone overlays modify the rules declared above them."
```

---

### Task 7: The news hero and foot

**Files:**
- Create: `src/_includes/hero-happenings.njk`, `src/_includes/foot-happenings.njk`

**Interfaces:**
- Consumes: `post.tagText`, `post.titleText`, `post.authorText`, `post.dateMetaText` from `buildPostView` (Task 2); included by path from `heroInclude` / `footInclude` (Task 3).
- Produces: nothing other tasks consume.

These reuse `.article-byline`, `.article-who` and `.article-meta` from `post-article.css` deliberately: **no new CSS.** That file is inlined into every post page, so adding a rule to it would change all seven published FFF pages and fail verify.

- [ ] **Step 1: Create `src/_includes/hero-happenings.njk`**

```njk
{#
  The Jobs & Happenings hero: the post is the subject, not a person. Reuses
  .article-byline / .article-who / .article-meta rather than adding rules,
  because post-article.css is inlined into every post page — a new rule there
  would change all seven published FFF pages.

  Every value arrives already escaped from lib/render-blocks.mjs, so each
  needs `| safe`. author, date and read time are all optional and drop out
  entirely when blank, leaving no empty element and no dangling separator.
-#}
<section class="page-hero article-hero">
  <div class="wrap inner">
    <div class="article-tag">{{ post.tagText | safe }}</div>
    <h1>{{ post.titleText | safe }}</h1>
    {%- if post.authorText or post.dateMetaText %}
    <div class="article-byline">
      {%- if post.authorText %}
      <div class="article-who">{{ post.authorText | safe }}</div>
      {%- endif %}
      {%- if post.dateMetaText %}
      <div class="article-meta">{{ post.dateMetaText | safe }}</div>
      {%- endif %}
    </div>
    {%- endif %}
  </div>
</section>
```

- [ ] **Step 2: Create `src/_includes/foot-happenings.njk`**

```njk
{#
  The Jobs & Happenings foot. No "connect with" link: there is no interviewee
  to connect with.
-#}
<div class="article-foot">
  <a href="happenings.html" class="back-link">&larr; All Jobs &amp; Happenings</a>
</div>
```

- [ ] **Step 3: Build and verify nothing regressed**

Run: `npm run build && npm run verify | tail -5`
Expected: identical to `/tmp/verify-baseline.txt`. Nothing includes these partials yet — there are no `type: post` files — so the build output is unchanged.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/_includes/hero-happenings.njk src/_includes/foot-happenings.njk
git commit -m "Add the news hero and foot

A Jobs & Happenings post is about the post, not about a person: title,
then whichever of author, date and read time the author filled in. No new
CSS -- post-article.css is inlined into all seven published FFF pages, so a
rule added there would change every one of them."
```

---

### Task 8: The listing page, the nav, and the docs

**Files:**
- Create: `src/happenings.html`
- Modify: `src/_data/nav.json`, `README.md`

**Interfaces:**
- Consumes: `collections.happenings` (Task 4), `post-cards.njk`'s `grid` macro with `card.badgeText` (Task 2), `post-cards.css` (Task 6).
- Produces: the page at `/happenings.html` that `foot-happenings.njk` and the nav link to.

- [ ] **Step 1: Teach the grid macro to print the badge**

In `src/_includes/post-card.njk`, in the `grid` macro, replace:

```njk
<span class="num">FFF</span>
```

with:

```njk
<span class="num">{{ card.badgeText | safe }}</span>
```

- [ ] **Step 2: Verify the FFF listing is unchanged by that substitution**

Run: `npm run build && npm run verify | tail -5`
Expected: identical to `/tmp/verify-baseline.txt`. `badgeText` is `FFF` for every FFF post, so the rendered string is the same.

- [ ] **Step 3: Create `src/happenings.html`**

```html
---
active: "happenings.html"
---
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Jobs &amp; Happenings — NYC Fintech Women</title>
<meta name="description" content="Event recaps, announcements, and news from the NYC Fintech Women community." />
<link rel="stylesheet" href="site.css" />
<style>
{% include "post-cards.css" %}
  /* The empty state. This page ships with nothing in it: the first Jobs &
     Happenings post is published by an author, not committed with the site. */
  .nothing-yet { max-width: 720px; margin: 0 auto; padding: 48px 0 8px; text-align: center; color: var(--muted); font-size: 17px; line-height: 1.6; }
</style>
</head>
<body>

<!-- NAV -->
{% include "nav.njk" %}

{% include "mobile-drawer.njk" %}

<!-- HERO -->
<section class="page-hero">
  <div class="wrap inner">
    <div class="kicker">Jobs &amp; Happenings</div>
    <h1>What's <em>happening</em> across the community.</h1>
    <p>Event recaps, announcements, and news from the women building financial services in New York, San Francisco, and Chicago.</p>
  </div>
</section>

{% import "post-card.njk" as cards %}

<!-- POSTS -->
<section class="section" style="padding-top: 8px;">
  <div class="wrap">
{% set posts = collections.happenings %}
{% if posts.length %}
    <div class="blog-grid">
{% for post in posts %}{{ cards.grid(post.data.card) }}{% endfor %}
    </div>
{% else %}
    <p class="nothing-yet">Nothing here yet — check back soon.</p>
{% endif %}
  </div>
</section>

<!-- FOOTER -->
{% include "footer.njk" %}

<script src="nav-mobile.js"></script>
</body>
</html>
```

No featured card and no "see all" link: the grid is the page, and there is no other archive to point at.

- [ ] **Step 4: Add the nav, drawer and footer entries**

In `src/_data/nav.json`, three edits, all the same label and href.

In `primary`, append to the **Our Programs** `children` array:

```json
        { "label": "Jobs & Happenings", "href": "happenings.html" }
```

In `mobile`, append to the **Our Programs** `children` array the identical object.

In `footer.columns`, append to the **Events** column's `links` array the identical object.

No filter change is needed: `isCurrent` already highlights a dropdown parent when any child's `href` matches `active`, and a news post's `active` is `happenings.html`.

- [ ] **Step 5: Build and check the page and the nav**

Run: `npm run build`
Expected: clean build.

Run: `grep -c "Nothing here yet" _site/happenings.html`
Expected: `1` — the empty state rendered, and the `{% if %}` did not leave an empty `.blog-grid` behind.

Run: `grep -c "blog-grid" _site/happenings.html`
Expected: `0`

Run: `grep -lc "happenings.html" _site/*.html | wc -l`
Expected: `12` — every page carries the new nav and footer link, from the one edit to `nav.json`.

- [ ] **Step 6: Verify nothing published changed**

Run: `npm run verify | tail -5`
Expected: identical to `/tmp/verify-baseline.txt`. The nav and footer additions land inside the baseline pages, so this is the check that matters most in this task — **if the nav edit changed the 11 baseline pages, verify will report them as changed, and that is correct and expected.**

Read the output carefully. A nav link added to every page **is** a change to those pages. Record the new numbers as the updated baseline:

```bash
npm run verify | tail -5 > /tmp/verify-baseline.txt
cat /tmp/verify-baseline.txt
```

Then confirm the only differences are the nav, drawer and footer additions:

```bash
npm run verify | grep -A3 "CHANGED" | head -40
```

Expected: the reported first-differing line is the Our Programs dropdown or the footer Events column, on every listed page. Any page differing anywhere else is a real regression — stop.

- [ ] **Step 7: Update the README**

In `README.md`, three edits:

In the Pages table, after the FFF post pages row:

```markdown
| Jobs & Happenings | `happenings.html` |
| Jobs & Happenings post pages | `post-<slug>.html` (built from `src/posts/<slug>.html`) |
```

In the `### Posts` section, replace the opening sentence "All seven Fintech Female Fridays posts live in `src/posts/` as data." with a paragraph covering both types:

```markdown
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
badge, and the hero and foot partials `post.njk` includes. Adding a type is an
entry there plus a field list in `src/admin/types.js`.

`layout` is **not** one of those facts, and cannot be: Eleventy resolves a
template's layout before computed data runs, so every post type renders through
`src/_includes/post.njk` and varies only by the partials it includes.
```

- [ ] **Step 8: Commit**

```bash
git add src/happenings.html src/_includes/post-card.njk src/_data/nav.json README.md
git commit -m "Add the Jobs & Happenings listing page and its way in

The page ships empty, because the first post is published by an author
rather than committed with the site -- so the empty state is a designed
output, not what an empty loop happens to leave behind.

One nav.json edit puts the link in the top nav, the mobile drawer and the
footer on all 12 pages. The card badge now comes from the post's type
instead of the literal FFF the grid macro printed."
```

---

### Task 9: The editor learns the second type

**Files:**
- Modify: `src/admin/types.js`, `src/admin/editor.js`, `README.md`
- Test: `tools/post-types.test.mjs` (append)

**Interfaces:**
- Consumes: `POST_TYPES`, `postTitle` from `lib/post-types.mjs` (Task 1).
- Produces: a working `post` option in the editor's type selector.

`src/admin/types.js` must stay importable from Node for the completeness test, so it must **not** import `/lib/post-types.mjs` — that absolute path only resolves in a browser. `editor.js` merges the two.

- [ ] **Step 1: Write the failing test**

Append to `tools/post-types.test.mjs`, moving the new `import` up beside the existing one at the top of the file:

```js
import { TYPES } from '../src/admin/types.js';

/* Half-adding a type is the failure this catches: an entry in one registry and
   not the other means either a post type the editor cannot write, or a form
   that produces files the build rejects. */
test('the editor has a form for every registered type, and no others', () => {
  assert.deepEqual(Object.keys(TYPES).sort(), Object.keys(POST_TYPES).sort());
});

test('every editor type has fields and the full block list', () => {
  for (const [key, def] of Object.entries(TYPES)) {
    assert.ok(Array.isArray(def.fields) && def.fields.length, `${key} needs fields`);
    assert.deepEqual([...def.blocks].sort(),
      ['heading', 'image', 'list', 'paragraph', 'qa', 'quote']);
  }
});

/* The field a post's slug is derived from has to be a field the form actually
   shows, or the slug never fills in. */
test('each type derives its slug from one of its own required fields', () => {
  for (const [key, type] of Object.entries(POST_TYPES)) {
    const field = TYPES[key].fields.find((f) => f.key === type.slugSource);
    assert.ok(field, `${key}.slugSource "${type.slugSource}" is not a field on the form`);
    assert.equal(field.required, true, `${key}.slugSource must be required`);
  }
});

test('a news post form has no interviewee fields', () => {
  const keys = TYPES.post.fields.map((f) => f.key);
  for (const absent of ['name', 'role', 'company', 'linkedin']) {
    assert.ok(!keys.includes(absent), `post form must not carry "${absent}"`);
  }
  assert.ok(keys.includes('title'));
  assert.ok(keys.includes('author'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tools/post-types.test.mjs`
Expected: FAIL — `TYPES` has only `fff`, so the key-set comparison fails.

- [ ] **Step 3: Add the `post` field list and entry to `src/admin/types.js`**

Add, after the `FFF_FIELDS` array:

```js
/* --------------------------------------------------- Jobs & Happenings fields */

/* No name, role, company or linkedin: those describe an interviewee. The
   title is required and has no fallback -- a news post cannot borrow the FFF
   "Meet {name}" default, so a blank one is refused at download rather than
   published as an empty headline. */
const POST_FIELDS = [
  { key: 'title', label: 'Post title', type: 'text', required: true,
    placeholder: 'October in review: three sold-out nights',
    help: 'Required. Drives the slug and the filename.' },
  { key: 'slug', label: 'Slug', type: 'text', required: true, mono: true,
    prefix: 'post-', suffix: '.html',
    help: 'Auto-filled from the title. Edit it and it stops following. The file downloads as <code>&lt;slug&gt;.html</code>; the build adds the <code>post-</code> prefix. Letters, digits and hyphens only.' },
  { key: 'tag', label: 'Tag / category', type: 'text',
    placeholder: 'Event recap',
    help: 'The uppercase chip above the headline and on the card. Blank = “Jobs &amp; Happenings”.' },
  { key: 'author', label: 'Written by', type: 'text',
    placeholder: 'Manvir Singh' },
  { key: 'date', label: 'Publish date', type: 'text', placeholder: 'Oct 14',
    help: 'Displayed as typed, matching the existing cards.' },
  { key: 'isoDate', label: 'ISO date', type: 'date',
    help: 'Machine-readable date. Also what orders the listing page.' },
  { key: 'readTime', label: 'Read time', type: 'text', placeholder: '4 min' },
  { key: 'gradient', label: 'Card gradient', type: 'select',
    options: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'],
    help: 'The duotone wash over the cover on the listing card.' },
  { key: 'intro', label: 'Intro / hook', type: 'textarea', rows: 6, required: true,
    placeholder: 'The opening paragraph…',
    help: 'Also the default source for the card excerpt and meta description.' },
  { key: 'excerpt', label: 'Card excerpt', type: 'textarea', rows: 3,
    help: 'Optional. Blank = first ~240 characters of the intro.' },
  { key: 'metaDescription', label: 'Meta description', type: 'textarea', rows: 2,
    maxlength: 200,
    help: 'Optional. Blank = first ~155 characters of the intro.' },
  { key: 'ogTitle', label: 'Social (OG) title', type: 'text',
    help: 'Optional. Blank = post title.' },
  { key: 'ogImage', label: 'Social (OG) image', type: 'text',
    help: 'Optional. Blank = the cover image. Emitted as an absolute URL.' }
];
```

Then, above the `TYPES` export, define the shared block list once — it must be declared before the object literal that references it:

```js
/* Both types take the same blocks. A recap that quotes a speaker has the same
   need for `qa` as an interview does. */
const ALL_BLOCKS = ['qa', 'heading', 'paragraph', 'quote', 'image', 'list'];
```

Then replace the `TYPES` export, which currently carries `label` and an inline block array for `fff`. The labels come from `lib/post-types.mjs` at runtime, so they are not restated here:

```js
/* ------------------------------------------------------------- page type */

/* Form fields only. A type's identity -- its label, URL prefix, listing page,
   card badge and partials -- lives in lib/post-types.mjs, which editor.js
   merges in. This file stays free of that import so it can be loaded from Node
   by the test that checks the two registries have the same types. */
export const TYPES = {
  fff: { fields: FFF_FIELDS, blocks: ALL_BLOCKS },
  post: { fields: POST_FIELDS, blocks: ALL_BLOCKS }
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tools/post-types.test.mjs`
Expected: PASS.

- [ ] **Step 5: Merge the registries in `editor.js`**

In `src/admin/editor.js`, add to the imports:

```js
import { POST_TYPES, postTitle } from '/lib/post-types.mjs';
```

Replace the type-resolution block at the top (currently lines 11–15) — note `STORAGE_KEY` moves below `typeKey` because it now depends on it:

```js
var typeKey = (new URLSearchParams(location.search).get('type')) || 'fff';
if (!TYPES[typeKey] || !POST_TYPES[typeKey]) typeKey = 'fff';

/* Identity from lib/, form fields from types.js. */
var def = Object.assign({}, POST_TYPES[typeKey], TYPES[typeKey]);

/* Per type, so switching types does not restore an interview into a news form
   or the other way round. */
var STORAGE_KEY = 'wif.admin.draft.v1.' + typeKey;
```

- [ ] **Step 6: Make the slug source and cover prefix type-aware**

In `resolved()`, replace:

```js
  m.slug = model.slug || slugify(model.name);
  m.coverPath = (model.coverPath || '').trim() ||
    ('images/fff-' + (m.slug || 'post') + '.' + outputExt());
```

with:

```js
  m.slug = model.slug || slugify(model[def.slugSource] || '');
  m.coverPath = (model.coverPath || '').trim() ||
    ('images/' + def.prefix + (m.slug || 'post') + '.' + outputExt());
```

In `renderFields`, replace the slug auto-fill condition:

```js
      if (f.key === 'name' && !slugTouched) {
```

with:

```js
      if (f.key === def.slugSource && !slugTouched) {
```

- [ ] **Step 7: Refuse a news post with no title**

In `downloadPost()`, replace:

```js
  if (!m.slug) { toast('Add a name first'); return; }
```

with:

```js
  var firstField = def.slugSource === 'title' ? 'title' : 'name';
  if (!m.slug) { toast('Add a ' + firstField + ' first'); return; }
  /* A Jobs & Happenings post has no title fallback to borrow, so a blank one
     would publish as an empty headline and an empty card. Refuse it here,
     where the author can see the field, rather than letting the file out. */
  if (!postTitle(m)) { toast('Add a post title — this post type has no default title.'); return; }
```

- [ ] **Step 8: Wire the type selector and guard opening the wrong type**

In `init()`, replace the label loop so it reads the label from `POST_TYPES`, and add the change handler. Replace:

```js
  Object.keys(TYPES).forEach(function (key) {
    var opt = document.createElement('option');
    opt.value = key;
    opt.textContent = TYPES[key].label;
    select.appendChild(opt);
  });
  select.value = typeKey;
  select.disabled = Object.keys(TYPES).length < 2;
```

with:

```js
  Object.keys(TYPES).forEach(function (key) {
    var opt = document.createElement('option');
    opt.value = key;
    opt.textContent = POST_TYPES[key].label;
    select.appendChild(opt);
  });
  select.value = typeKey;
  select.disabled = Object.keys(TYPES).length < 2;

  /* Switching type reloads with ?type=, which is where typeKey comes from.
     Each type keeps its own autosaved draft, so nothing is lost either way. */
  select.addEventListener('change', function () {
    var next = select.value;
    if (next === typeKey) return;
    if (!POST_TYPES[next]) { select.value = typeKey; return; }
    location.search = '?type=' + encodeURIComponent(next);
  });
```

In `openPostFile()`, add the type guard immediately after the unknown-block check and before the `model = Object.assign(...)` line:

```js
  /* The form only has inputs for the current type's fields, so loading a post
     of another type would drop everything the form cannot show -- and a later
     save would write the file back without it. */
  var fileType = String(post.type || 'fff').trim() || 'fff';
  if (!POST_TYPES[fileType]) {
    toast('That post has a type this editor does not know: ' + fileType);
    return;
  }
  if (fileType !== typeKey) {
    toast('That is a ' + POST_TYPES[fileType].label + ' post. Change the type at the top of the form, then open it again.');
    return;
  }
```

And make the success toast work for a post with no name:

```js
  toast('Opened ' + (post.name || post.title || post.slug));
```

- [ ] **Step 9: Run the suite and build**

Run: `npm test && npm run build && npm run verify | tail -5`
Expected: tests PASS, build clean, verify identical to the `/tmp/verify-baseline.txt` recorded at the end of Task 8.

- [ ] **Step 10: Verify the editor in the browser**

Run: `npm run dev` and open `http://localhost:8080/admin/` (trailing slash required).

Check each, in order:

1. The type selector is **enabled** and offers "Fintech Female Fridays" and "Jobs & Happenings".
2. Switch to Jobs & Happenings. The form has no Name, Title/role, Company or LinkedIn field, and has a required Post title.
3. Type a title. The slug fills in from it. Edit the slug by hand; it stops following.
4. Fill in the intro, add a paragraph block. The preview renders the body.
5. **Download post file** with the title cleared → the toast reads "Add a title first". Restore the title → the file downloads as `<slug>.html`.
6. Open that downloaded file back → it loads, and the form and preview refill.
7. Switch to Fintech Female Fridays, then **Open post** on the news file you just saved → the toast reads "That is a Jobs & Happenings post. Change the type at the top of the form, then open it again." and **nothing is loaded** (Review Focus 5).
8. Open one of the real files from `src/posts/` (e.g. `shira-amrany.html`) while the type is Fintech Female Fridays → it loads as before.

- [ ] **Step 11: Update the README's editor section**

In `README.md`, under `## Post editor`, replace the first paragraph with one that names both types, and add the type step to the numbered list:

```markdown
`admin/index.html` is a client-side authoring tool for both post types —
Fintech Female Fridays interviews and Jobs & Happenings posts. There is no
backend and no database: it opens a post file from `src/posts/` and gives you
one back.
```

And insert as the new step 1 of "To edit an existing post", renumbering the rest:

1. **Pick the type** at the top of the form. It decides which fields you get and where the post publishes. Opening a post of the other type tells you to switch first, rather than loading it with fields missing.

- [ ] **Step 12: Commit**

```bash
git add src/admin/types.js src/admin/editor.js tools/post-types.test.mjs README.md
git commit -m "Teach the editor the Jobs & Happenings type

A form without the interviewee fields, a slug derived from the title rather
than a name, a cover named post-<slug>, and a title that is refused when
blank because this type has no fallback to borrow.

types.js holds field lists only and stays free of the /lib import, so a test
can load it from Node and check that neither registry has a type the other
is missing. Drafts are keyed per type: switching no longer restores an
interview into a news form."
```

---

### Task 10: End-to-end, with a real post and then without it

**Files:**
- Temporary: `src/posts/october-recap.html` (created, then deleted)
- No committed changes.

**Interfaces:**
- Consumes: everything above.
- Produces: evidence.

- [ ] **Step 1: Write a fixture news post**

Create `src/posts/october-recap.html` by hand, in exactly the format `serializePost` emits:

```html
---
type: "post"
slug: "october-recap"
title: "October in review: three sold-out nights"
tag: "Event recap"
author: "Manvir Singh"
displayDate: "Oct 14"
isoDate: "2026-10-14"
readTime: "3 min"
gradient: "g4"
coverPath: "images/fff-shira-amrany.jpg"
intro: |-
  Three events, two cities, and one very full room at the co-founder matching
  night. Here is what happened in October, and what is already on the calendar
  for November.
blocks:
  - type: "heading"
    text: "The co-founder matching night"
  - type: "paragraph"
    text: |-
      Forty-one people came through the door, which is the most we have had.
---
```

`coverPath` points at an existing image on purpose — the point of this task is the pipeline, not a new asset.

- [ ] **Step 2: Build and check the post page**

Run: `npm run build`
Expected: clean build.

Run: `ls _site/post-october-recap.html`
Expected: the file exists.

Run: `grep -c "article-byline" _site/post-october-recap.html`
Expected: `1` — the news hero rendered.

Run: `grep -c "LinkedIn &rarr;\|Connect with" _site/post-october-recap.html`
Expected: `0` — no interviewee chrome leaked in.

Run: `grep -o "All Jobs &amp; Happenings" _site/post-october-recap.html`
Expected: one match — the foot links back to the listing.

Run: `grep -o 'class="article-tag">[^<]*' _site/post-october-recap.html`
Expected: `class="article-tag">Event recap`

- [ ] **Step 3: Check the listing page**

Run: `grep -c "Nothing here yet" _site/happenings.html`
Expected: `0` — the empty state stepped aside.

Run: `grep -o 'class="num">[^<]*' _site/happenings.html`
Expected: `class="num">News`

Run: `grep -o 'href="post-october-recap.html"' _site/happenings.html | head -1`
Expected: one match.

Run: `grep -o 'class="ex">[^<]*' _site/happenings.html`
Expected: the excerpt, derived from the intro.

- [ ] **Step 4: Check the nav state on the post page**

Run: `node -e "const s=require('fs').readFileSync('_site/post-october-recap.html','utf8'); const m=s.match(/<a[^>]*class=\"[^\"]*current[^\"]*\"[^>]*>([^<]*)/g); console.log(m)"`
Expected: the Our Programs parent is among the current links — a news post highlights its listing's parent, not Fintech Female Fridays.

Confirm the FFF page did not also light up:

Run: `grep -c "fintech-female-fridays.html\" class=\"[^\"]*current" _site/post-october-recap.html`
Expected: `0`

- [ ] **Step 5: Confirm the FFF side is untouched with a second type present**

Run: `npm run verify | tail -5`
Expected: identical to the `/tmp/verify-baseline.txt` recorded at the end of Task 8. A news post existing must not change one byte of the FFF pages or the homepage.

Run: `grep -c "post-october-recap" _site/fintech-female-fridays.html _site/index.html`
Expected: `0` for both — the news post appears on neither.

- [ ] **Step 6: Prove the collision guard fires on a real duplicate**

Run: `cp src/posts/october-recap.html src/posts/october-recap-copy.html && npm run build; echo "exit: $?"`
Expected: the build FAILS, and the message names `post-october-recap.html` and both input files.

Run: `rm src/posts/october-recap-copy.html && npm run build`
Expected: clean build again.

- [ ] **Step 7: Prove an unknown type fails readably**

Run: `sed -i '' 's/^type: "post"$/type: "newsletter"/' src/posts/october-recap.html && npm run build; echo "exit: $?"`
Expected: the build FAILS with a message naming `newsletter` and listing `fff, post`.

Run: `sed -i '' 's/^type: "newsletter"$/type: "post"/' src/posts/october-recap.html && npm run build`
Expected: clean build again.

- [ ] **Step 8: Remove the fixture and confirm the empty state returns**

Run: `rm src/posts/october-recap.html && npm run build`
Expected: clean build.

Run: `grep -c "Nothing here yet" _site/happenings.html`
Expected: `1`

Run: `npm test && npm run verify | tail -5`
Expected: tests PASS, verify identical to the recorded baseline.

- [ ] **Step 9: Confirm nothing was left behind**

Run: `git status --short`
Expected: no modifications and no untracked files under `src/posts/`. (`.playwright-mcp/` and `src/images/founders-roundtable.jpg` were already untracked before this work and are not part of it.)

- [ ] **Step 10: Report, don't commit**

There is nothing to commit in this task. Report the evidence: the outputs of Steps 2–8, and the final `npm test` and `npm run verify` numbers against the Task 1 and Task 8 baselines.
