/* Eleventy build.
 *
 * The 11 pages are processed as Nunjucks templates so the nav, mobile drawer
 * and footer can live in one place instead of twelve. Output paths are
 * unchanged: src/events.html still becomes /events.html, not /events/.
 *
 * Not templated:
 *   src/admin/  — the post editor is its own app; copied verbatim
 *   api/        — Vercel reads functions from the repo root, outside src/
 *   tools/      — dev-only regression harness
 */
import { POST_TYPES, sortedPostsOfType } from './lib/post-types.mjs';

export default function (eleventyConfig) {
  // The editor is a standalone app. Keep Eleventy out of it entirely, or its
  // markup would be parsed as a template and its output path rewritten.
  eleventyConfig.ignores.add('src/admin/**');

  eleventyConfig.addPassthroughCopy({ 'src/admin': 'admin' });
  /* Only the four lib/ modules the browser actually imports (see
     src/admin/editor.js and src/admin/text.js) -- passing through the whole
     lib/ directory used to also publish lib/session.mjs, lib/password.mjs
     and lib/github.mjs, none of which the editor needs and none of which
     were meant to be public: they contain the session-cookie signing logic,
     the scrypt password check, and the GitHub commit machinery. Nothing in
     them was a secret (no key or token lives in source), but there is no
     reason to serve them to anyone who asks either. */
  eleventyConfig.addPassthroughCopy({
    'lib/render-blocks.mjs': 'lib/render-blocks.mjs',
    'lib/post-file.mjs': 'lib/post-file.mjs',
    'lib/post-types.mjs': 'lib/post-types.mjs',
    'lib/slug.mjs': 'lib/slug.mjs'
  });
  eleventyConfig.addPassthroughCopy({ 'src/images': 'images' });
  eleventyConfig.addPassthroughCopy({ 'src/site.css': 'site.css' });
  eleventyConfig.addPassthroughCopy({ 'src/nav-mobile.js': 'nav-mobile.js' });
  eleventyConfig.addPassthroughCopy({ 'src/luma-events.js': 'luma-events.js' });
  eleventyConfig.addPassthroughCopy({ 'src/robots.txt': 'robots.txt' });
  /* The post body's CSS, served as a file so the editor preview can load the
     same bytes the page inlines. */
  eleventyConfig.addPassthroughCopy({ 'src/_includes/post-article.css': 'post-article.css' });

  /* A page is "current" if the link is its own, and a dropdown parent is
     current if any of its children is. Kept as a filter because Nunjucks
     cannot assign to an outer variable from inside a loop. */
  eleventyConfig.addFilter('isCurrent', (item, active) => {
    if (!active) return false;
    if (item.href === active) return true;
    if (item.match === active) return true;
    return (item.children || []).some((child) => child.href === active);
  });

  /* Data files are JSON and cannot interpolate, so a link that should point at
     a value from site.json carries a {token} instead. Today only
     {membershipUrl} uses this — membership signup still lives on the old Wix
     site, so the destination will change at cutover and is written once. */
  eleventyConfig.addFilter('resolveUrl', (href, site) =>
    typeof href === 'string' && href.startsWith('{') && href.endsWith('}')
      ? (site[href.slice(1, -1)] || '#')
      : href
  );

  /* On the page a link points at, the site links to an anchor rather than
     reloading itself: events.html#past becomes #past on events.html. */
  eleventyConfig.addFilter('selfLink', (href, selfPage) =>
    selfPage && href.startsWith(selfPage + '#') ? href.slice(selfPage.length) : href
  );

  /* Initials for a team member with no headshot yet -- src/meet-the-team.html
     prints them over the card's gradient instead of an <img> pointing at a
     file that is not there. First and last initial, except for a one-word
     name, where taking the first and last word gives the same letter twice
     ("MM" for "Madonna"). Splitting on runs of whitespace rather than a
     single space means a stray double space in team.json cannot produce an
     empty segment and drop a letter. */
  eleventyConfig.addFilter('initials', (name) => {
    const parts = String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    const first = parts[0][0];
    const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (first + last).toUpperCase();
  });

  eleventyConfig.setServerOptions({ domDiff: false });

  /* src/posts/posts.11tydata.js keeps a URL registry on globalThis to fail
     the build on a duplicate output path. `npm run dev` reuses one process
     across rebuilds, so without a reset a post that got renamed or deleted
     would leave a stale entry and wrongly fail the next rebuild. Clearing it
     here, once per build, keeps the guard scoped to what actually collides
     within a single build. */
  eleventyConfig.on('eleventy.before', () => {
    globalThis.__postSlugs = new Map();
  });

  /* An explicit collection per type, not `tags`: Eleventy reads `tags` for
     collection membership before eleventyComputed resolves, so a computed
     `tags` value is invisible to it -- and a static one on posts.11tydata.js
     would apply to every post under src/posts/, sweeping all post types into
     a single collection. Filtering by `type` here, after all data is
     available, keys membership on the field that actually varies per post.
     Ordering is explicit for the same reason `tags` needed to be: no post
     sets Eleventy's reserved `date` key (a display string like "Jul 10"
     isn't parseable, see posts.11tydata.js), so without an explicit sort here
     these collections would order by file mtime instead of publish date. */
  for (const [key, type] of Object.entries(POST_TYPES)) {
    eleventyConfig.addCollection(type.collection, (api) =>
      sortedPostsOfType(api.getFilteredByGlob('src/posts/*.html'), key));
  }

  return {
    dir: {
      input: 'src',
      output: '_site',
      includes: '_includes',
      data: '_data'
    },
    templateFormats: ['html'],
    htmlTemplateEngine: 'njk'
  };
}
