import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { serializePost, parsePost } from '../lib/post-file.mjs';
import { buildCardView } from '../lib/render-blocks.mjs';
import { POST_TYPES, typeOf } from '../lib/post-types.mjs';

test('serializes a minimal post', () => {
  const text = serializePost({
    name: 'Shira Amrany',
    slug: 'shira-amrany',
    title: 'FinTech Female Fridays: Meet Shira Amrany',
    tag: 'Fintech Female Fridays',
    role: 'Data & Analytics',
    company: 'Indagari',
    linkedin: '',
    author: 'Manvir Singh',
    displayDate: 'Jul 10',
    isoDate: '2026-07-10',
    readTime: '4 min',
    coverPath: 'images/fff-shira-amrany.jpg',
    intro: 'One line.',
    blocks: []
  });
  assert.ok(text.startsWith('---\n'));
  assert.ok(text.endsWith('---\n'));
  assert.match(text, /^name: "Shira Amrany"$/m);
  assert.match(text, /^slug: "shira-amrany"$/m);
  assert.match(text, /^role: "Data & Analytics"$/m);
});

test('a multi-line value becomes a literal block, indented, never trailing space', () => {
  // Trailing space mid-value (not at the string's own start/end, which must
  // stay whitespace-free for the literal block to be usable at all -- see
  // the round-2 fix report) still must not survive per line.
  const text = serializePost({ slug: 's', intro: 'One. \n\nTwo.', blocks: [] });
  assert.match(text, /^intro: \|-\n  One\.\n\n  Two\.$/m);
});

test('every block type round-trips through the emitter', () => {
  const text = serializePost({
    slug: 's',
    intro: 'i',
    blocks: [
      { type: 'qa', q: 'Q?', a: 'A one.\n\nA two.' },
      { type: 'heading', text: 'H' },
      { type: 'paragraph', text: 'P' },
      { type: 'quote', text: 'Quoted', attrib: 'Someone' },
      { type: 'image', src: 'images/x.jpg', alt: 'Alt' },
      { type: 'list', ordered: false, items: ['one', 'two'] }
    ]
  });
  assert.match(text, /^ {2}- type: qa$/m);
  assert.match(text, /^ {4}a: \|-\n {6}A one\.\n\n {6}A two\.$/m);
  assert.match(text, /^ {4}ordered: false$/m);
  assert.match(text, /^ {6}- "one"$/m);
});

const FULL = {
  name: "D'aundra Lewis",
  slug: 'daundra-lewis',
  type: 'fff',
  title: 'FinTech Female Fridays: Meet D\'aundra Lewis',
  tag: 'Fintech Female Fridays',
  role: 'Compliance',
  company: 'Financial Crime',
  linkedin: 'https://www.linkedin.com/in/daundralewis/',
  author: 'Manvir Singh',
  displayDate: 'Jul 3',
  isoDate: '2026-07-03',
  readTime: '5 min',
  gradient: 'g1',
  coverPath: 'images/fff-daundra-lewis.jpg',
  intro: 'A line.\n\nAnother "quoted" line.',
  blocks: [
    { type: 'qa', q: 'Q?', a: 'One.\n\nTwo.' },
    { type: 'heading', text: 'More about D\'aundra' },
    { type: 'list', ordered: false, items: ['6:00am Wakeup', 'a "quoted" item'] },
    { type: 'image', src: 'images/x.jpg', alt: '' }
  ]
};

test('round trips a full post', () => {
  assert.deepEqual(parsePost(serializePost(FULL)), FULL);
});

test('round trips emoji and non-ASCII', () => {
  const post = { slug: 's', intro: 'Reels (not TikTok -- grown-up 😉)', blocks: [] };
  assert.deepEqual(parsePost(serializePost(post)), post);
});

test('a line of three dashes inside the body does not end the front matter', () => {
  const post = { slug: 's', intro: 'Before.\n\n---\n\nAfter.', blocks: [] };
  assert.deepEqual(parsePost(serializePost(post)), post);
});

test('reads a file with CRLF endings and a BOM', () => {
  const text = '﻿' + serializePost(FULL).replace(/\n/g, '\r\n');
  assert.deepEqual(parsePost(text), FULL);
});

test('a trailing space in a value does not survive as meaning', () => {
  const post = { slug: 's', intro: 'Line one. \n\nLine two.', blocks: [] };
  assert.equal(parsePost(serializePost(post)).intro, 'Line one.\n\nLine two.');
});

test('refuses a file it does not understand, naming the line', () => {
  const bad = '---\nslug: s\nweird: [1, 2]\nblocks:\n---\n';
  assert.throws(() => parsePost(bad), /line 3/);
});

