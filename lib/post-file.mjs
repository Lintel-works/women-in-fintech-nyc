/* The post file, both directions.
 *
 * src/posts/<slug>.html is front matter and nothing else. This module is the
 * only thing that writes that format and the only thing that reads it, so the
 * two cannot drift: the Wix importer, the tests and the browser editor all
 * come through here.
 */

/* The order keys are written in. Fixed, so that a file rewritten by the editor
   diffs against the importer's output in the content and nowhere else. */
const FIELD_ORDER = [
  'name', 'slug', 'type', 'title', 'tag', 'role', 'company', 'cardTag',
  'homeTitle', 'linkedin', 'author', 'displayDate', 'isoDate', 'readTime',
  'gradient', 'coverPath', 'excerpt', 'metaDescription', 'ogTitle', 'ogImage',
  'intro'
];

/* JSON string syntax is valid YAML, so single-line values go out as-is.
   Anything with a newline becomes a literal block, which has no escaping to
   get wrong -- but only for a value with no leading or trailing whitespace,
   AND only when there is a non-zero pad to indent the continuation lines
   with. A `|-` block strip-chomps trailing blank lines (gray-matter, the
   reader Eleventy actually builds the site with, chomps the same way, so a
   trailing newline would come back truncated on both sides alike) and
   leading spaces on the first line are read as the block's indentation,
   which breaks when a later line is indented less -- gray-matter then
   throws instead of rendering wrong, and a malformed post must not take the
   build down. Any value with leading or trailing whitespace, or an indent of
   zero (list items -- yamlBlocks calls this with indent 0), goes out as a
   JSON string instead, which both parsers read back losslessly. */
export function yamlValue(value, indent) {
  // U+2028/U+2029 pasted from Word (or anywhere else) are stripped here, the
  // one place every field -- top-level or block -- funnels through on the
  // way out. JSON.stringify does not escape them, so a raw one would reach
  // the file and later break parsePost's own reading of it (see the comment
  // on parsePost). Normalising on write, not just on read, means a download
  // and a publish of the same form state always produce identical bytes.
  const s = String(value == null ? '' : value).replace(/[\u2028\u2029]/g, ' ');
  if (!s.includes('\n') || s.trim() !== s || indent === 0) return JSON.stringify(s);
  const pad = ' '.repeat(indent);
  const lines = s.split('\n').map((line) => line.replace(/\s+$/, ''));
  return '|-\n' + lines.map((line) => (line ? pad + line : '')).join('\n');
}

export function yamlBlocks(blocks) {
  return (blocks || [])
    .map((b) => {
      const lines = [`  - type: ${b.type}`];
      for (const [key, val] of Object.entries(b)) {
        if (key === 'type') continue;
        if (key === 'items') {
          lines.push('    items:');
          val.forEach((item) => lines.push(`      - ${yamlValue(item, 0)}`));
        } else if (typeof val === 'boolean') {
          lines.push(`    ${key}: ${val}`);
        } else {
          lines.push(`    ${key}: ${yamlValue(val, 6)}`);
        }
      }
      return lines.join('\n');
    })
    .join('\n');
}

/* The subset of `post` that serializePost actually writes: FIELD_ORDER keys
   with a defined value, plus blocks. Anything else on `post` (a stray key a
   payload happened to carry) never reaches the file, so it must not be part
   of what a reader is expected to recover -- lib/publish.mjs's parse gate
   compares against exactly this, not against the full validated object. */
export function fieldsWritten(post) {
  const out = {};
  for (const key of FIELD_ORDER) {
    if (post[key] !== undefined) out[key] = post[key];
  }
  out.blocks = post.blocks || [];
  return out;
}

