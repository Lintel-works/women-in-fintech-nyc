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