test('refuses a file with no front matter', () => {
  assert.throws(() => parsePost('<html></html>'), /front matter/i);
});

const POSTS = fs.readdirSync('src/posts').filter((f) => f.endsWith('.html'));

// The seven posts migrated from Wix were written with the old BARE-key
// convention (slug/type/tag/coverPath/gradient unquoted) -- serializePost no
// longer writes that way (see the FIX 1 comment on yamlValue), so a fresh
// serialize of a re-parsed post now differs from the committed bytes on
// those lines alone. That diff is cosmetic and expected, not a regression:
// what must still hold is that the post PARSES to the same object it always
// did, and that re-serializing it and parsing THAT text again reaches a
// fixed point (nothing is lost or reinterpreted on a second round trip).
test('every committed post parses, and round-trips to a stable parse', () => {
  assert.ok(POSTS.length >= 7, 'expected the migrated posts to be present');
  for (const file of POSTS) {
    const original = fs.readFileSync(path.join('src/posts', file), 'utf8');
    const parsedOriginal = parsePost(original);
    const reserialized = serializePost(parsedOriginal);
    assert.deepEqual(parsePost(reserialized), parsedOriginal, file);
  }
});

/* gray-matter is what Eleventy reads front matter with; it arrives as an
   Eleventy dependency, not one of ours. If these two ever disagree about a
   value, the editor is showing something the site will not publish. */
test('parsePost agrees with the reader the build uses', () => {
  for (const file of POSTS) {
    const text = fs.readFileSync(path.join('src/posts', file), 'utf8');
    const theirs = matter(text).data;
    const ours = parsePost(text);
    for (const key of Object.keys(theirs)) {
      assert.deepEqual(ours[key], theirs[key], `${file}: ${key}`);
    }
  }
});

test('a whitespace-only value round trips unchanged', () => {
  const post = { slug: 's', intro: '   ', blocks: [] };
  assert.deepEqual(parsePost(serializePost(post)), post);
});

test('a value ending in a blank line round trips unchanged', () => {
  const post = { slug: 's', intro: 'A.\n\nB.\n\n', blocks: [] };
  assert.deepEqual(parsePost(serializePost(post)), post);
});

test('a bare scalar of "true" stays a string, not a boolean', () => {
  const post = { slug: 's', intro: 'i', blocks: [{ type: 'true' }] };
  assert.deepEqual(parsePost(serializePost(post)), post);
});

test('a top-level bare field of "true" stays a string, not a boolean', () => {
  const post = { slug: 's', type: 'true', intro: 'i', blocks: [] };
  assert.deepEqual(parsePost(serializePost(post)), post);
});

test('a list block still round trips with ordered as a real boolean', () => {
  const post = {
    slug: 's',
    intro: 'i',
    blocks: [{ type: 'list', ordered: false, items: ['one', 'two'] }]
  };
  assert.deepEqual(parsePost(serializePost(post)), post);
});

test('parsePost agrees with gray-matter on a value ending in a blank line', () => {
  const post = { slug: 's', intro: 'A.\n\nB.\n\n', blocks: [] };
  const text = serializePost(post);
  assert.deepEqual(parsePost(text).intro, matter(text).data.intro);
});

// Fails clearly (naming the file) instead of letting a js-yaml throw crash
// the whole test run -- a malformed post file must not take the build down.
function readWithGrayMatter(text, label) {
  try {
    return matter(text).data;
  } catch (err) {
    assert.fail(`gray-matter could not read ${label}: ${err.message}`);
  }
}

test('a value that is only whitespace across several lines round trips unchanged', () => {
  const post = { slug: 's', intro: ' \n \n ', blocks: [] };
  const text = serializePost(post);
  assert.deepEqual(parsePost(text), post);
  assert.deepEqual(readWithGrayMatter(text, 'whitespace-only value').intro, post.intro);
});

test('a value with leading whitespace on its first line round trips unchanged', () => {
  const post = { slug: 's', intro: '  leading\n\nmore', blocks: [] };
  const text = serializePost(post);
  assert.deepEqual(parsePost(text), post);
  assert.deepEqual(readWithGrayMatter(text, 'leading-whitespace value').intro, post.intro);
});

