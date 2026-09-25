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
