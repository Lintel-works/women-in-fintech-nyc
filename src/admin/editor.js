/* NYC Fintech Women — admin: form state, block list, preview, post files.
 *
 * An ES module, so it only works when served. It renders through the same
 * /lib modules the build uses; there is no second copy of anything here.
 */
import { renderBlocks as renderBlockHtml, renderInline } from '/lib/render-blocks.mjs';
import { serializePost, parsePost } from '/lib/post-file.mjs';
import { POST_TYPES, postTitle, coverPathFor } from '/lib/post-types.mjs';
import { slugify, isUrlSafe, badSlugChars } from './text.js';
import { TYPES, BLOCK_LABELS, BLOCK_FIELDS, blankBlock } from './types.js';

var typeKey = (new URLSearchParams(location.search).get('type')) || 'fff';
if (!TYPES[typeKey] || !POST_TYPES[typeKey]) typeKey = 'fff';

/* Identity from lib/, form fields from types.js. */
var def = Object.assign({}, POST_TYPES[typeKey], TYPES[typeKey]);

/* Per type, so switching types does not restore an interview into a news form
   or the other way round. */
var STORAGE_KEY = 'wif.admin.draft.v1.' + typeKey;

var model = emptyModel();
var slugTouched = false;
var cover = { file: null, blobUrl: null, ext: 'jpg' };
var previewTimer = null;

/* Publishing state. This flag only drives what the UI offers; the server
   verifies the Clerk session token on every request and is what decides. */
var signedIn = false;

/* Set only inside openPostFile, to the slug of the post that was opened.
   Comparing it to the current slug at publish time is how a retitled post
   correctly publishes as a create instead of overwriting the post it was
   opened from -- a new title means a new address. */
var openedSlug = null;

var $ = function (id) { return document.getElementById(id); };

/* Field key -> the elements renderFields built for it, so a field can be
   re-validated when something other than its own input changed it. */
var fieldEls = {};

/* Local date, not UTC: "today" has to mean the author's today, or a post
   written in the evening in New York is dated tomorrow. The month names live
   inside the function because emptyModel() runs during module init, before a
   module-level `var` would have been assigned. */
function todayParts() {
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var d = new Date();
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return {
    iso: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
    display: months[d.getMonth()] + ' ' + d.getDate()
  };
}

function emptyModel() {
  var m = { type: typeKey, blocks: [] };
  def.fields.forEach(function (f) { m[f.key] = ''; });
  m.coverPath = '';
  m.gradient = 'g1';
  /* isoDate orders the collection and the homepage renders only the first
     three, so a post published without one sorts last and never appears there
     -- with nothing on screen to say so. Both dates default to today; the
     author can change them, and buildPostObject refuses a blank ISO date. */
  var today = todayParts();
  if (Object.prototype.hasOwnProperty.call(m, 'isoDate')) m.isoDate = today.iso;
  if (Object.prototype.hasOwnProperty.call(m, 'date')) m.date = today.display;
  return m;
}

/* ------------------------------------------------------------------ misc */

function toast(msg) {
  var el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(function () { el.classList.remove('show'); }, 1800);
}

/* Status text alone cannot tell you whether something worked: 'Published.'
   and 'Publishing failed.' render identically as grey copy. Every status goes
   through here so the tone — busy, ok, error — carries a colour and a glyph
   from .status-line as well as the wording. */
function setStatus(el, text, tone) {
  var node = typeof el === 'string' ? $(el) : el;
  if (!node) return;
  node.textContent = text;
  node.className = 'status-line' + (tone ? ' is-' + tone : '');
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.max(el.scrollHeight, 38) + 'px';
}

function downloadBlob(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

/* -------------------------------------------------------- model plumbing */

/* The model the generator sees: the cover path resolves to the manual
   override, else the uploaded file's canonical name. */
function resolved() {
  var m = {};
  Object.keys(model).forEach(function (k) { m[k] = model[k]; });
  /* model.slug is whatever the author typed into the slug field, verbatim --
     badSlugChars only rejects the wrong characters, not "abc--def" or
     "-abc-" or a 90-character run, all of which the server's slugify would
     still rewrite. Running it through slugify() here, not just displaying
     it raw, is what keeps the filename, the coverPath below, and everything
     buildPostObject() writes in agreement with what api/publish.js will
     compute for the same field -- the fallback to the source field when the
     slug is untouched or empty is unchanged. */
  m.slug = slugify(model.slug) || slugify(model[def.slugSource] || '');
  // coverPathFor is the one cover-path convention, shared with the renderer
  // (lib/render-blocks.mjs) and both publish endpoints (api/publish.js,
  // api/unpublish.js) -- there used to be four separate implementations of
  // this same shape.
  m.coverPath = (model.coverPath || '').trim() ||
    coverPathFor(typeKey, m.slug, outputExt());
  m.headshot = m.coverPath;
  return m;
}

function onChange() {
  save();
  schedulePreview();
  renderImagePanel();
}

/* --------------------------------------------------------- field warnings */

/* The slug becomes a filename and an href on three pages. The renderer
   escapes it, so a stray quote can no longer break out of the attribute --
   but the link would still be broken, and only the author can fix it. Name
   the characters rather than quietly rewriting what they typed. */
var SLUG_MESSAGE = 'A slug may only use a-z, 0-9 and hyphens. Remove: ';

function warningFor(field, value) {
  if (field.key === 'slug') {
    var bad = badSlugChars(value.trim());
    return bad.length ? SLUG_MESSAGE + bad.join(' ') : '';
  }
  if ((field.type === 'url' || field.key === 'ogImage') && value.trim()) {
    return isUrlSafe(value) ? '' : 'Not a usable URL — this will be dropped.';
  }
  return '';
}

function showWarning(field, wrap, warn, value) {
  var message = warningFor(field, value);
  warn.style.display = message ? '' : 'none';
  warn.textContent = message;
  wrap.classList.toggle('invalid', !!message);
}

function refreshWarning(key) {
  var els = fieldEls[key];
  if (els) showWarning(els.field, els.wrap, els.warn, els.input.value);
}

/* ------------------------------------------------------------- rendering */

function renderFields() {
  var host = $('fields');
  host.innerHTML = '';
  fieldEls = {};
  def.fields.forEach(function (f) {
    var wrap = document.createElement('div');
    wrap.className = 'field';

    var label = document.createElement('label');
    label.setAttribute('for', 'f-' + f.key);
    label.innerHTML = f.label + (f.required ? ' <span class="req">*</span>' : '');
    wrap.appendChild(label);

    var input;
    if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = f.rows || 4;
    } else if (f.type === 'select') {
      input = document.createElement('select');
      (f.options || []).forEach(function (value) {
        var opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value;
        input.appendChild(opt);
      });
    } else {
      input = document.createElement('input');
      input.type = f.type === 'date' ? 'date' : (f.type === 'url' ? 'url' : 'text');
    }
    input.id = 'f-' + f.key;
    if (f.placeholder) input.placeholder = f.placeholder;
    if (f.maxlength) input.maxLength = f.maxlength;
    if (f.mono) input.className = 'mono';
    input.value = model[f.key] || '';

    if (f.prefix || f.suffix) {
      var affixed = document.createElement('div');
      affixed.className = 'affixed';
      if (f.prefix) {
        var pre = document.createElement('span');
        pre.className = 'affix';
        pre.textContent = f.prefix;
        affixed.appendChild(pre);
      }
      affixed.appendChild(input);
      if (f.suffix) {
        var suf = document.createElement('span');
        suf.className = 'affix';
        suf.textContent = f.suffix;
        affixed.appendChild(suf);
      }
      wrap.appendChild(affixed);
    } else {
      wrap.appendChild(input);
    }

    if (f.help) {
      var help = document.createElement('div');
      help.className = 'help';
      help.innerHTML = f.help;
      wrap.appendChild(help);
    }
    var warn = document.createElement('div');
    warn.className = 'warn';
    warn.style.display = 'none';
    wrap.appendChild(warn);

    fieldEls[f.key] = { field: f, wrap: wrap, warn: warn, input: input };

    input.addEventListener(f.type === 'select' ? 'change' : 'input', function () {
      model[f.key] = input.value;

      if (f.key === def.slugSource && !slugTouched) {
        model.slug = slugify(input.value);
        var slugInput = $('f-slug');
        if (slugInput) slugInput.value = model.slug;
        refreshWarning('slug');
      }
      if (f.key === 'slug') slugTouched = true;

      showWarning(f, wrap, warn, input.value);

      if (f.type === 'textarea') autoGrow(input);
      onChange();
    });

    /* Canonicalise on blur only, not on every keystroke: normalising while
       the author is still typing would collapse "a-b" to "a-" the instant
       they type the second hyphen, mid-word. Blur is when they've moved on,
       so this is the moment to show them the address they will actually get
       -- resolved() already computes the canonical form silently; this makes
       it visible instead of a surprise after publish. */
    if (f.key === 'slug') {
      input.addEventListener('blur', function () {
        var canonical = slugify(input.value);
        if (canonical === input.value) return;
        input.value = canonical;
        model.slug = canonical;
        showWarning(f, wrap, warn, canonical);
        onChange();
      });
    }

    if (f.type === 'textarea') setTimeout(function () { autoGrow(input); }, 0);
    host.appendChild(wrap);
    showWarning(f, wrap, warn, input.value);
  });
}

