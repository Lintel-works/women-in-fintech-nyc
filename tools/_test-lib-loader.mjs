/* A resolve hook, registered only by tools/editor-unpublish.test.mjs, that
 * rewrites the '/lib/...' specifiers src/admin/editor.js and src/admin/text.js
 * use. Those are server-relative paths -- vercel.json rewrites them to lib/
 * for the deployed site, and the Eleventy dev server does the same locally --
 * so plain Node has nothing to resolve them against. This loader is that
 * rewrite's test-time equivalent: it is the only way to import editor.js
 * outside a browser or a dev server at all.
 */
const LIB_ROOT = new URL('../lib/', import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('/lib/')) {
    const target = new URL(specifier.slice('/lib/'.length), LIB_ROOT);
    return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
}
