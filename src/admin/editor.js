/* NYC Fintech Women — admin: form state, block list, preview, post files.
 *
 * An ES module, so it only works when served. It renders through the same
 * /lib modules the build uses; there is no second copy of anything here.
 */
import { renderBlocks as renderBlockHtml, renderInline } from '/lib/render-blocks.mjs';
import { serializePost, parsePost } from '/lib/post-file.mjs';
import { POST_TYPES, postTitle } from '/lib/post-types.mjs';
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

/* Publishing state. The cookie itself is HttpOnly and unreadable here by
   design -- this flag only drives what the UI offers. The server is the thing
   that actually decides, on every request. */
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

function emptyModel() {
  var m = { type: typeKey, blocks: [] };
  def.fields.forEach(function (f) { m[f.key] = ''; });
  m.coverPath = '';
  m.gradient = 'g1';
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
  m.slug = model.slug || slugify(model[def.slugSource] || '');
  m.coverPath = (model.coverPath || '').trim() ||
    ('images/' + def.prefix + (m.slug || 'post') + '.' + outputExt());
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

   Always re-encodes to JPEG, unlike downloadRenamedImage's PNG-transparency
   bypass below -- that checkbox is for a file the author keeps locally, but
   the publish payload has no such option: api/publish.js's own read-back
   check assumes the JPEG this function always produces. */
function coverAsBase64() {
  return new Promise(function (resolve, reject) {
    if (!cover.file) { resolve(null); return; }
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

async function signIn() {
  var email = $('signin-email').value.trim();
  var password = $('signin-password').value;
  var status = $('signin-status');
  status.textContent = 'Signing in…';
  try {
    var response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    });
    if (response.status === 204) {
      signedIn = true;
      status.textContent = 'Signed in as ' + email + '.';
      $('signin-password').value = '';
      updatePublishAvailability();
      return;
    }
    if (response.status === 503) {
      status.textContent = 'Publishing is not set up on this site yet.';
      return;
    }
    status.textContent = 'That email and password do not match.';
  } catch (error) {
    status.textContent = 'Could not reach the site to sign in. Check your connection.';
  }
}

/* btn-publish does not exist until Task 8 adds it -- a deliberate no-op
   until then. */
function updatePublishAvailability() {
  var button = $('btn-publish');
  if (!button) return;
  button.disabled = !signedIn;
  button.title = signedIn ? '' : 'Sign in to publish';
}

/* --------------------------------------------------------------- actions */

async function openPostFile(file) {
  var post;
  try {
    post = parsePost(await file.text());
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
  var blocks = post.blocks;
  delete post.blocks;
  delete post.type;
  return {
    type: typeKey,
    mode: (openedSlug && openedSlug === post.slug) ? 'update' : 'create',
    fields: post,
    blocks: blocks,
    image: image ? { base64: image } : null
  };
}

async function publishPost() {
  var status = $('publish-status');
  var button = $('btn-publish');
  /* Refuse the same three things buildPostObject refuses before spending a
     round trip on it -- an author should not learn about a blank title from
     the server. buildPostObject() has already toasted the reason. */
  if (!buildPostObject()) return;
  button.disabled = true;
  status.textContent = 'Publishing…';
  try {
    var image = await coverAsBase64();
    var response = await fetch('/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(publishPayload(image))
    });
    var data = await response.json().catch(function () { return {}; });
    if (response.ok) {
      status.textContent = 'Published. Live in about a minute: ' + data.url;
      return;
    }
    if (response.status === 401) { signedIn = false; updatePublishAvailability(); }
    status.textContent = data.message || 'Publishing failed. Nothing was changed.';
  } catch (error) {
    status.textContent = error.message || 'Publishing failed. Nothing was changed.';
  } finally {
    button.disabled = !signedIn;
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
  Object.keys(TYPES).forEach(function (key) {
    var opt = document.createElement('option');
    opt.value = key;
    opt.textContent = POST_TYPES[key].label;
    select.appendChild(opt);
  });
  select.value = typeKey;
  select.disabled = Object.keys(TYPES).length < 2;

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

  var draft = loadDraft();
  if (draft && draft.model) showRestoreBanner(draft);

  $('btn-signin').addEventListener('click', signIn);
  $('btn-download').addEventListener('click', downloadPost);
  $('btn-publish').addEventListener('click', publishPost);
  $('btn-open-post').addEventListener('click', function () { $('post-file').click(); });
  $('post-file').addEventListener('change', function (e) {
    if (e.target.files[0]) openPostFile(e.target.files[0]);
    e.target.value = '';
  });
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
  $('btn-desktop').addEventListener('click', function () {
    $('preview').classList.remove('mobile');
    fitPreview();
  });
  $('btn-mobile').addEventListener('click', function () {
    $('preview').classList.add('mobile');
    fitPreview();
  });
  window.addEventListener('resize', fitPreview);
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