function renderBlocks() {
  var host = $('blocks');
  host.innerHTML = '';

  if (!model.blocks.length) {
    var empty = document.createElement('div');
    empty.className = 'blk-empty';
    empty.textContent = 'No body blocks yet — add a Q & A to start the interview.';
    host.appendChild(empty);
    return;
  }

  model.blocks.forEach(function (block, index) {
    var card = document.createElement('div');
    card.className = 'blk';

    var head = document.createElement('div');
    head.className = 'blk-head';
    head.innerHTML = '<span class="type">' + (BLOCK_LABELS[block.type] || block.type) + '</span>';

    head.appendChild(iconBtn('↑', 'Move up', index === 0, function () { move(index, -1); }));
    head.appendChild(iconBtn('↓', 'Move down', index === model.blocks.length - 1, function () { move(index, 1); }));
    head.appendChild(iconBtn('⧉', 'Duplicate', false, function () { duplicate(index); }));
    head.appendChild(iconBtn('✕', 'Delete', false, function () { remove(index); }));
    card.appendChild(head);

    var body = document.createElement('div');
    body.className = 'blk-body';

    (BLOCK_FIELDS[block.type] || []).forEach(function (f) {
      var wrap = document.createElement('div');
      wrap.className = 'field';

      if (f.control === 'checkbox') {
        var checkLabel = document.createElement('label');
        checkLabel.className = 'check';
        var check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = !!block[f.key];
        check.addEventListener('change', function () {
          block[f.key] = check.checked;
          onChange();
        });
        checkLabel.appendChild(check);
        checkLabel.appendChild(document.createTextNode(' ' + f.label));
        wrap.appendChild(checkLabel);
        body.appendChild(wrap);
        return;
      }

      var label = document.createElement('label');
      label.textContent = f.label;
      wrap.appendChild(label);

      var input;
      if (f.control === 'text') {
        input = document.createElement('input');
        input.type = 'text';
        if (f.placeholder) input.placeholder = f.placeholder;
        input.value = block[f.key] || '';
      } else {
        input = document.createElement('textarea');
        input.rows = f.rows || 3;
        input.value = f.control === 'lines'
          ? (block[f.key] || []).join('\n')
          : (block[f.key] || '');
      }

      input.addEventListener('input', function () {
        block[f.key] = f.control === 'lines'
          ? input.value.split('\n')
          : input.value;
        if (input.tagName === 'TEXTAREA') autoGrow(input);
        onChange();
      });

      wrap.appendChild(input);
      if (f.help) {
        var help = document.createElement('div');
        help.className = 'help';
        help.textContent = f.help;
        wrap.appendChild(help);
      }
      body.appendChild(wrap);
      if (input.tagName === 'TEXTAREA') setTimeout(function () { autoGrow(input); }, 0);
    });

    card.appendChild(body);
    host.appendChild(card);
  });
}

function iconBtn(glyph, title, disabled, handler) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-icon';
  b.textContent = glyph;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.disabled = !!disabled;
  b.addEventListener('click', handler);
  return b;
}

function move(index, delta) {
  var target = index + delta;
  if (target < 0 || target >= model.blocks.length) return;
  var tmp = model.blocks[index];
  model.blocks[index] = model.blocks[target];
  model.blocks[target] = tmp;
  renderBlocks();
  onChange();
}

function duplicate(index) {
  var copy = JSON.parse(JSON.stringify(model.blocks[index]));
  copy.id = 'b' + Math.random().toString(36).slice(2, 9);
  model.blocks.splice(index + 1, 0, copy);
  renderBlocks();
  onChange();
}

function remove(index) {
  model.blocks.splice(index, 1);
  renderBlocks();
  onChange();
}

function renderAddRow() {
  var host = $('add-row');
  host.innerHTML = '';
  def.blocks.forEach(function (type) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm';
    b.textContent = '+ ' + (BLOCK_LABELS[type] || type);
    b.addEventListener('click', function () {
      model.blocks.push(blankBlock(type));
      renderBlocks();
      onChange();
    });
    host.appendChild(b);
  });
}

function renderImagePanel() {
  var m = resolved();
  $('img-path').textContent = m.coverPath;
  $('btn-img-download').disabled = !cover.file;

  var thumb = $('img-thumb');
  if (cover.blobUrl) {
    thumb.style.backgroundImage = 'url("' + cover.blobUrl + '")';
    thumb.textContent = '';
  } else if ((model.coverPath || '').trim()) {
    thumb.style.backgroundImage = 'url("../' + (model.coverPath || '').trim() + '")';
    thumb.textContent = '';
  } else {
    thumb.style.backgroundImage = '';
    thumb.textContent = 'No image';
  }
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 250);
}

