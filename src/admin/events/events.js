/* /admin/events/ — add an event that was never in Luma.
 *
 * The form refuses what lib/event-entry.mjs refuses, in the field, where the
 * author can see it — the same bargain the post editor strikes in
 * buildPostObject(). It does that by importing the very module the build
 * uses, rather than restating its rules: a second copy of them is the drift
 * lib/slug.mjs's header was written about.
 *
 * The server validates again regardless. This is for the author's benefit,
 * not the repository's.
 */
import { normalizeEntry } from '/lib/event-entry.mjs';
import { slugify } from '/lib/slug.mjs';

window.WIF_EVENTS = true;

var MAX_IMAGE_BYTES = 3000000;

function $(id) { return document.getElementById(id); }

function setStatus(target, message, tone) {
  var el = typeof target === 'string' ? $(target) : target;
  if (!el) return;
  el.textContent = message || '';
  el.className = 'status-line' + (message && tone ? ' is-' + tone : '');
}

/* ------------------------------------------------------------------ dates */

/* A local date and time plus a named zone, as an ISO string WITH an offset.
 *
 * Sending a naive "2026-11-12T18:00" is how an evening event retires at the
 * wrong moment: lib/event-entry.mjs reads it through new Date(), which treats
 * a bare timestamp as UTC — five hours off in New York, and in the wrong
 * direction. The offset is computed for the chosen zone ON THAT DATE, so an
 * event either side of a daylight-saving change gets the offset it actually
 * has rather than today's.
 */
function offsetFor(zone, date) {
  var format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, timeZoneName: 'longOffset'
  });
  var part = format.formatToParts(date).filter(function (p) {
    return p.type === 'timeZoneName';
  })[0];
  /* "GMT-05:00", or plain "GMT" at zero. */
  var name = part ? part.value : 'GMT';
  var match = name.match(/GMT([+-]\d{2}:\d{2})/);
  return match ? match[1] : '+00:00';
}

function isoWithOffset(dateValue, timeValue, zone) {
  if (!dateValue) return '';
  var time = timeValue || '00:00';
  /* The offset depends on the instant, and the instant depends on the offset.
     One pass at UTC gets within an hour of the answer, which is always enough
     to land on the right side of a daylight-saving boundary; the second pass
     uses the offset from that instant. */
  var guess = new Date(dateValue + 'T' + time + ':00Z');
  if (isNaN(guess.getTime())) return '';
  var offset = offsetFor(zone, guess);
  var settled = new Date(dateValue + 'T' + time + ':00' + offset);
  return dateValue + 'T' + time + ':00' + offsetFor(zone, settled);
}

/* ------------------------------------------------------------------- form */

var cover = { file: null, base64: '', ext: '', blobUrl: '' };
var signedIn = false;

function readForm() {
  var zone = $('f-timezone').value;
  var entry = {
    name: $('f-name').value.trim(),
    slug: slugify($('f-slug').value) || slugify($('f-name').value),
    startAt: isoWithOffset($('f-start-date').value, $('f-start-time').value, zone),
    endAt: isoWithOffset($('f-end-date').value, $('f-end-time').value, zone) || null,
    timezone: zone,
    url: $('f-url').value.trim(),
    city: $('f-city').value,
    place: $('f-place').value.trim(),
    locationType: $('f-locationType').value,
    membersOnly: $('f-membersOnly').checked,
    /* Split and trimmed here rather than sent as a string: normalizeEntry()
       guards with Array.isArray and would silently drop a string, leaving an
       author who typed tags with none and nothing to say why. */
    tags: $('f-tags').value.split(',').map(function (tag) {
      return tag.trim();
    }).filter(Boolean).slice(0, 3)
  };
  /* coverPath is the endpoint's to write, never the form's — so the form
     sends the BYTES and lets the server name the file. A hosted URL is a
     different field and goes as itself. */
  if (!cover.base64 && $('f-coverUrl').value.trim()) {
    entry.coverUrl = $('f-coverUrl').value.trim();
  }
  return entry;
}

/* What the build would say about this event, asked of the build's own code. */
function validate(entry) {
  if (!entry.startAt) return 'Choose a start date.';
  var verdict = normalizeEntry(entry, new Date(), 1);
  if (verdict.expired) {
    return 'That event has already finished, so it would not appear on the site.';
  }
  if (verdict.error) return 'This event cannot be added: ' + verdict.error + '.';
  return '';
}

function refresh() {
  $('f-slug').placeholder = slugify($('f-name').value) || 'event-address';
  var url = $('f-url').value.trim();
  /* An author pasting a lu.ma link has misunderstood what this page is for,
     so it is explained rather than reported as a validation error. */
  $('f-url-warn').hidden = !/^https?:\/\/(www\.)?(lu\.ma|luma\.com)\//i.test(url);
  updateAvailability();
}

function updateAvailability() {
  var button = $('btn-add');
  button.disabled = !signedIn;
  button.title = signedIn ? '' : 'Sign in to add an event';
}

/* ------------------------------------------------------------------ cover */