export function serializePost(post) {
  const lines = ['---'];
  for (const key of FIELD_ORDER) {
    if (post[key] === undefined) continue;
    // Every top-level key gets the same pad: this was never specific to
    // intro/excerpt, it was the general rule written narrowly. A multi-line
    // value in ANY top-level field (metaDescription is a textarea in the
    // editor) must still produce a valid `|-` block.
    //
    // Every scalar is quoted, with no bare-key exception. slug/type/tag/
    // coverPath/gradient used to go out unquoted to match the files already
    // committed, but tag and coverPath are free-text fields in the shipped
    // UI (src/admin/types.js), and an unquoted value containing ": ", a
    // leading "*"/">"/"|"/"%"/"@"/"!"/"-"/"#"/backtick/quote, or one that
    // happens to read as a YAML number/bool/null (a title of "False", a
    // gradient of "2020-01-01") either breaks js-yaml's parse at build time
    // or is read back silently wrong. Quoting costs nothing -- gray-matter
    // and parsePost both read a quoted scalar exactly like a bare one -- and
    // it closes the whole class rather than the cases anyone thought to bar.
    lines.push(`${key}: ${yamlValue(post[key], 2)}`);
  }
  lines.push('blocks:');
  lines.push(yamlBlocks(post.blocks));
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

/* Reads only what serializePost writes: quoted scalars, bare scalars, `|-`
   literal blocks, and the blocks list. It is not a YAML implementation and
   must not grow into one -- anything outside the subset is an error naming the
   line, because a post that half-parses would be written back with the missing
   half silently gone. */
export function parsePost(text) {
  // U+2028/U+2029 (LINE/PARAGRAPH SEPARATOR) are routine in text pasted from
  // Word. gray-matter -- the build's own parser -- reads them as ordinary
  // content, so a post containing one publishes and renders fine. But `.`
  // and `$` in the regexes below treat them as line terminators (an
  // ECMAScript rule, not a choice made here), so a value that carries one --
  // even inside a quoted string, since JSON.stringify does not escape them
  // -- silently breaks the top-level `key: value` match and this parser
  // throws. Stripped here, at the one place all reading funnels through, so
  // a post that publishes can always be reopened again. Also normalised on
  // the write side (src/admin/editor.js) before serialising, so a download
  // and a publish of the same form state carry identical bytes.
  const raw = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, ' ');
  const match = raw.match(/^---\n([\s\S]*?)\n---\s*$/);
  if (!match) throw new Error('No front matter found: a post file starts and ends with ---');

  const lines = match[1].split('\n');
  const post = {};
  let blocks = null;   // non-null once `blocks:` has been seen
  let i = 0;

  /* A literal block runs until a line that is neither blank nor indented past
     the key that opened it. */
  const readLiteral = (indent) => {
    const pad = indent + 2;
    const out = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() && !line.startsWith(' '.repeat(pad))) break;
      out.push(line.trim() ? line.slice(pad) : '');
      i++;
    }
    while (out.length && !out[out.length - 1]) out.pop();
    return out.join('\n');
  };

  // `allowBool` is true only for block fields: `ordered: false` is the only
  // boolean serializePost ever writes, and it is always a block field. A
  // top-level or list-item value must stay a string even if its text happens
  // to be "true" or "false" -- coercing by guessing from the text would wrongly
  // turn an author's literal string into a boolean.
  const readScalar = (rest, indent, lineNo, allowBool = false) => {
    if (rest === '|-') return readLiteral(indent);
    if (allowBool && rest === 'true') return true;
    if (allowBool && rest === 'false') return false;
    if (rest.startsWith('"')) {
      try {
        return JSON.parse(rest);
      } catch {
        throw new Error(`Could not read the value on line ${lineNo}`);
      }
    }
    if (/^[[{]/.test(rest)) throw new Error(`Unsupported value on line ${lineNo}`);
    return rest;
  };

  while (i < lines.length) {
    // Body line i (0-based) is raw line i+2: the opening `---` is raw line 1.
    const lineNo = i + 2;
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const top = line.match(/^([a-zA-Z]+):\s*(.*)$/);
    if (top && blocks === null) {
      const [, key, rest] = top;
      i++;
      if (key === 'blocks') { blocks = []; continue; }
      post[key] = readScalar(rest, 0, lineNo);
      continue;
    }

    const item = line.match(/^ {2}- type:\s*(.*)$/);
    if (item && blocks) {
      blocks.push({ type: item[1].trim() });
      i++;
      continue;
    }

    const field = line.match(/^ {4}([a-zA-Z]+):\s*(.*)$/);
    if (field && blocks && blocks.length) {
      const [, key, rest] = field;
      i++;
      const block = blocks[blocks.length - 1];
      if (key === 'items') {
        block.items = [];
        while (i < lines.length) {
          const entry = lines[i].match(/^ {6}- (.*)$/);
          if (!entry) break;
          block.items.push(readScalar(entry[1], 6, i + 2));
          i++;
        }
        continue;
      }
      block[key] = readScalar(rest, 4, lineNo, true);
      continue;
    }

    throw new Error(`Could not read line ${lineNo}: ${line.trim().slice(0, 60)}`);
  }

  post.blocks = blocks || [];
  return post;
}