/* The article only: the nav, the hero and the footer are the build's
   business now, and duplicating them here is exactly what this editor stopped
   doing. The lede is renderInline, not paragraphs, because that is what
   post.njk puts inside the single <p class="article-lede">. */
function previewDocument(model) {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    /* A post is served from the site root, so its "images/..." paths are
       relative to it. Without this the iframe resolves them against /admin/
       and every body image 404s in the preview alone. */
    '<base href="/">',
    '<link rel="stylesheet" href="/site.css">',
    '<link rel="stylesheet" href="/post-article.css">',
    '</head><body><article class="article-body" style="padding: 32px 20px;">',
    '<p class="article-lede">' + renderInline(model.intro) + '</p>',
    renderBlockHtml(model.blocks),
    '</article></body></html>'
  ].join('\n');
}

function renderPreview() {
  $('preview').srcdoc = previewDocument(resolved());
}

/* ------------------------------------------------------------- persistence */

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      model: model, slugTouched: slugTouched, ext: cover.ext, savedAt: Date.now()
    }));
    $('save-status').textContent = 'Draft saved';
  } catch (e) {
    $('save-status').textContent = 'Draft not saved (storage full?)';
  }
}

function loadDraft() {
  var raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function applyDraft(draft) {
  model = draft.model;
  if (!model.blocks) model.blocks = [];
  /* Every caller replaces the model wholesale with content this editor did
     not just open from a file -- a restored autosave, an imported JSON
     draft, window.WIF_EDITOR.setModel() -- so none of them is the post
     openedSlug was set for. Clearing it here, in the one place all of those
     paths funnel through, is what stops a restored or imported draft that
     happens to carry the same slug from silently publishing as an update to
     whatever is live at that address. */
  openedSlug = null;
  updatePublishAvailability();
  slugTouched = !!draft.slugTouched;
  cover.ext = draft.ext || 'jpg';
  renderAll();
}

function showRestoreBanner(draft) {
  var host = $('restore-banner');
  var bar = document.createElement('div');
  bar.className = 'banner';
  bar.style.margin = '20px 20px 0';
  var label = document.createElement('span');
  var who = (draft.model && draft.model.name) || 'Untitled';
  label.textContent = 'Unsaved draft found: “' + who + '”. The image file must be re-selected; its path is kept.';
  bar.appendChild(label);

  var restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'btn btn-sm';
  restore.textContent = 'Restore';
  restore.addEventListener('click', function () {
    applyDraft(draft);
    host.innerHTML = '';
    toast('Draft restored');
  });
  bar.appendChild(restore);

  var discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'btn btn-sm';
  discard.textContent = 'Discard';
  discard.addEventListener('click', function () {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    host.innerHTML = '';
  });
  bar.appendChild(discard);

  host.appendChild(bar);
}

/* ------------------------------------------------------------------ image */

/* The resize path re-encodes to JPEG, so the file that lands on disk is
   .jpg regardless of what was uploaded. The extension here has to match
   what actually lands on disk, or the post's own coverPath -- the only
   source cards render their image from -- 404s. */
function outputExt() {
  if (!cover.file) return cover.ext;
  return $('img-keep') && $('img-keep').checked ? cover.ext : 'jpg';
}

var EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif'
};

/* api/publish.js only ever writes a .jpg or a .png -- the same two formats
   coverAsBase64() below can actually produce. "Keep original" on anything
   else (webp/avif/gif, all reachable via EXT_BY_MIME above) has to be
   refused HERE, in the editor, with a message the author can act on --
   letting it through and having the server's own allowlist silently refuse
   it (or worse, silently rewrite the extension) is exactly the kind of
   unverified "Published." this phase exists to rule out. */
var PUBLISHABLE_COVER_EXTS = { jpg: true, png: true };

function coverExtIsPublishable() {
  if (!cover.file) return true;
  if (!($('img-keep') && $('img-keep').checked)) return true; // will be re-encoded to jpg
  return !!PUBLISHABLE_COVER_EXTS[cover.ext];
}

function onFilePicked(file) {
  if (!file) return;
  if (cover.blobUrl) URL.revokeObjectURL(cover.blobUrl);
  cover.file = file;
  cover.ext = EXT_BY_MIME[file.type] || (file.name.split('.').pop() || 'jpg').toLowerCase();
  cover.blobUrl = URL.createObjectURL(file);
  renderImagePanel();
  schedulePreview();
}

/* Vercel caps a function request body at 4.5 MB, and an unmodified phone
   photo can exceed that on its own -- founders-roundtable.jpg is 383 KB only
   because it has already been through something. So this is not an
   optimisation, it is what makes publishing work at all. */
var MAX_COVER_EDGE = 1600;
var COVER_QUALITY = 0.82;

/* Resolves to base64 with the data: prefix stripped -- api/publish.js does a
   strict base64 round-trip on the payload and rejects anything still
   carrying that prefix. Resolves null when no cover was chosen, so the
   caller can publish a post with no image.

   "Keep original" now takes the same path here as it does in
   downloadRenamedImage below: the original bytes pass straight through with
   no re-encoding, for a jpg or a png (coverExtIsPublishable() has already
   refused anything else before this is ever called). That is the fix for
   Ruling 24 -- a kept-original PNG used to be re-encoded to JPEG here
   regardless, so the file api/publish.js wrote never matched the .png path
   the post's own front matter recorded. The one real constraint driving
   this is the WRITTEN FILE PATH: api/publish.js writes
   `<prefix><slug>.<ext>` with ext coming from this payload, so whatever
   bytes are sent here must actually be encoded the way that extension
   claims, or the published cover is broken the moment a browser tries to
   decode it as that format. */
function coverAsBase64() {
  return new Promise(function (resolve, reject) {
    if (!cover.file) { resolve(null); return; }
    if ($('img-keep') && $('img-keep').checked) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || '');
        var comma = result.indexOf(',');
        if (comma === -1) { reject(new Error('That image could not be read. Choose a JPG or PNG.')); return; }
        var payload = result.slice(comma + 1);
        if (!payload) { reject(new Error('That image could not be read. Choose a JPG or PNG.')); return; }
        if (payload.length > 3_500_000) {
          reject(new Error('That cover image is too large to publish. Choose a smaller one, or uncheck "keep original" to shrink it.'));
          return;
        }
        resolve(payload);
      };
      reader.onerror = function () {
        reject(new Error('That file could not be read as an image. Choose a JPG or PNG.'));
      };
      reader.readAsDataURL(cover.file);
      return;
    }
    var img = new Image();
    img.onload = function () {
      // A truncated file, or something other than an image chosen past the
      // file input's advisory accept="image/*", can decode with no intrinsic
      // size. That makes the canvas 0x0, and toDataURL() on a 0x0 canvas
      // returns the literal string "data:," -- which has a comma, so it
      // would otherwise slip past the comma === -1 guard below and resolve
      // to an empty string instead of failing loudly.
      if (!img.width || !img.height) {
        reject(new Error('That image could not be read. Choose a JPG or PNG.'));
        return;
      }
      var scale = Math.min(1, MAX_COVER_EDGE / Math.max(img.width, img.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      var url = canvas.toDataURL('image/jpeg', COVER_QUALITY);
      var comma = url.indexOf(',');
      if (comma === -1) { reject(new Error('The cover image could not be prepared.')); return; }
      // Base64 inflates by about a third; check the encoded length, which is
      // what actually travels, not the pixel dimensions. This is stricter
      // than api/publish.js's own 4,000,001-character limit on purpose: the
      // client should refuse before a request is sent, not after it fails.
      if (url.length > 3_500_000) {
        reject(new Error('That cover image is too large to publish even after shrinking. Choose a smaller one.'));
        return;
      }
      var payload = url.slice(comma + 1);
      // Belt-and-braces alongside the width/height check above: a resolved
      // value must never be an empty string, since api/publish.js treats a
      // falsy base64 field as "no image" and would silently publish the post
      // with none instead of surfacing this as an error.
      if (!payload) {
        reject(new Error('That image could not be read. Choose a JPG or PNG.'));
        return;
      }
      resolve(payload);
    };
    img.onerror = function () {
      reject(new Error('That file could not be read as an image. Choose a JPG or PNG.'));
    };
    img.src = cover.blobUrl || URL.createObjectURL(cover.file);
  });
}