// Regression for the round-3 fix report, CRITICAL 1: every top-level key
// used to get indent 0 unless it was 'intro' or 'excerpt', so a multi-line
// value in any other field (metaDescription is a textarea in the editor)
// produced an unindented `|-` block -- invalid YAML that made gray-matter
// throw and took the whole build down. The fix pads every top-level key's
// literal block the same way; these fields must all round trip and must all
// stay readable by gray-matter, the reader Eleventy actually builds with.
for (const field of ['metaDescription', 'ogTitle', 'title', 'name']) {
  test(`a multi-line ${field} does not break the build`, () => {
    const value = 'Line one.\nLine two.';
    const post = { slug: 's', intro: 'i', blocks: [], [field]: value };
    const text = serializePost(post);
    const theirs = readWithGrayMatter(text, `multi-line ${field}`);
    const ours = parsePost(text);
    assert.equal(ours[field], value, `${field} round trip`);
    assert.equal(theirs[field], value, `${field} as gray-matter reads it`);
    assert.equal(theirs[field], ours[field], `${field}: readers agree`);
  });
}

// Regression for the round-4 fix report and for the final-wave FIX 1: slug,
// type, tag, coverPath and gradient used to be written as BARE (unquoted)
// scalars, so a multi-line value in any of them emitted the same invalid,
// unindented YAML the metaDescription/ogTitle/title/name fix above closed --
// and a single-line value containing something like ": " or a leading
// special character broke js-yaml's parse outright (see the tests further
// below). BARE is gone: every field, these five included, now goes through
// yamlValue exactly like any other, which is what makes both problems
// impossible rather than separately patched.
for (const field of ['slug', 'type', 'tag', 'coverPath', 'gradient']) {
  test(`a multi-line ${field} (formerly a BARE key) does not break the build`, () => {
    const value = 'Line one.\nLine two.';
    const post = { slug: 's', intro: 'i', blocks: [], [field]: value };
    const text = serializePost(post);
    const theirs = readWithGrayMatter(text, `multi-line ${field}`);
    const ours = parsePost(text);
    assert.equal(ours[field], value, `${field} round trip`);
    assert.equal(theirs[field], value, `${field} as gray-matter reads it`);
    assert.equal(theirs[field], ours[field], `${field}: readers agree`);
  });
}

// A list item passes indent 0 to yamlValue by construction (see yamlBlocks),
// and was only ever single-line by UI convention, not by construction. A
// multi-line item must fall back to a JSON string, not an unindented block.
test('a multi-line list item does not break the build', () => {
  const value = 'Line one.\nLine two.';
  const post = { slug: 's', intro: 'i', blocks: [{ type: 'list', ordered: false, items: [value, 'one line'] }] };
  const text = serializePost(post);
  const theirs = readWithGrayMatter(text, 'multi-line list item');
  const ours = parsePost(text);
  assert.deepEqual(ours.blocks[0].items, [value, 'one line'], 'list item round trip');
  assert.deepEqual(theirs.blocks[0].items, [value, 'one line'], 'list item as gray-matter reads it');
  assert.deepEqual(theirs.blocks[0].items, ours.blocks[0].items, 'list item: readers agree');
});

test('a value that starts with a blank line round trips unchanged', () => {
  const post = { slug: 's', intro: '\n\nA', blocks: [] };
  const text = serializePost(post);
  assert.deepEqual(parsePost(text), post);
  assert.deepEqual(readWithGrayMatter(text, 'leading-blank-line value').intro, post.intro);
});

// FIX 1 (final wave): tag and coverPath are free-text fields in the shipped
// UI, reachable from Import JSON with no sanitising. Before BARE was removed,
// each of these values, written unquoted, either threw in js-yaml (dying the
// whole build with no developer to see it) or silently parsed as the wrong
// YAML type. Every one must now round trip through serialize -> gray-matter
// (the build's own reader) -> parsePost unchanged.
const BREAKING_VALUES = [
  'Fintech: The Future',   // ": " opens a mapping mid-scalar
  '# not a comment',       // leading # would start a comment if unquoted
  '*star',                 // leading * is an alias indicator
  '>fold',                 // leading > is a folded block indicator
  '|lit',                  // leading | is a literal block indicator
  '!bang',                 // leading ! is a tag indicator
  '- item',                // leading "- " reads as a sequence entry
  '`backtick`',
  '"already quoted'
];
for (const value of BREAKING_VALUES) {
  test(`a tag of ${JSON.stringify(value)} round trips through gray-matter`, () => {
    const post = { slug: 's', intro: 'i', tag: value, blocks: [] };
    const text = serializePost(post);
    const theirs = readWithGrayMatter(text, `tag ${JSON.stringify(value)}`);
    assert.equal(theirs.tag, value, 'gray-matter reads the same tag back');
    assert.equal(parsePost(text).tag, value, 'parsePost reads the same tag back');
  });
}

