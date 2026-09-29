import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderInline, escText, escAttr, safeUrl, makeExcerpt,
  buildCardView, buildPostView, coverPath, postFilename
} from '../lib/render-blocks.mjs';

/* These URLs were all mangled before 35e75f6: typo() rewrote the apostrophe
   and the ellipsis, and the bold/italic pass turned a '*' in a path into an
   <em> inside the href. Parity could not catch it, because both renderers were
   wrong together. */
for (const url of [
  "https://e.com/o'brien",
  'https://e.com/a...b',
  'https://e.com/a/*b*c/d',
  'https://e.com/a--b',
  'https://e.com/s?a=1&b=2'
]) {
  test(`a link survives rendering: ${url}`, () => {
    const href = renderInline(`[x](${url})`).match(/href="([^"]*)"/)[1];
    assert.equal(href, escAttr(url));
  });
}

test('markers still render around a link', () => {
  assert.equal(
    renderInline('**b** and [l](https://e.com) and *i*'),
    '<strong>b</strong> and <a href="https://e.com" target="_blank" rel="noopener">l</a> and <em>i</em>'
  );
});

test('markers inside a link label render too', () => {
  assert.equal(
    renderInline('[**bold label**](https://e.com/p)'),
    '<a href="https://e.com/p" target="_blank" rel="noopener"><strong>bold label</strong></a>'
  );
});

test('a link label gets typography, and the href stays untouched', () => {
  const rendered = renderInline("[Shira's post](https://e.com)");
  assert.match(rendered, /&rsquo;/);
  assert.equal(rendered.match(/href="([^"]*)"/)[1], 'https://e.com');
});

test('a dangerous scheme collapses', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '#');
  assert.equal(safeUrl('data:text/html,x'), '#');
  assert.equal(safeUrl('images/a.jpg'), 'images/a.jpg');
});

test('text is escaped before typography runs', () => {
  assert.equal(escText('ampersand & <script>'), 'ampersand &amp; &lt;script&gt;');
  assert.equal(escText("don't"), 'don&rsquo;t');
});

test('an excerpt is plain text, never markup', () => {
  assert.equal(makeExcerpt('[Alessia Russo](https://e.com) is an investor', 155), 'Alessia Russo is an investor');
});

// Regression for the round-3 fix report, CRITICAL 2: buildCardView had no
// fallback for a blank title, unlike buildPostView, even though the editor's
// own help text tells an author to leave it blank. A post with no title must
// not publish an untitled card.
test('a post with no title falls back to the name-based title, on both cards', () => {
  const view = buildCardView({ slug: 's', name: 'Alessia Russo', blocks: [] });
  assert.equal(view.titleHtml, 'FinTech Female Fridays: Meet Alessia Russo');
  assert.equal(view.homeTitleHtml, 'FinTech Female Fridays: Meet Alessia Russo');
});

test('homeTitle still overrides the name-based fallback when title is also blank', () => {
  const view = buildCardView({ slug: 's', name: 'Alessia Russo', homeTitle: 'Short', blocks: [] });
  assert.equal(view.homeTitleHtml, 'Short');
});

// Regression for IMPORTANT 3: blank card fields used to leave a dangling
// ' · ' separator and an empty, still-bordered .post-tag chip. Joining must
// drop blanks the way metaLine() does for the post page's byline.
test('blank card fields leave no dangling separators', () => {
  const view = buildCardView({ slug: 's', name: 'No Meta', blocks: [] });
  // tagHtml now resolves to the type's fallback rather than '' -- see the
  // card/page tag-chain fix below -- but the joined fields still drop blanks
  // cleanly.
  assert.equal(view.tagHtml, 'Fintech Female Fridays');
  assert.equal(view.gridFootHtml, '');
  assert.equal(view.featuredMetaHtml, '');
});

test('a blank read time drops the word "read" entirely', () => {
  const view = buildCardView({ slug: 's', name: 'N', displayDate: 'Jul 10', blocks: [] });
  assert.equal(view.featuredMetaHtml, 'Jul 10');
  assert.ok(!view.featuredMetaHtml.includes('read'));
});

test('a full set of card fields joins with the middle dot and no dangling parts', () => {
  const view = buildCardView({
    slug: 's', name: 'N', author: 'Manvir Singh', displayDate: 'Jul 10', readTime: '4 min', blocks: []
  });
  assert.equal(view.gridFootHtml, 'Manvir Singh · Jul 10 · 4 min');
  assert.equal(view.featuredMetaHtml, 'Jul 10 · 4 min read');
});

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

// Finding 3 of the final review: buildPostView already fell back to the
// type's tagFallback (a news post's PAGE shows "Jobs & Happenings"), but
// buildCardView stopped one step short, so the same post's CARD showed no
// chip. The two must agree -- see the comment on buildCardView's tagLine.
test('a news post card with no tag at all falls back to the type', () => {
  const card = buildCardView({ type: 'post', title: 'A Recap' });
  assert.equal(card.tagHtml, 'Jobs &amp; Happenings');
});

test('an fff card with role and company is unaffected by the type fallback', () => {
  const card = buildCardView({ type: 'fff', name: 'X', role: 'Data', company: 'Indagari' });
  assert.equal(card.tagHtml, 'Data · Indagari');
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

/* The Fintech Female Fridays archive is older than the intro field: 77 of the
   261 migrated posts open straight on an interview question and carry no intro
   at all. The meta description used to be sliced from the intro alone, so
   every one of those pages shipped <meta name="description" content="">. */
test('a post with no intro takes its meta description from the excerpt', () => {
  const view = buildPostView({
    type: 'fff',
    name: 'Ashley Paston',
    excerpt: 'My time at McKinsey was invaluable to my investor skill set today.'
  });
  assert.match(view.descAttr, /My time at McKinsey/);
});

test('an intro still wins over the excerpt for the meta description', () => {
  const view = buildPostView({
    type: 'fff',
    name: 'Shira Amrany',
    intro: 'The intro that should be used.',
    excerpt: 'The excerpt that should not.'
  });
  assert.match(view.descAttr, /The intro that should be used/);
});