/* Downscale to 1600px wide and re-encode — the existing Wix-era assets are
   far larger than the layout needs. The checkbox bypasses it for PNGs with
   transparency, which JPEG would flatten. */
function downloadRenamedImage() {
  if (!cover.file) return;
  var m = resolved();
  var name = m.coverPath.split('/').pop();

  if ($('img-keep').checked) {
    downloadBlob(cover.file, name);   // name already carries the source ext
    return;
  }

  var img = new Image();
  img.onload = function () {
    var maxW = 1600;
    var scale = Math.min(1, maxW / img.naturalWidth);
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(function (blob) {
      if (!blob) { downloadBlob(cover.file, name); return; }
      downloadBlob(blob, name.replace(/\.[a-z0-9]+$/i, '.jpg'));
    }, 'image/jpeg', 0.82);
  };
  img.onerror = function () { downloadBlob(cover.file, name); };
  img.src = cover.blobUrl;
}

/* ------------------------------------------------------------------- auth */

var clerk = null;

/* A Clerk session token lives 60 SECONDS. Fetching one at sign-in and
   reusing it would produce an editor that publishes successfully for about a
   minute and then returns 401 forever -- indistinguishable, to an author,
   from a revoked account. getToken() is therefore called per request, and
   never stored. */
async function authHeaders() {
  var headers = { 'content-type': 'application/json' };
  if (clerk && clerk.session) {
    var token = await clerk.session.getToken();
    if (token) headers.authorization = 'Bearer ' + token;
  }
  return headers;
}

/* With 60-second tokens, a 401 usually means the token aged out mid-request,
   not that the author signed out. Only drop the signed-in state when Clerk
   itself says there is no session; otherwise leave Publish enabled so the
   author can simply retry with a fresh token. */
function handleUnauthorized() {
  if (!clerk || !clerk.isSignedIn) {
    signedIn = false;
    updatePublishAvailability();
  }
}

/* clerk-config.js inserts Clerk's two bundles dynamically, so they run async
   and in no guaranteed order, and neither exists yet when this module runs.
   Waiting for window.Clerk alone could reach load() before the UI bundle has
   set its constructor. Polling briefly is cheaper than a load event on tags
   this file did not create. */
function waitForClerk(timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  return new Promise(function (resolve) {
    (function poll() {
      if (window.Clerk && window.__internal_ClerkUICtor) return resolve(window.Clerk);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(poll, 50);
    }());
  });
}

async function initClerk() {
  var status = $('signin-status');
  var mount = $('clerk-auth');
  var rendered = null;
  setStatus(status, 'Loading sign-in…', 'busy');
  clerk = await waitForClerk(10000);
  if (!clerk) {
    setStatus(status, 'Could not load the sign-in form. Check your connection and reload.', 'error');
    return;
  }
  try {
    await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  } catch (error) {
    setStatus(status, 'Could not load the sign-in form. Check your connection and reload.', 'error');
    return;
  }
  render();

  /* Clerk notifies listeners as a sign-in attempt progresses, not only when
     the signed-in state flips. Remounting on each event would reset a
     half-finished password or emailed-code step, so act only on a change. */
  function render() {
    var nowSignedIn = !!clerk.isSignedIn;
    if (rendered === nowSignedIn) return;
    if (rendered === true) clerk.unmountUserButton(mount);
    if (rendered === false) clerk.unmountSignIn(mount);
    rendered = nowSignedIn;
    if (nowSignedIn) {
      signedIn = true;
      var email = clerk.user && clerk.user.primaryEmailAddress
        ? clerk.user.primaryEmailAddress.emailAddress : '';
      setStatus(status, 'Signed in as ' + email + '.', 'ok');
      updateAccountButton(email);
      clerk.mountUserButton(mount);
      renderAdminTools(isAdminUser());
    } else {
      signedIn = false;
      setStatus(status, '');
      updateAccountButton('');
      clerk.mountSignIn(mount);
      renderAdminTools(false);
    }
    updatePublishAvailability();
  }

  clerk.addListener(function () { render(); });
}

/* A throw inside initClerk would otherwise be an unhandled rejection and
   leave the author a blank panel with no explanation. */
/* The account drawer. Sign-in and author management live here rather than at
   the top of the writing column, where an author scrolled past them on every
   post and an admin saw invite controls while drafting. */
function drawerIsOpen() {
  return !!openDrawerId;
}

/* Which drawer is open, and what opened it -- closing returns focus to the
   control the author came from rather than always to the account button. */
var openDrawerId = null;
var drawerTriggerId = null;

function openDrawer(id, triggerId) {
  if (openDrawerId && openDrawerId !== id) closeDrawer();
  var drawer = $(id);
  $('drawer-backdrop').hidden = false;
  drawer.hidden = false;
  /* Unhiding and transforming in the same frame skips the transition, so the
     panel would snap rather than slide. */
  requestAnimationFrame(function () { drawer.classList.add('open'); });
  openDrawerId = id;
  drawerTriggerId = triggerId;
  var close = drawer.querySelector('.drawer-head .btn-icon');
  if (close) close.focus();
}

function closeDrawer() {
  if (!openDrawerId) return;
  var drawer = $(openDrawerId);
  var trigger = drawerTriggerId;
  drawer.classList.remove('open');
  $('drawer-backdrop').hidden = true;
  /* Hide only once the slide-out has run; hiding immediately would make the
     panel disappear instead of leaving. */
  setTimeout(function () {
    if (!drawer.classList.contains('open')) drawer.hidden = true;
  }, 200);
  openDrawerId = null;
  drawerTriggerId = null;
  if (trigger && $(trigger)) $(trigger).focus();
}

/* Signing in is the one thing a new author must find, and the drawer hides it
   behind a button -- so the trigger says so, and wears the primary style until
   they are signed in. */
function updateAccountButton(email) {
  var button = $('btn-account');
  button.textContent = signedIn ? (email || 'Account') : 'Sign in';
  if (signedIn) button.classList.remove('btn-pink');
  else button.classList.add('btn-pink');
}

