import { test } from 'node:test';
import assert from 'node:assert/strict';
import eleventyConfigFn from '../eleventy.config.js';

/* The config now refuses to load without the Clerk build variables, so every
   test that constructs it needs them. The two tests that exercise the
   missing-variable path clear them explicitly. */
process.env.CLERK_PUBLISHABLE_KEY ??= 'pk_test_default';
process.env.CLERK_FRONTEND_API_URL ??= 'https://default.clerk.accounts.dev';

/* FIX 7 (final wave): the whole lib/ directory used to be passed through
   verbatim, which meant lib/session.mjs (cookie signing), lib/password.mjs
   (the scrypt check) and lib/github.mjs (the commit machinery) were served
   publicly alongside the five modules the editor and events page actually import. A fake
   eleventyConfig captures every addPassthroughCopy mapping so this can be
   asserted without running a full build. */
function makeFakeEleventyConfig() {
  const passthroughs = [];
  const filters = {};
  const base = {
    ignores: { add() {} },
    addPassthroughCopy(mapping) { passthroughs.push(mapping); },
    addFilter(name, fn) { filters[name] = fn; },
    templates: [],
    addTemplate(path, content, data) { this.templates.push({ path, content, data }); },
    passthroughs,
    filters
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

test('only the five browser-imported lib/ modules are passed through', () => {
  const fake = makeFakeEleventyConfig();
  eleventyConfigFn(fake);

  const libSources = fake.passthroughs
    .flatMap((mapping) => Object.keys(mapping))
    .filter((key) => key.startsWith('lib/') || key === 'lib');

  assert.ok(!libSources.includes('lib'), 'the whole lib/ directory must not be passed through wholesale');
  assert.deepEqual(
    libSources.sort(),
    ['lib/event-entry.mjs', 'lib/post-file.mjs', 'lib/post-types.mjs', 'lib/render-blocks.mjs', 'lib/slug.mjs'].sort()
  );
  for (const secret of ['lib/clerk-jwt.mjs', 'lib/github.mjs', 'lib/github-auth.mjs', 'lib/publish.mjs', 'lib/publish-validate.mjs']) {
    assert.ok(!libSources.includes(secret), `${secret} must not be served publicly`);
  }
});


/* src/meet-the-team.html prints a member's initials over the card gradient
   when there is no headshot on disk yet. This lived in the template as
   parts[0][0] + parts[last][0], which reads the same character twice for a
   one-word name and drops a letter when a stray double space leaves an empty
   segment. Neither case exists in team.json today, which is exactly why it
   needs a test rather than an eye. */
function initialsFilter() {
  const fake = makeFakeEleventyConfig();
  eleventyConfigFn(fake);
  return fake.filters.initials;
}

test('initials take the first and last name', () => {
  const initials = initialsFilter();
  assert.equal(initials('Shana Leyva'), 'SL');
  assert.equal(initials('Elsie Russell Brown'), 'EB');
});

test('a one-word name gives one letter, not the same one twice', () => {
  assert.equal(initialsFilter()('Madonna'), 'M');
});

test('stray whitespace in a name does not eat a letter', () => {
  const initials = initialsFilter();
  assert.equal(initials('  Shana   Leyva  '), 'SL');
  assert.equal(initials('Shana Leyva '), 'SL');
});

test('a blank name yields nothing rather than throwing', () => {
  const initials = initialsFilter();
  assert.equal(initials(''), '');
  assert.equal(initials(null), '');
  assert.equal(initials(undefined), '');
});

/* The publishable key is public by design, but it still has to REACH the
   browser: /admin is rendered statically, so a key read from process.env at
   request time would never arrive. Eleventy writes it at build time, which
   also means rotating it needs a redeploy -- unlike every other variable in
   this project. */
test('Clerk browser configuration is generated at build time', () => {
  const saved = { ...process.env };
  process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_abc';
  process.env.CLERK_FRONTEND_API_URL = 'https://example.clerk.accounts.dev';
  try {
    const fake = makeFakeEleventyConfig();
    eleventyConfigFn(fake);
    const generated = fake.templates.find((entry) => entry.data?.permalink === 'admin/clerk-config.js');
    assert.ok(generated, 'a template must emit admin/clerk-config.js');
    assert.match(generated.content, /pk_test_abc/);
    assert.match(generated.content, /example\.clerk\.accounts\.dev/);
  } finally {
    process.env = saved;
  }
});

test('a missing publishable key fails the build rather than shipping a dead editor', () => {
  const saved = { ...process.env };
  delete process.env.CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_FRONTEND_API_URL;
  try {
    const fake = makeFakeEleventyConfig();
    assert.throws(() => eleventyConfigFn(fake), /CLERK_PUBLISHABLE_KEY/);
  } finally {
    process.env = saved;
  }
});
