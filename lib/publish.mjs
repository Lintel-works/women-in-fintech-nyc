/* Turns a validated payload into the exact bytes of a post file -- and proves
 * they will render, AND that they will parse, before anybody commits them.
 *
 * Two gates, not one. The render gate proves the post RENDERS -- a post that
 * throws in the renderer would fail the Vercel build, and a failed build
 * leaves the previous deployment serving: the site stays up, the post never
 * appears, and nobody is watching the build log to notice.
 *
 * The parse gate proves the bytes PARSE. Rendering a validated JS object
 * never exercises the YAML the file is actually written as, so a value that
 * breaks js-yaml at build time (or reads back as the wrong thing) sailed
 * through the render gate every time -- that gap is Ruling 26. This gate
 * re-parses the exact bytes about to be committed with gray-matter, the
 * same library the Eleventy build reads front matter with, and with
 * parsePost, the editor's own reader, and refuses unless both agree with
 * each other and with what was serialized. Quoting every scalar (see
 * lib/post-file.mjs) closes today's known class of breakage; this gate is
 * what catches whatever the next serializer change opens. */
import matter from 'gray-matter';
import { validatePublish } from './publish-validate.mjs';
import { serializePost, parsePost, fieldsWritten } from './post-file.mjs';
import { buildPostView } from './render-blocks.mjs';

// Mirrors the one normalisation yamlValue applies on the way out (see
// lib/post-file.mjs) -- without it, a value containing U+2028/U+2029 would
// legitimately come back with a plain space in its place, and the gate would
// misreport that harmless, deliberate change as a parse failure.
function stripLineSeparators(value) {
  if (typeof value === 'string') return value.replace(/[\u2028\u2029]/g, ' ');
  if (Array.isArray(value)) return value.map(stripLineSeparators);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = stripLineSeparators(value[key]);
    return out;
  }
  return value;
}

function isEqual(a, b) {
  if (a === b) return true;
  // `blocks:` with no entries under it is valid YAML whose value is null,
  // not an empty list -- js-yaml (and so gray-matter) reads it that way, a
  // quirk of the format itself and not a parsing bug. parsePost and
  // renderBlocks both already treat a missing blocks list the same as an
  // empty one (`(blocks || [])`), so the gate must too, or every brand-new
  // post with zero blocks yet would be refused before it could ever be
  // published.
  if (Array.isArray(a) && a.length === 0 && (b === null || b === undefined)) return true;
  if (Array.isArray(b) && b.length === 0 && (a === null || a === undefined)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => isEqual(item, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => isEqual(a[key], b[key]));
  }
  return false;
}

/* Re-parses the bytes about to be committed and confirms both readers
   recover exactly what was serialized. A throw from either reader, or any
   field that comes back different, refuses -- there is no partial-credit
   case where publishing a maybe-broken file is better than not publishing.
   Exported so a test can feed it deliberately malformed bytes directly,
   proving the gate itself catches a broken serialization -- not just that
   today's serializePost happens not to produce one. */
export function parseGate(text, expected) {
  let fromGrayMatter;
  let fromParsePost;
  try {
    fromGrayMatter = matter(text).data;
  } catch (error) {
    return `This post cannot be saved: its text confused the file format (${error.message}). Try removing unusual punctuation -- a stray colon, quote or symbol at the start of a line -- from the field you just edited.`;
  }
  try {
    fromParsePost = parsePost(text);
  } catch (error) {
    return `This post cannot be saved: its text confused the file format (${error.message}). Try removing unusual punctuation -- a stray colon, quote or symbol at the start of a line -- from the field you just edited.`;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(fromGrayMatter), ...Object.keys(fromParsePost)]);
  for (const key of keys) {
    if (!isEqual(expected[key], fromGrayMatter[key]) || !isEqual(expected[key], fromParsePost[key])) {
      return `This post cannot be saved: the "${key}" field would not read back the way it was written. Try removing unusual punctuation from it and publish again.`;
    }
  }
  return null;
}

export function preparePublish(payload) {
  const valid = validatePublish(payload);
  if (!valid.ok) return valid;

  try {
    buildPostView(valid.post);
  } catch (error) {
    return { ok: false, message: `This post cannot be shown on the site yet: ${error.message}` };
  }

  const text = serializePost(valid.post);
  const parseFailure = parseGate(text, stripLineSeparators(fieldsWritten(valid.post)));
  if (parseFailure) return { ok: false, message: parseFailure };

  return {
    ok: true,
    path: valid.path,
    slug: valid.slug,
    type: valid.type,
    text
  };
}