function startClerk() {
  initClerk().catch(function () {
    setStatus('signin-status', 'Could not load the sign-in form. Check your connection and reload.', 'error');
  });
}

function isAdminUser() {
  return !!(clerk && clerk.user && clerk.user.publicMetadata && clerk.user.publicMetadata.role === 'admin');
}

/* Runs only when the signed-in state flips (see render() above), so someone
   promoted to admin mid-session sees nothing until they sign out and in. */
function renderAdminTools(isAdmin) {
  $('admin-tools').hidden = !isAdmin;
  if (isAdmin) loadAuthors();
}

/* Each load takes a number; only the latest may draw, so a slow earlier
   response cannot overwrite a newer list with stale rows. */
var authorLoadCount = 0;

function setAuthorButtons(disabled) {
  var buttons = $('author-list').querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) buttons[i].disabled = disabled;
}

async function loadAuthors() {
  var holder = $('author-list');
  var thisLoad = ++authorLoadCount;
  holder.innerHTML = '';
  holder.appendChild(emptyNote('Loading authors…'));
  try {
    var response = await fetch('/api/authors', { headers: await authHeaders() });
    var data = await response.json().catch(function () { return {}; });
    if (thisLoad !== authorLoadCount) return;
    if (response.status === 401) handleUnauthorized();
    if (!response.ok) {
      holder.innerHTML = '';
      holder.appendChild(emptyNote(data.message || 'Could not load the author list.'));
      return;
    }
    holder.innerHTML = '';
    if (!(data.authors || []).length) {
      holder.appendChild(emptyNote('No authors yet. Invite one above.'));
      return;
    }
    (data.authors || []).forEach(function (author) {
      var row = document.createElement('div');
      row.className = 'author-row';
      var who = document.createElement('span');
      who.className = 'who';
      // The address is the identity; role and invitation state are metadata,
      // so they go in pills rather than a parenthesised run-on.
      var email = document.createElement('strong');
      email.textContent = author.email;
      who.appendChild(email);
      who.appendChild(pill(author.role, false));
      if (author.state && author.state !== 'active') who.appendChild(pill(author.state, true));
      row.appendChild(who);
      ['remove', author.role === 'admin' ? 'demote' : 'promote'].forEach(function (action) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = action === 'remove' ? 'btn btn-sm btn-danger' : 'btn btn-sm';
        button.textContent = action.charAt(0).toUpperCase() + action.slice(1);
        button.setAttribute('aria-label', action + ' ' + author.email);
        button.addEventListener('click', function () { actOnAuthor(action, author.id, author.email); });
        row.appendChild(button);
      });
      holder.appendChild(row);
    });
  } catch (error) {
    if (thisLoad === authorLoadCount) {
      holder.innerHTML = '';
      holder.appendChild(emptyNote('Could not reach the site to load the author list.'));
    }
  }
}

function emptyNote(text) {
  var note = document.createElement('p');
  note.className = 'empty-note';
  note.textContent = text;
  return note;
}

function pill(text, muted) {
  var span = document.createElement('span');
  span.className = muted ? 'pill pill-muted' : 'pill';
  span.textContent = text;
  return span;
}

async function actOnAuthor(action, id, email) {
  var status = $('invite-status');
  // Removal deletes the account and cannot be undone from here.
  if (action === 'remove' && !window.confirm('Remove ' + email + '? They will lose access immediately.')) return;
  setStatus(status, 'Working…', 'busy');
  // A double-click on a destructive action must not send it twice.
  setAuthorButtons(true);
  try {
    var response = await fetch('/api/authors', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ action: action, id: id })
    });
    if (response.status === 204) {
      setStatus(status, action === 'remove' ? ('Removed ' + email + '.') : ('Updated ' + email + '.'), 'ok');
      loadAuthors();
      return;
    }
    if (response.status === 401) handleUnauthorized();
    var data = await response.json().catch(function () { return {}; });
    setStatus(status, data.message || 'That did not work.', 'error');
    setAuthorButtons(false);
  } catch (error) {
    setStatus(status, 'Could not reach the site.', 'error');
    setAuthorButtons(false);
  }
}

async function sendInvite() {
  var input = $('invite-email');
  var button = $('btn-invite');
  var status = $('invite-status');
  var email = input.value.trim();
  if (!email) { setStatus(status, 'Enter an email address first.', 'error'); return; }
  setStatus(status, 'Sending…', 'busy');
  // One click is one of Clerk's 100 invitations an hour; a double-click
  // must not spend two.
  button.disabled = true;
  try {
    var response = await fetch('/api/invite', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ email: email })
    });
    if (response.status === 204) {
      setStatus(status, 'Invitation sent to ' + email + '.', 'ok');
      input.value = '';
      return;
    }
    if (response.status === 401) handleUnauthorized();
    var data = await response.json().catch(function () { return {}; });
    setStatus(status, data.message || 'Could not send that invitation.', 'error');
  } catch (error) {
    setStatus(status, 'Could not reach the site to send that invitation.', 'error');
  } finally {
    button.disabled = false;
  }
}

/* The one place both publish-availability and unpublish-availability are
   decided, called on every signedIn or openedSlug transition. btn-unpublish
   needs both conditions, not just signedIn: openedSlug is the only slug this
   session actually knows to be live (set by opening a post or by a
   successful publish, cleared by New post, import, restore or a successful
   unpublish) -- disabling the button when it is null is what stops an
   unpublish from ever targeting a slug nothing here has confirmed is
   published. */
function updatePublishAvailability() {
  var publishButton = $('btn-publish');
  if (publishButton) {
    publishButton.disabled = !signedIn;
    publishButton.title = signedIn ? '' : 'Sign in to publish';
  }
  var unpublishButton = $('btn-unpublish');
  if (unpublishButton) {
    var canUnpublish = signedIn && !!openedSlug;
    unpublishButton.disabled = !canUnpublish;
    unpublishButton.title = canUnpublish ? '' :
      (!signedIn ? 'Sign in to unpublish' : 'Open or publish a post first — nothing here is known to be published');
  }
}

/* ------------------------------------------------ published posts drawer */

/* An author signed in to /admin has no clone of this repository, so the file
   picker below can only ever open a post they already have on disk -- which
   an author on their own laptop does not. This list is how a published post
   is reached at all: posts-index.json is emitted by the build (see
   lib/posts-index.mjs), so drawing it costs one static file rather than one
   GitHub call per post, of which there are 261. */
var postsIndex = null;
var postsLoadToken = 0;

function openPostsDrawer() {
  openDrawer('posts-drawer', 'btn-open-post');
  /* Re-fetched on every open rather than cached for the session: an author
     who has just published expects to see it, and the file is small. */
  loadPostsIndex();
}

