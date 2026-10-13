# Redirects from the Wix site

The site moved off Wix to Vercel on 2026-10-12. Wix served **extensionless**
URLs (`/becomeamember`, `/post/<slug>`, `/event-info/<slug>`); this site serves
`.html` ones. Every old inbound link — bookmarks, newsletters, LinkedIn posts,
and roughly 744 URLs Google had indexed — returned 404 until these redirects
landed.

## Where the old URL list came from

The Wayback Machine's CDX index for `nycfintechwomen.com/*`, filtered to
status 200, from 2024 onward. That is evidence of what was actually reachable,
rather than a guess at what Wix might have published. Wix's own internal paths
(`/_api/...`) and its sitemaps were dropped; `/robots.txt` and `/favicon.ico`
are deliberately **not** redirected, because this site serves its own.

| Old section | URLs | Goes to |
| --- | ---: | --- |
| `/post/<slug>` | 424 | the article, where it could be identified |
| `/profile/<id>` | 162 | `/` — Wix member profiles, no equivalent here |
| `/event-info/<slug>` | 76 | `/events.html` |
| `/jobs-and-happenings/<slug>` | 41 | `/` — the feature is held back from launch |
| top-level pages | ~40 | their counterparts |

## How `/post/` was mapped

The slug schemes do not line up. Wix used the whole headline:

```
/post/fintech-female-fridays-meet-adina-fischer-fractional-coo-cfo-at-182-west
  ->  /fff-adina-fischer.html
```

A post is matched when a current post's slug appears in the old one as a run of
whole hyphen-delimited tokens, longest match winning — so `alice-nawfal` is
preferred over a shorter accidental overlap, and a partial word cannot match.
That is deliberately conservative: sending a reader to the wrong person's
profile is worse than sending them to the index.

**260 of 424 map to their own article.** Four of those were matched by hand,
each confirmed against the post's own `title:` in `src/posts/`, because the
spelling moved: `ratika-ghandi` -> `ratika-gandhi`, `rina-bakhti` ->
`rina-bakhtiani`, `michelle-o-connor` -> `michelle-oconnor`, and a
percent-encoded `luc%C3%ADa-s%C3%A1nchez-le%C3%B3n` -> `lucia-sanchez-leon`.

The remaining 164 fall back to `/fintech-female-fridays.html`, and 141 of those
are job postings (`<company>-is-hiring`) whose Jobs & Happenings section is
held back from launch — there is nowhere for them to go yet. The full
old-to-new table, including every fallback, is in
[`wix-post-redirects.tsv`](wix-post-redirects.tsv).

## Maintaining this

Redirects live in `vercel.json`, ordered specific-before-wildcard: the exact
`/post/<slug>` rules must precede `/post/:slug*`, or the wildcard would swallow
them and every article would land on the index.

When Jobs & Happenings launches, the 141 job URLs become mappable — regenerate
the table rather than editing 141 lines by hand. If a post's slug ever changes,
its old `/post/` rule still points at the previous filename and has to be
updated with it.
