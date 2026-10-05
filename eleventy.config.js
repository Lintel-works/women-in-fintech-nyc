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
import { buildPostsIndex } from './lib/posts-index.mjs';

export default function (eleventyConfig) {
  // The editor is a standalone app. Keep Eleventy out of it entirely, or its
  // markup would be parsed as a template and its output path rewritten.
  eleventyConfig.ignores.add('src/admin/**');

  eleventyConfig.addPassthroughCopy({ 'src/admin': 'admin' });
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
  /* The editor needs two public Clerk values in the browser. /admin is
     rendered statically and copied verbatim, so there is no request-time
     hook to read process.env from -- the values are written into a generated
     file at build time instead. The consequence worth knowing: rotating
     either key requires a redeploy, not just an environment variable edit.

     Failing the build when they are absent is deliberate. A deployed editor
     with no publishable key renders a sign-in form that can never succeed,
     and the error surfaces in the browser console of whoever happens to try
     it -- which is nobody, until an author needs to publish. */
  const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  const clerkFrontendApiUrl = process.env.CLERK_FRONTEND_API_URL;
  if (!clerkPublishableKey || !clerkFrontendApiUrl) {
    throw new Error(
      'CLERK_PUBLISHABLE_KEY and CLERK_FRONTEND_API_URL must be set at build time; /admin cannot sign anyone in without them.'
    );
  }
  /* The loader lives here rather than in index.html because Clerk serves its
     browser bundles from the instance's OWN Frontend API host, which differs
     between the development and production instances. Hardcoding a public CDN
     in the markup would load a bundle pointed at the wrong instance, which
     presents as a sign-in form that renders and then rejects every
     credential.

     Registered as a .html template with an explicit permalink, not as a bare
     .js path: templateFormats is ['html'], so the virtual path's extension is
     what selects an engine, and a .js extension would not be emitted as text.
     The engine is switched off so a Nunjucks delimiter inside a key or URL
     cannot be interpreted. */
  eleventyConfig.addTemplate(
    'admin-clerk-config.html',
    `window.CLERK_PUBLISHABLE_KEY = ${JSON.stringify(clerkPublishableKey)};\n` +
    `window.CLERK_FRONTEND_API_URL = ${JSON.stringify(clerkFrontendApiUrl)};\n` +
    `(function () {\n` +
    `  var host = ${JSON.stringify(clerkFrontendApiUrl)}.replace(/\\/$/, '');\n` +
    `  [host + '/npm/@clerk/ui@1/dist/ui.browser.js',\n` +
    `   host + '/npm/@clerk/clerk-js@6/dist/clerk.browser.js'].forEach(function (src) {\n` +
    `    var tag = document.createElement('script');\n` +
    `    tag.src = src; tag.defer = true; tag.crossOrigin = 'anonymous';\n` +
    `    tag.setAttribute('data-clerk-publishable-key', window.CLERK_PUBLISHABLE_KEY);\n` +
    `    document.head.appendChild(tag);\n` +
    `  });\n` +
    `}());\n`,
    { permalink: 'admin/clerk-config.js', templateEngineOverride: false }
  );
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

  /* Every post of every type, in the shape the editor's post-list drawer
     reads (src/posts-index.html emits it as posts-index.json). Built here, off
     the same glob as the per-type collections, so the list cannot drift from
     what the site actually published. */
  eleventyConfig.addCollection('postsIndex', (api) =>
    buildPostsIndex(api.getFilteredByGlob('src/posts/*.html')));

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