async function loadPostsIndex() {
  var holder = $('posts-list');
  var token = ++postsLoadToken;
  holder.innerHTML = '';
  holder.appendChild(emptyNote('Loading posts…'));
  try {
    /* no-store because the whole point is to show what was published a minute
       ago; a cached index would show the author the state before their post. */
    var response = await fetch('/posts-index.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('status ' + response.status);
    var data = await response.json();
    if (token !== postsLoadToken) return;
    postsIndex = Array.isArray(data) ? data : [];
    renderPostsList();
  } catch (error) {
    if (token !== postsLoadToken) return;
    holder.innerHTML = '';
    holder.appendChild(emptyNote('Could not load the list of published posts.'));
  }
}

function renderPostsList() {
  var holder = $('posts-list');
  var query = ($('post-search').value || '').trim().toLowerCase();
  holder.innerHTML = '';
  /* Only the current type: openPostSource refuses a post of another type
     anyway, so offering them here would be offering a dead end. */
  var rows = (postsIndex || []).filter(function (post) {
    if (post.type !== typeKey) return false;
    if (!query) return true;
    return (post.name + ' ' + post.title + ' ' + post.slug).toLowerCase().indexOf(query) !== -1;
  });
  if (!rows.length) {
    holder.appendChild(emptyNote(
      query ? 'No posts match that search.' : 'Nothing published yet.'
    ));
    return;
  }
  rows.forEach(function (post) { holder.appendChild(postRow(post)); });
}

function postRow(post) {
  var row = document.createElement('div');
  row.className = 'post-row';

  /* The row itself opens the post: the whole row is the target, so reaching a
     post does not depend on hitting a small control. */
  var open = document.createElement('button');
  open.type = 'button';
  open.className = 'post-open';
  var name = document.createElement('strong');
  name.textContent = post.name || post.title || post.slug;
  open.appendChild(name);
  var meta = document.createElement('span');
  meta.className = 'post-meta';
  /* An undated post is called out rather than left blank: it is the one that
     never reached the homepage, and this is where someone would notice. */
  meta.textContent = (post.displayDate || 'No date') + ' \u00b7 ' + post.url;
  open.appendChild(meta);
  open.addEventListener('click', function () { openPublishedPost(post); });
  row.appendChild(open);

  var remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-sm btn-danger';
  remove.textContent = 'Unpublish';
  remove.disabled = !signedIn;
  if (!signedIn) remove.title = 'Sign in to unpublish';
  remove.setAttribute('aria-label', 'Unpublish ' + (post.name || post.slug));
  remove.addEventListener('click', function () { unpublishFromList(post, row, remove); });
  row.appendChild(remove);

  return row;
}

async function openPublishedPost(post) {
  if (!signedIn) { setStatus('posts-status', 'Sign in to open a published post.', 'error'); return; }
  setStatus('posts-status', 'Opening ' + (post.name || post.slug) + '\u2026', 'busy');
  try {
    var url = '/api/post?type=' + encodeURIComponent(post.type) +
      '&slug=' + encodeURIComponent(post.slug);
    var response = await fetch(url, { headers: await authHeaders() });
    var data = await response.json().catch(function () { return {}; });
    if (response.status === 401) { handleUnauthorized(); return; }
    if (!response.ok) {
      setStatus('posts-status', data.message || 'Could not open that post.', 'error');
      return;
    }
    setStatus('posts-status', '');
    /* openPostSource toasts its own refusal and leaves the form alone, so the
       drawer only closes once the post is actually loaded. */
    var before = openedSlug;
    openPostSource(data.source);
    if (openedSlug !== before || openedSlug === post.slug) closeDrawer();
  } catch (error) {
    setStatus('posts-status', 'Could not reach the site.', 'error');
  }
}

async function unpublishFromList(post, row, button) {
  var label = post.name || post.title || post.slug;
  // Removal cannot be undone from here, and the row is one click from Open.
  if (!window.confirm('Unpublish \u201c' + label + '\u201d? The page will disappear from the site.')) return;
  button.disabled = true;
  setStatus('posts-status', 'Unpublishing ' + label + '\u2026', 'busy');
  try {
    var response = await fetch('/api/unpublish', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ type: post.type, slug: post.slug })
    });
    var data = await response.json().catch(function () { return {}; });
    if (response.ok) {
      /* The index still lists it until the next build finishes, so the row is
         removed here rather than by re-fetching -- a reload would put it back
         and read as a failure. */
      postsIndex = (postsIndex || []).filter(function (p) {
        return !(p.slug === post.slug && p.type === post.type);
      });
      row.parentNode.removeChild(row);
      if (!$('posts-list').children.length) renderPostsList();
      /* The form may be holding the post that just stopped existing; a later
         publish must not send mode: 'update' for a path that is gone. */
      if (openedSlug === post.slug) {
        openedSlug = null;
        updatePublishAvailability();
      }
      setStatus('posts-status', 'Unpublished ' + label + '. The page disappears in about a minute.', 'ok');
      return;
    }
    if (response.status === 401) handleUnauthorized();
    setStatus('posts-status', data.message || 'Unpublishing failed. Nothing was changed.', 'error');
    button.disabled = false;
  } catch (error) {
    setStatus('posts-status', 'Could not reach the site.', 'error');
    button.disabled = false;
  }
}

/* --------------------------------------------------------------- actions */

async function openPostFile(file) {
  openPostSource(await file.text());
}

/* Shared by the local file picker and the published-posts drawer: the bytes
   are the same either way, so everything that decides whether a post can be
   loaded belongs here rather than in each caller. */
function openPostSource(source) {
  var post;
  try {
    post = parsePost(source);
  } catch (err) {
    /* The reader is an author, not a developer: say what to fix, and do not
       load half a post that a later save would write back with the rest
       missing. */
    toast('Could not open that post — ' + err.message);
    return;
  }
  /* A block the renderer does not know would vanish from the page without a
     word. Say so instead: the file is newer than this editor, or hand-edited. */
  var known = def.blocks;
  var unknown = (post.blocks || []).map(function (b) { return b.type; })
    .filter(function (t) { return known.indexOf(t) === -1; });
  if (unknown.length) {
    toast('That post uses a block this editor does not know: ' + unknown.join(', '));
    return;
  }
  /* The form only has inputs for the current type's fields, so loading a post
     of another type would drop everything the form cannot show -- and a later
     save would write the file back without it. */
  var fileType = String(post.type || 'fff').trim() || 'fff';
  if (!POST_TYPES[fileType]) {
    toast('That post has a type this editor does not know: ' + fileType);
    return;
  }
  if (fileType !== typeKey) {
    toast('That is a ' + POST_TYPES[fileType].label + ' post. Change the type at the top of the form, then open it again.');
    return;
  }
  model = Object.assign(emptyModel(), post, { date: post.displayDate });
  openedSlug = model.slug || null;
  slugTouched = true;   // an opened post owns its slug; the name must not rewrite it
  updatePublishAvailability();
  renderAll();
  save();
  toast('Opened ' + (post.name || post.title || post.slug));
}

/* The object both downloadPost and publishPayload serialize. Kept as one
   function so the published file can never drift from the downloaded one --
   see the comment on publishPayload below for why that guarantee matters.
   Returns null (after a toast explaining what to fix) when the post is not
   in a publishable state. */