test('a title of "False" does not become a boolean slug', () => {
  // Before BARE was removed, an untouched slug field derived from a title of
  // "False" wrote `slug: false` unquoted -- js-yaml parses that as the
  // literal boolean, and src/posts/posts.11tydata.js, which expects a
  // string, throws on it.
  const post = { slug: 'false', title: 'False', intro: 'i', blocks: [] };
  const text = serializePost(post);
  const theirs = readWithGrayMatter(text, 'title False');
  assert.equal(theirs.slug, 'false');
  assert.equal(typeof theirs.slug, 'string');
  assert.equal(parsePost(text).slug, 'false');
});

test('a coverPath with a space round trips through gray-matter', () => {
  const post = { slug: 's', intro: 'i', coverPath: 'images/my cover.jpg', blocks: [] };
  const text = serializePost(post);
  const theirs = readWithGrayMatter(text, 'coverPath with a space');
  assert.equal(theirs.coverPath, 'images/my cover.jpg');
  assert.equal(parsePost(text).coverPath, 'images/my cover.jpg');
});

test('every post declares a known type and a gradient', () => {
  for (const file of POSTS) {
    const post = parsePost(fs.readFileSync(path.join('src/posts', file), 'utf8'));
    assert.ok(Object.keys(POST_TYPES).includes(post.type), `${file} type`);
    assert.match(post.gradient, /^g[1-7]$/, `${file} gradient`);
  }
});

test('permalinks are unique, because two posts cannot share one output URL', () => {
  const permalinks = POSTS.map((f) => {
    const post = parsePost(fs.readFileSync(path.join('src/posts', f), 'utf8'));
    return typeOf(post).prefix + post.slug;
  });
  assert.equal(new Set(permalinks).size, permalinks.length,
    `duplicate permalink among: ${permalinks.join(', ')}`);
});

// FIX 6 (final wave): U+2028/U+2029 (LINE/PARAGRAPH SEPARATOR) are routine in
// text pasted from Word. gray-matter reads them fine, but parsePost's own
// regexes treat them as line terminators (an ECMAScript rule) and used to
// throw on a value containing one, making an already-published post
// permanently unopenable. Stripped on write (yamlValue) and, belt-and-braces,
// on read (parsePost's own normalisation) so a legacy or hand-edited file
// with a raw one still opens.
test('U+2028/U+2029 in a value do not break serializing or reopening', () => {
  const post = { slug: 's', intro: 'Before after', tag: 'A B', blocks: [] };
  const text = serializePost(post);
  assert.ok(!text.includes(' ') && !text.includes(' '), 'stripped on write');
  const reopened = parsePost(text);
  assert.equal(reopened.intro, 'Before after');
  assert.equal(reopened.tag, 'A B');
  readWithGrayMatter(text, 'U+2028/U+2029 value'); // must not throw
});

test('parsePost tolerates a raw U+2028 in a legacy file it did not write', () => {
  const text = '---\nslug: "s"\ntag: "a b"\nblocks:\n---\n';
  assert.equal(parsePost(text).tag, 'a b');
});

test('a card typesets the way the post page does', () => {
  const card = buildCardView(parsePost(fs.readFileSync('src/posts/daundra-lewis.html', 'utf8')));
  assert.equal(card.href, 'fff-daundra-lewis.html');
  assert.match(card.titleHtml, /D&rsquo;aundra/);
  assert.ok(!card.excerptHtml.includes(' -- '), 'dashes are typeset');
});

test('cardTag overrides the role line, because one card does not use the role', () => {
  const shira = parsePost(fs.readFileSync('src/posts/shira-amrany.html', 'utf8'));
  assert.equal(buildCardView(shira).tagHtml, 'Data · Indagari');
  assert.notEqual(buildCardView(shira).tagHtml, 'Data & Analytics · Indagari');
});

test('homeTitle round trips and overrides the home card title, falling back to title otherwise', () => {
  const post = { slug: 's', title: 'Full Title', homeTitle: 'Short Title', blocks: [] };
  const text = serializePost(post);
  assert.equal(parsePost(text).homeTitle, 'Short Title');
  assert.equal(buildCardView(post).homeTitleHtml, 'Short Title');

  const noOverride = { slug: 's', title: 'Full Title', blocks: [] };
  assert.equal(buildCardView(noOverride).homeTitleHtml, 'Full Title');
});

test('a slug with an attribute-breaking character does not break out of href', () => {
  const card = buildCardView({ slug: 'x" onmouseover="alert(1)<', title: 't', blocks: [] });
  assert.ok(!card.href.includes('"'), 'href contains a raw quote');
  assert.ok(!card.href.includes('<'), 'href contains a raw angle bracket');
});

test('a name with an attribute-breaking character does not break out of alt', () => {
  const card = buildCardView({ slug: 's', name: 'X" onmouseover="alert(1)', title: 't', blocks: [] });
  assert.ok(!card.nameAttr.includes('"'), 'nameAttr contains a raw quote');
});
