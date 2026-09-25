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
  /* The renderer and the post-file format, served so the editor imports the
     same modules the build uses instead of carrying a second copy. */
  eleventyConfig.addPassthroughCopy({ lib: 'lib' });
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

  eleventyConfig.setServerOptions({ domDiff: false });

  /* src/posts/posts.11tydata.js keeps a slug registry on globalThis to fail
     the build on a duplicate permalink. `npm run dev` reuses one process
     across rebuilds, so without a reset a post that got renamed or deleted
     would leave a stale entry and wrongly fail the next rebuild against a
     slug that no longer exists. Clearing it here, once per build, keeps the
     guard scoped to what actually collides within a single build. */
  eleventyConfig.on('eleventy.before', () => {
    globalThis.__postSlugs = new Map();
  });

  /* An explicit collection, not `tags`: Eleventy reads `tags` for collection
     membership before eleventyComputed resolves, so a computed `tags` value
     is invisible to it -- and a static one on posts.11tydata.js would apply
     to every post under src/posts/, sweeping future non-FFF post types (see
     Phase 6) into this collection too. Filtering by `type` here, after all
     data is available, keys membership on the field that actually varies per
     post. Ordering is explicit for the same reason `tags` needed to be: no
     post sets Eleventy's reserved `date` key (a display string like "Jul 10"
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