function buildPostObject() {
  var m = resolved();
  var firstField = def.slugSource === 'title' ? 'title' : 'name';
  if (!m.slug) { toast('Add a ' + firstField + ' first'); return null; }
  /* A Jobs & Happenings post has no title fallback to borrow, so a blank one
     would publish as an empty headline and an empty card. Refuse it here,
     where the author can see the field, rather than letting the file out. */
  if (!postTitle(m)) { toast('Add a post title — this post type has no default title.'); return null; }
  /* Without this the post still publishes and still appears on its listing,
     so the omission is invisible until someone notices it is missing from the
     homepage. Catch it here, where the field is on screen. */
  if (!m.isoDate) { toast('Add the ISO date — without it the post never reaches the homepage.'); return null; }
  var bad = badSlugChars(m.slug);
  if (bad.length) { toast(SLUG_MESSAGE + bad.join(' ')); return null; }
  var post = Object.assign({}, m, { type: typeKey, displayDate: m.date });
  delete post.date;
  /* An untouched optional field is empty, and the renderer treats an empty
     value exactly as it treats an absent one. Writing `ogTitle: ""` would put
     a line in the file that means nothing and shows up in the diff of every
     post this editor reopens. */
  Object.keys(post).forEach(function (key) {
    if (post[key] === '') delete post[key];
  });
  /* Block ids are this editor's own handle on a form row. They mean nothing
     to the renderer and would land in a committed file as noise. */
  post.blocks = (m.blocks || []).map(function (b) {
    var copy = Object.assign({}, b);
    delete copy.id;
    return copy;
  });
  return post;
}

function downloadPost() {
  var post = buildPostObject();
  if (!post) return;
  downloadBlob(
    new Blob([serializePost(post)], { type: 'text/plain;charset=utf-8' }),
    post.slug + '.html'
  );
}

/* The published file must match the downloaded one byte for byte, so this
   reuses the same object downloadPost writes -- including stripping block
   ids, which serializePost does not do and which would otherwise land in
   every published post as noise. */
function publishPayload(image) {
  var post = buildPostObject();
  /* The model can change during the await in publishPost() (coverAsBase64()
     is async), so this second call can fail even though the guard at the top
     of publishPost() passed. Propagate null rather than deleting a property
     off it -- buildPostObject() has already toasted the specific reason. */
  if (!post) return null;
  var blocks = post.blocks;
  delete post.blocks;
  delete post.type;
  return {
    type: typeKey,
    mode: (openedSlug && openedSlug === post.slug) ? 'update' : 'create',
    fields: post,
    blocks: blocks,
    // ext travels with the image so api/publish.js writes the SAME
    // extension this payload's bytes actually are -- coverAsBase64() only
    // ever produces a jpg (the resize path) or, with "keep original"
    // checked, whatever outputExt() says (refused earlier by
    // coverExtIsPublishable() unless that is also jpg or png).
    image: image ? { base64: image, ext: outputExt() } : null
  };
}

async function publishPost() {
  var status = $('publish-status');
  var button = $('btn-publish');
  /* Refuse the same three things buildPostObject refuses before spending a
     round trip on it -- an author should not learn about a blank title from
     the server. buildPostObject() has already toasted the reason. */
  if (!buildPostObject()) return;
  if (!coverExtIsPublishable()) {
    setStatus(status, 'That cover image is a .' + cover.ext + ' file with "keep original" checked — ' +
      'only JPG and PNG can be published that way. Uncheck "keep original" (it will be resized to a JPG), ' +
      'or choose a JPG or PNG cover instead.', 'error');
    return;
  }
  button.disabled = true;
  // A reload during "Publishing…" must be knowably safe: nothing here times
  // out (a promise timeout was deliberately ruled against -- a slow request
  // that eventually succeeds must not be raced against a fake failure), so
  // the one thing an author can control if it seems stuck is told to them
  // up front instead of left to worry that a reload might duplicate or
  // half-finish something.
  setStatus(status, 'Publishing… if this doesn’t finish in about a minute, reload and try again — nothing has been published yet.', 'busy');
  try {
    var image = await coverAsBase64();
    var payload = publishPayload(image);
    /* The author edited the form during the await above and it is no longer
       publishable. The specific toast already fired inside buildPostObject();
       leave the status line clear rather than layering a generic failure over
       it, and let the finally block below re-enable the button. */
    if (!payload) { setStatus(status, ''); return; }
    var response = await fetch('/api/publish', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(payload)
    });
    var data = await response.json().catch(function () { return {}; });
    if (response.ok) {
      /* Without this, a post published as 'create' stays 'create' forever:
         a second publish with no changes would send 'create' again and the
         server's 409 guard would refuse it, with no way to recover short of
         reopening a file the author never downloaded. Read from the
         response, not from the payload this client sent -- the server
         decides the real address (api/publish.js sanitises the requested
         slug too), so its answer is the one to trust. */
      openedSlug = data.slug;
      updatePublishAvailability();
      setStatus(status, 'Published. Live in about a minute: ' + data.url, 'ok');
      return;
    }
    if (response.status === 401) handleUnauthorized();
    setStatus(status, data.message || 'Publishing failed. Nothing was changed.', 'error');
  } catch (error) {
    setStatus(status, error.message || 'Publishing failed. Nothing was changed.', 'error');
  } finally {
    button.disabled = !signedIn;
  }
}

/* Requires the author to type the post's canonical address rather than a
   window.confirm() dialog: a browser modal blocks the page and cannot be
   driven from a test, and this deletes a live page with no review step and
   no developer to restore it. The slug typed and the slug sent are both
   openedSlug -- the slug of the post this session actually opened or just
   published -- not resolved().slug, the current form's slug. Using the form's
   slug would target whatever the author has typed so far, including an
   unsaved retitle: open a live post, retitle it without publishing, and
   resolved().slug no longer names anything that was ever published, while
   the real live page stays up untouched and the confirm field would ask for
   (and accept) that same wrong address. openedSlug is the one slug this
   session actually knows to be live. btn-unpublish is disabled whenever it is
   null (see updatePublishAvailability), so this is a defensive second check,
   not the only guard. */
async function unpublishPost() {
  var status = $('unpublish-status');
  var slug = openedSlug;
  if (!slug) { setStatus(status, 'Open or publish a post first.', 'error'); return; }
  if ($('unpublish-confirm').value.trim() !== slug) {
    setStatus(status, 'Type ' + slug + ' to confirm.', 'error');
    return;
  }
  var button = $('btn-unpublish');
  button.disabled = true;
  setStatus(status, 'Unpublishing…', 'busy');
  try {
    var response = await fetch('/api/unpublish', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ type: typeKey, slug: slug })
    });
    var data = await response.json().catch(function () { return {}; });
    if (response.ok) {
      /* The file at this slug no longer exists. Leaving openedSlug set would
         make a later publish of this same form send mode: 'update' for a
         path that is gone, and api/publish.js's own exists-check would
         refuse it with a 409 -- so clear it, the same way clearAll() and
         applyDraft() already do when the model no longer matches a live
         post. This also disables btn-unpublish again via
         updatePublishAvailability(), so a second click cannot re-target the
         same now-deleted address. */
      openedSlug = null;
      updatePublishAvailability();
      setStatus(status, 'Unpublished. The page will disappear in about a minute.', 'ok');
      $('unpublish-confirm').value = '';
      return;
    }
    if (response.status === 401) handleUnauthorized();
    setStatus(status, data.message || 'Unpublishing failed. Nothing was changed.', 'error');
  } catch (error) {
    setStatus(status, error.message || 'Unpublishing failed. Nothing was changed.', 'error');
  } finally {
    // Not a bare `false`: updatePublishAvailability() re-applies the real
    // signedIn/openedSlug gate, which the success path above may just have
    // changed to null.
    updatePublishAvailability();
  }
}

