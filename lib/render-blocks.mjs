/* Post rendering: the one implementation.
 *
 * Ported verbatim from the admin editor's own renderer, which has since been
 * deleted: the build renders posts from data and the editor imports this
 * module for its preview, so there is one implementation and nothing to drift
 * against. Served to the browser by a passthrough copy of lib/.
 *
 * Everything here returns ESCAPED, render-ready HTML. Nunjucks autoescapes by
 * default, so every value from buildPostView() must be printed with `| safe`
 * or it gets escaped a second time ("Data &amp; Analytics" -> "&amp;amp;").
 */

import { typeOf, postTitle, coverPathFor } from './post-types.mjs';

const SITE_ORIGIN = 'https://www.nycfintechwomen.com';

/* ------------------------------------------------------------------ escaping */

/* Smart typography. Runs AFTER entity-escaping: it only rewrites ' " - . and >,
   none of which survive in the &amp;/&lt;/&gt; entities produced there, so
   nothing gets double-encoded. Never applied to attributes.
 *
 * This is deliberately lossy and NOT reversible: ' -- ' and ' — ' both become
 * '&mdash;'. Stored post data must therefore be the author's plain source
 * text, never text scraped back out of rendered HTML. */
export function typo(s) {
  return String(s)
    .replace(/(\w)'/g, '$1&rsquo;')
    .replace(/'/g, '&lsquo;')
    .replace(/"(\w)/g, '&ldquo;$1')
    .replace(/"/g, '&rdquo;')
    .replace(/ -- | — /g, ' &mdash; ')
    .replace(/\.\.\./g, '&hellip;')
    // By this point escaping has already turned '>' into '&gt;', so the arrow
    // to match is '-&gt;', not '->'.
    .replace(/-&gt;/g, '&rarr;');
}

export function escText(s) {
  return typo(
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  );
}

/* Plain escape with no typographic rewriting — for alt text and anywhere the
   literal characters matter. */
export function escPlain(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Allowlist: absolute http(s), mailto, in-page anchors, and relative paths.
   Everything else (javascript:, data:, vbscript:) collapses to '#'. */
export function safeUrl(s) {
  const raw = String(s == null ? '' : s).trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^mailto:[^\s]+$/i.test(raw)) return raw;
  if (/^#[\w-]*$/.test(raw)) return raw;
  if (/^\/?[\w.\-~%]+(\/[\w.\-~%]+)*(\.[a-z0-9]+)?([?#][^\s]*)?$/i.test(raw) && raw.indexOf(':') === -1) {
    return raw;
  }
  return '#';
}

/* JSON-LD: stringify, then neutralise < so a "</script>" in the copy cannot
   break out of the script element. */
export function escJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/* --------------------------------------------------------- inline formatting */

/* The bold and italic markers, applied AFTER escaping so they can never
   introduce a tag the author didn't ask for. */
function applyMarkers(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}

/* A deliberately tiny whitelist: **bold** · *italic* · [text](url)
 *
 * Links come out of the text first, before anything else runs, and go back in
 * last. They used to be extracted from the escaped string and spliced in
 * before the marker pass, which put the URL through both of the rewrites that
 * exist here for prose:
 *
 *   typo() ran over it, so .../o'brien became .../o&rsquo;brien and an
 *   ellipsis or a double hyphen in a path was rewritten the same way. The undo
 *   step only reversed &amp;/&lt;/&gt;, so the rest stayed.
 *
 *   the marker pass then ran over the finished anchor, so a '*' anywhere in
 *   the URL turned the middle of the href into an <em>.
 *
 * Both produced a dead link out of a URL the author pasted correctly. A URL is
 * not prose and neither pass belongs anywhere near it. */
export function renderInline(text) {
  const links = [];
  /* NUL cannot survive in authored copy and has no meaning to escText, typo
     or the markers, which is what makes it usable as a placeholder. Any in
     the input is dropped first so a post cannot forge one. */
  const lifted = String(text == null ? '' : text)
    .replace(/\0/g, '')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
      links.push({ label, url });
      return '\0' + (links.length - 1) + '\0';
    });

  return applyMarkers(escText(lifted)).replace(/\0(\d+)\0/g, (_m, index) => {
    const { label, url } = links[Number(index)];
    const href = safeUrl(url);
    const ext = /^https?:\/\//i.test(href);
    return '<a href="' + escAttr(href) + '"' +
      (ext ? ' target="_blank" rel="noopener"' : '') + '>' +
      applyMarkers(escText(label)) + '</a>';
  });
}

/* Split on blank lines so one field can produce several <p>s. */
export function paragraphs(text, className) {
  const cls = className ? ' class="' + className + '"' : '';
  return String(text == null ? '' : text)
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => '<p' + cls + '>' + renderInline(chunk) + '</p>')
    .join('\n      ');
}

/* ------------------------------------------------------------ block renderers */

const BLOCK_RENDERERS = {
  qa(b) {
    if (!String(b.q || '').trim() && !String(b.a || '').trim()) return '';
    return [
      '<div class="qa">',
      '      <p class="qa-q">' + renderInline(b.q) + '</p>',
      '      <div class="qa-a">' + paragraphs(b.a) + '</div>',
      '    </div>'
    ].join('\n      ');
  },
  heading(b) {
    if (!String(b.text || '').trim()) return '';
    return '<h2>' + renderInline(b.text) + '</h2>';
  },
  paragraph(b) {
    return paragraphs(b.text);
  },
  quote(b) {
    if (!String(b.text || '').trim()) return '';
    const cite = String(b.attrib || '').trim()
      ? '\n        <cite>' + escText(b.attrib) + '</cite>'
      : '';
    return [
      '<blockquote class="pullquote">',
      '        <p>' + renderInline(b.text) + '</p>' + cite,
      '      </blockquote>'
    ].join('\n      ');
  },
  image(b) {
    const src = safeUrl(b.src);
    if (!src || src === '#') return '';
    const caption = String(b.caption || '').trim()
      ? '\n        <figcaption>' + escText(b.caption) + '</figcaption>'
      : '';
    return [
      '<figure class="article-figure">',
      '        <img src="' + escAttr(src) + '" alt="' + escAttr(b.alt || '') + '" loading="lazy">' + caption,
      '      </figure>'
    ].join('\n      ');
  },
  list(b) {
    const items = (b.items || [])
      .map((item) => String(item).trim())
      .filter(Boolean);
    if (!items.length) return '';
    const tag = b.ordered ? 'ol' : 'ul';
    return [
      '<' + tag + ' class="article-list">',
      items.map((item) => '        <li>' + renderInline(item) + '</li>').join('\n'),
      '      </' + tag + '>'
    ].join('\n      ');
  }
};

/* The block types this renderer actually knows, derived from the renderer
   itself rather than hand-copied. lib/publish-validate.mjs's KNOWN_BLOCKS
   must equal this set exactly -- see tools/publish-validate.test.mjs -- so
   the two cannot drift apart the way KNOWN_BLOCKS and BLOCK_FIELDS in
   src/admin/types.js already had to be kept in sync by hand. */
export const RENDERABLE_BLOCK_TYPES = Object.keys(BLOCK_RENDERERS);

export function renderBlocks(blocks) {
  return (blocks || [])
    .map((b) => {
      const fn = BLOCK_RENDERERS[b.type];
      return fn ? fn(b) : '';
    })
    .filter(Boolean)
    .join('\n\n      ');
}

/* ----------------------------------------------------------------- utilities */

/* The inline markers, removed. An excerpt is read as plain text -- a meta
   description, a JSON-LD field, a card -- where "[Alessia Russo](https://...)"
   would be printed as written. */
export function stripInline(text) {
  return String(text == null ? '' : text)
    .replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2');
}

/* First ~240 chars on a word boundary. No trailing ellipsis: the existing
   cards on fintech-female-fridays.html end mid-thought without one. */
export function makeExcerpt(text, max) {
  const limit = max || 240;
  const flat = stripInline(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[,;:]$/, '');
}

export function coverPath(post) {
  return post.coverPath || coverPathFor(post.type, post.slug, 'jpg');
}

export function postFilename(post) {
  return typeOf(post).prefix + (post.slug || 'post') + '.html';
}

export function absoluteUrl(p) {
  if (/^https?:\/\//i.test(p)) return p;
  return SITE_ORIGIN + '/' + String(p).replace(/^\//, '');
}

/* "Manvir Singh · Jul 10 · 4 min" — never a dangling separator. */
export function metaLine(post) {
  return [post.author, post.date, post.readTime]
    .map((part) => String(part == null ? '' : part).trim())
    .filter(Boolean)
    .join(' · ');
}

/* --------------------------------------------------------------- view model */

/* Every derivation lives here rather than in the template, so the fallbacks
   (blank title -> "Meet {name}", blank description -> a slice of the intro)
   are testable and stated once. Values are escaped for the context they are
   printed in: *Attr for attributes, *Text for element content. */
export function buildPostView(post) {
  const title = postTitle(post);
  const cover = coverPath(post);
  const desc = String(post.metaDescription || '').trim() || makeExcerpt(post.intro, 155);
  const ogTitle = String(post.ogTitle || '').trim() || title;
  const ogImage = absoluteUrl(safeUrl(post.ogImage) === '#' ? cover : (post.ogImage || cover));
  const canonical = absoluteUrl(postFilename(post));
  const linkedin = safeUrl(post.linkedin);
  const roleLine = [post.role, post.company]
    .map((p) => String(p == null ? '' : p).trim())
    .filter(Boolean)
    .join(' · ');
  const headshotRaw = safeUrl(post.headshot);
  const headshot = headshotRaw && headshotRaw !== '#' ? headshotRaw : cover;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description: desc,
    image: ogImage,
    datePublished: post.isoDate || undefined,
    author: { '@type': 'Person', name: post.author || 'NYC Fintech Women' },
    publisher: {
      '@type': 'Organization',
      name: 'NYC Fintech Women',
      logo: {
        '@type': 'ImageObject',
        url: SITE_ORIGIN + '/images/nyc-fintech-women-logo.png'
      }
    },
    mainEntityOfPage: canonical
  };

  const hasLinkedin = !!linkedin && linkedin !== '#';

  return {
    titleText: escText(title),
    descAttr: escAttr(desc),
    canonicalAttr: escAttr(canonical),
    ogTitleAttr: escAttr(ogTitle),
    ogImageAttr: escAttr(ogImage),
    jsonLd: escJson(jsonLd),

    tagText: escText(post.tag || typeOf(post).tagFallback),
    nameText: escText(post.name || ''),
    nameAttr: escAttr(post.name || ''),
    roleLineText: roleLine ? escText(roleLine) : '',
    metaLineText: escText(metaLine(post)),
    headshotAttr: escAttr(headshot),
    coverAttr: escAttr(cover),

    /* The cover's alt text. A news post has no interviewee to name, so it is
       described by its title instead of shipping an empty alt. */
    coverAltAttr: escAttr(post.name || title),

    /* The news hero prints the byline in two pieces where the FFF hero prints
       one line: the author in .article-who, the date and read time in
       .article-meta. Both drop out entirely when blank. */
    authorText: escText(String(post.author || '').trim()),
    dateMetaText: escText(
      [post.date, post.readTime]
        .map((part) => String(part == null ? '' : part).trim())
        .filter(Boolean)
        .join(' · ')
    ),

    hasLinkedin,
    linkedinAttr: hasLinkedin ? escAttr(linkedin) : '',
    firstNameText: escText(String(post.name || '').split(' ')[0]),

    hasIntro: !!String(post.intro || '').trim(),
    introHtml: renderInline(post.intro),
    blocksHtml: renderBlocks(post.blocks)
  };
}

/* Everything a card prints, escaped for the context it is printed in. The
   cards and the post page share one pipeline, so a name is typeset the same
   way in both -- and a card is never a place where markup can be introduced by
   a post's text. */
export function buildCardView(post) {
  const cover = coverPath(post);
  /* cardTag, then role · company, then the post's own tag, then the type's
     fallback. The first two are interviewee fields, so a news post used to
     resolve at the third and print no chip at all when it was also blank --
     the page fell back to the type (see buildPostView's tagText) and the
     card did not, so the two disagreed. */
  const tagLine = String(post.cardTag || '').trim() ||
    [post.role, post.company].map((p) => String(p == null ? '' : p).trim()).filter(Boolean).join(' · ') ||
    String(post.tag || '').trim() ||
    typeOf(post).tagFallback;
  const excerpt = String(post.excerpt || '').trim() || makeExcerpt(post.intro, 240);
  /* postTitle() is the one resolution both the page and the card use. They
     disagreed once: the editor's help text promises a "Meet {name}" fallback,
     and a card that did not honour it published an empty <h2>. */
  const title = postTitle(post);
  const homeTitle = String(post.homeTitle || '').trim() || title;
  // Joined the way metaLine() joins buildPostView's byline: blanks drop out
  // instead of leaving a dangling ' · ' or an empty tag chip.
  const gridFoot = [post.author, post.displayDate, post.readTime]
    .map((part) => String(part == null ? '' : part).trim())
    .filter(Boolean)
    .join(' · ');
  const readTime = String(post.readTime || '').trim();
  const featuredMeta = [String(post.displayDate || '').trim(), readTime ? readTime + ' read' : '']
    .filter(Boolean)
    .join(' · ');
  return {
    href: escAttr(postFilename(post)),
    coverAttr: escAttr(cover),
    /* The card image's alt text. A news post has no name, so it is described
       by its title rather than shipping an empty alt. */
    nameAttr: escAttr(post.name || title),
    gradient: escAttr(post.gradient || 'g1'),
    tagHtml: escText(tagLine),
    titleHtml: escText(title),
    homeTitleHtml: escText(homeTitle),
    excerptHtml: escText(excerpt),
    authorHtml: escText(post.author),
    dateHtml: escText(post.displayDate),
    readTimeHtml: escText(post.readTime),
    gridFootHtml: escText(gridFoot),
    featuredMetaHtml: escText(featuredMeta),
    badgeText: escText(typeOf(post).cardBadge)
  };
}
