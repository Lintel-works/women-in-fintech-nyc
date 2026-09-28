import { test } from 'node:test';
import assert from 'node:assert/strict';
import eleventyConfigFn from '../eleventy.config.js';

/* FIX 7 (final wave): the whole lib/ directory used to be passed through
   verbatim, which meant lib/session.mjs (cookie signing), lib/password.mjs
   (the scrypt check) and lib/github.mjs (the commit machinery) were served
   publicly alongside the four modules the editor actually imports. A fake
   eleventyConfig captures every addPassthroughCopy mapping so this can be
   asserted without running a full build. */
function makeFakeEleventyConfig() {
  const passthroughs = [];
  const base = {
    ignores: { add() {} },
    addPassthroughCopy(mapping) { passthroughs.push(mapping); },
    passthroughs
  };
  // A Proxy so any other eleventyConfig.* method this file calls (which
  // Eleventy version this repo happens to use is not this test's concern)
  // is a harmless no-op returning a chainable fake, rather than this test
  // having to enumerate Eleventy's entire API surface.
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => new Proxy(() => {}, { get: () => () => {}, apply: () => undefined });
    }
  });
}

test('only the four browser-imported lib/ modules are passed through', () => {
  const fake = makeFakeEleventyConfig();
  eleventyConfigFn(fake);

  const libSources = fake.passthroughs
    .flatMap((mapping) => Object.keys(mapping))
    .filter((key) => key.startsWith('lib/') || key === 'lib');

  assert.ok(!libSources.includes('lib'), 'the whole lib/ directory must not be passed through wholesale');
  assert.deepEqual(
    libSources.sort(),
    ['lib/post-file.mjs', 'lib/post-types.mjs', 'lib/render-blocks.mjs', 'lib/slug.mjs'].sort()
  );
  for (const secret of ['lib/session.mjs', 'lib/password.mjs', 'lib/github.mjs', 'lib/github-auth.mjs', 'lib/publish.mjs', 'lib/publish-validate.mjs']) {
    assert.ok(!libSources.includes(secret), `${secret} must not be served publicly`);
  }
});