function exportJson() {
  var payload = JSON.stringify({ model: model, ext: cover.ext }, null, 2);
  var m = resolved();
  downloadBlob(
    new Blob([payload], { type: 'application/json' }),
    (m.slug || 'post') + '.json'
  );
}

function importJson(file) {
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var data = JSON.parse(String(reader.result));
      // openedSlug is cleared inside applyDraft(), which this always goes
      // through -- an imported draft is not the post this editor was opened
      // against, even if it happens to carry the same slug.
      applyDraft({ model: data.model || data, slugTouched: true, ext: data.ext });
      save();
      toast('Imported');
    } catch (e) {
      toast('Could not read that JSON');
    }
  };
  reader.readAsText(file);
}

function clearAll() {
  if (!confirm('Start a new post? The current draft will be discarded.')) return;
  if (cover.blobUrl) URL.revokeObjectURL(cover.blobUrl);
  cover = { file: null, blobUrl: null, ext: 'jpg' };
  model = emptyModel();
  /* Otherwise a new post that happens to land on the slug the previous
     "opened" post had -- a retyped title, a fixed typo -- would still
     compare equal to openedSlug and publish as 'update', silently
     overwriting a live post the author never opened to edit. */
  openedSlug = null;
  updatePublishAvailability();
  slugTouched = false;
  $('img-file').value = '';
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  renderAll();
}

/* ------------------------------------------------------------------ init */

function renderAll() {
  var coverInput = $('f-coverPath');
  if (coverInput) coverInput.value = model.coverPath || '';
  renderFields();
  renderBlocks();
  renderImagePanel();
  renderPreview();
}

function init() {
  var select = $('type-select');
  /* A hidden type is not offered, but it IS still shown when it is the type
     already loaded via ?type=. That keeps a deliberate escape hatch: if a type
     is hidden while published posts of it still exist, someone can reach the
     editor with ?type= to open and unpublish them, and switch back afterwards.
     Without the exception the control would carry a value with no matching
     option, which renders blank. */
  var offered = Object.keys(TYPES).filter(function (key) {
    return !POST_TYPES[key].hidden || key === typeKey;
  });
  offered.forEach(function (key) {
    var opt = document.createElement('option');
    opt.value = key;
    opt.textContent = POST_TYPES[key].label;
    select.appendChild(opt);
  });
  select.value = typeKey;
  select.disabled = offered.length < 2;

  /* Switching type reloads with ?type=, which is where typeKey comes from.
     Each type keeps its own autosaved draft, so nothing is lost either way. */
  select.addEventListener('change', function () {
    var next = select.value;
    if (next === typeKey) return;
    if (!POST_TYPES[next]) { select.value = typeKey; return; }
    location.search = '?type=' + encodeURIComponent(next);
  });

  renderAddRow();
  renderAll();
  // Sets btn-unpublish's initial disabled state: openedSlug starts null, so
  // this matches the button's static `disabled` attribute in the markup, but
  // computing it here (rather than trusting the attribute alone) is what
  // keeps the two buttons' gating in one place.
  updatePublishAvailability();

  var draft = loadDraft();
  if (draft && draft.model) showRestoreBanner(draft);

  startClerk();
  $('btn-download').addEventListener('click', downloadPost);
  $('btn-publish').addEventListener('click', publishPost);
  $('btn-open-post').addEventListener('click', openPostsDrawer);
  $('btn-open-file').addEventListener('click', function () { $('post-file').click(); });
  $('btn-posts-close').addEventListener('click', closeDrawer);
  $('post-search').addEventListener('input', renderPostsList);
  $('btn-account').addEventListener('click', function () { openDrawer('account-drawer', 'btn-account'); });
  $('btn-drawer-close').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && drawerIsOpen()) closeDrawer();
  });
  $('post-file').addEventListener('change', function (e) {
    if (e.target.files[0]) openPostFile(e.target.files[0]);
    e.target.value = '';
  });
  $('btn-unpublish').addEventListener('click', unpublishPost);
  $('btn-invite').addEventListener('click', sendInvite);
  $('btn-export').addEventListener('click', exportJson);
  $('btn-clear').addEventListener('click', clearAll);
  $('btn-import').addEventListener('click', function () { $('import-file').click(); });
  $('import-file').addEventListener('change', function (e) {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = '';
  });
  $('img-file').addEventListener('change', function (e) { onFilePicked(e.target.files[0]); });
  $('btn-img-download').addEventListener('click', downloadRenamedImage);
  $('img-keep').addEventListener('change', function () {
    renderImagePanel();   // the target extension changes with this checkbox
    schedulePreview();
  });
  $('f-coverPath').addEventListener('input', function (e) {
    model.coverPath = e.target.value;
    onChange();
  });
  $('btn-desktop').addEventListener('click', function () { setPreviewWidth(false); });
  $('btn-mobile').addEventListener('click', function () { setPreviewWidth(true); });
  window.addEventListener('resize', fitPreview);
  fitPreview();
}

/* The two width buttons are a segmented control, so the pressed one has to
   be marked: aria-pressed both announces the state and drives the styling,
   which previously left an author guessing which width they were looking at. */
function setPreviewWidth(mobile) {
  $('preview').classList.toggle('mobile', mobile);
  $('btn-desktop').setAttribute('aria-pressed', mobile ? 'false' : 'true');
  $('btn-mobile').setAttribute('aria-pressed', mobile ? 'true' : 'false');
  fitPreview();
}

/* Scale the iframe down to fit the pane. The iframe keeps its real pixel
   width so the post's own media queries fire at the width being previewed;
   only the visual result is scaled. The stage element reserves the scaled
   footprint, since transforms don't affect layout. */
function fitPreview() {
  var frame = $('preview');
  var stage = $('preview-stage');
  var wrap = frame.parentNode.parentNode;
  if (!frame || !stage || !wrap) return;

  var available = wrap.clientWidth - 32;   // .preview-wrap padding
  var natural = frame.classList.contains('mobile') ? 390 : 1240;
  var scale = Math.min(1, available / natural);

  frame.style.transform = 'scale(' + scale + ')';
  stage.style.width = Math.round(natural * scale) + 'px';
  stage.style.height = Math.round(frame.offsetHeight * scale) + 'px';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

window.WIF_EDITOR = {
  getModel: function () { return resolved(); },
  setModel: function (m) { applyDraft({ model: m, slugTouched: true }); }
};