function onCoverChosen() {
  var file = $('img-file').files[0];
  /* A new pick or a reset replaces the thumbnail's blob; the old one would
     otherwise stay allocated for the life of the page. */
  if (cover.blobUrl) URL.revokeObjectURL(cover.blobUrl);
  cover = { file: null, base64: '', ext: '', blobUrl: '' };
  $('img-thumb').style.backgroundImage = '';
  $('img-thumb').textContent = 'No image';
  if (!file) { setStatus('img-status', ''); return; }

  /* The same two the site serves as a cover, and the same two
     api/add-event.js allows. Refused here so an author learns it from the
     field rather than from a failed submit. */
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
    setStatus('img-status', 'Use a JPG or a PNG.', 'error');
    $('img-file').value = '';
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    setStatus('img-status', 'That image is too large. Keep it under 3 MB.', 'error');
    $('img-file').value = '';
    return;
  }

  var ext = /\.png$/i.test(file.name) || file.type === 'image/png' ? 'png' : 'jpg';

  var reader = new FileReader();
  reader.onload = function () {
    /* readAsDataURL gives "data:image/jpeg;base64,…"; the prefix has to come
       off. Buffer.from() on the server does not throw on it — it skips the
       characters outside the alphabet and decodes to wrong bytes — so sending
       it would commit a corrupt image. isCleanBase64() catches that, but the
       author should never reach it. */
    var comma = String(reader.result).indexOf(',');
    cover = {
      file: file, ext: ext,
      base64: String(reader.result).slice(comma + 1),
      blobUrl: URL.createObjectURL(file)
    };
    $('img-thumb').textContent = '';
    $('img-thumb').style.backgroundImage = 'url(' + cover.blobUrl + ')';
    setStatus('img-status', file.name + ' ready.', 'ok');
    refresh();
  };
  reader.onerror = function () {
    setStatus('img-status', 'That image could not be read. Try choosing it again.', 'error');
  };
  reader.readAsDataURL(file);
}

/* ------------------------------------------------------------------ submit */

async function addEvent() {
  var entry = readForm();
  var problem = validate(entry);
  if (problem) { setStatus('add-status', problem, 'error'); return; }

  $('btn-add').disabled = true;
  setStatus('add-status', 'Adding the event…', 'busy');

  var payload = { mode: 'create', event: entry };
  if (cover.base64) payload.image = { base64: cover.base64, ext: cover.ext };

  try {
    var response = await fetch('/api/add-event', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(payload)
    });
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      if (response.status === 401) handleUnauthorized();
      setStatus('add-status', result.message || 'Adding the event failed. Nothing was changed.', 'error');
      updateAvailability();
      return;
    }
    setStatus('add-status',
      'Added. It appears on the site once the deploy finishes, a minute or two from now.', 'ok');
    resetForm();
  } catch (error) {
    setStatus('add-status', 'Adding the event failed. Check your connection and try again.', 'error');
  }
  updateAvailability();
}

function resetForm() {
  ['f-name', 'f-start-date', 'f-start-time', 'f-end-date', 'f-end-time',
   'f-url', 'f-place', 'f-tags', 'f-coverUrl', 'f-slug'].forEach(function (id) {
    $(id).value = '';
  });
  $('f-membersOnly').checked = false;
  $('img-file').value = '';
  onCoverChosen();
  refresh();
}

/* ------------------------------------------------------------------- auth */

var clerk = null;

/* A Clerk session token lives 60 SECONDS. Fetching one at sign-in and
   reusing it would produce a page that adds events successfully for about a
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
   itself says there is no session; otherwise leave the button enabled so the
   author can simply retry with a fresh token. */
function handleUnauthorized() {
  if (!clerk || !clerk.isSignedIn) {
    signedIn = false;
    updateAvailability();
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
    } else {
      signedIn = false;
      setStatus(status, '');
      updateAccountButton('');
      clerk.mountSignIn(mount);
    }
    updateAvailability();
  }

  clerk.addListener(function () { render(); });
}

/* ---------------------------------------------------------- account drawer */

/* Sign-in lives in a drawer rather than at the top of the form, where an
   author would scroll past it on every event. */
var openDrawerId = null;
var drawerTriggerId = null;

function drawerIsOpen() {
  return !!openDrawerId;
}

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

/* A throw inside initClerk would otherwise be an unhandled rejection and
   leave the author a blank panel with no explanation. */
function startClerk() {
  initClerk().catch(function () {
    setStatus('signin-status', 'Could not load the sign-in form. Check your connection and reload.', 'error');
  });
}

window.addEventListener('DOMContentLoaded', function () {
  startClerk();
  ['f-name', 'f-url', 'f-slug'].forEach(function (id) {
    $(id).addEventListener('input', refresh);
  });
  $('img-file').addEventListener('change', onCoverChosen);
  $('btn-add').addEventListener('click', addEvent);
  $('btn-account').addEventListener('click', function () {
    openDrawer('account-drawer', 'btn-account');
  });
  $('btn-drawer-close').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && drawerIsOpen()) closeDrawer();
  });
  refresh();
});
