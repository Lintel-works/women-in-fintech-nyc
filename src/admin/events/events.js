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

/* The stored ISO carries an offset, so the instant is unambiguous -- but the
   form edits a WALL-CLOCK time in the event's own zone. Reading it back with
   getHours() would give the viewer's zone, so an author in London editing a
   New York event would see 11pm, "correct" it, and move the event. */
function partsInZone(iso, zone) {
  var fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  var p = {};
  fmt.formatToParts(new Date(iso)).forEach(function (part) { p[part.type] = part.value; });
  /* en-CA gives hour "24" for midnight in some engines; the form wants "00". */
  var hour = p.hour === '24' ? '00' : p.hour;
  return { date: p.year + '-' + p.month + '-' + p.day, time: hour + ':' + p.minute };
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
  /* The slug field is disabled while editing, but the filename is what the
     endpoint keys on, so it comes from the opened event, not the field. */
  if (openedSlug) entry.slug = openedSlug;
  var problem = validate(entry);
  if (problem) { setStatus('add-status', problem, 'error'); return; }

  $('btn-add').disabled = true;
  setStatus('add-status', openedSlug ? 'Saving…' : 'Adding the event…', 'busy');

  var payload = { mode: openedSlug ? 'update' : 'create', event: entry };
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
      setStatus('add-status', result.message ||
        (openedSlug ? 'Saving failed. Nothing was changed.' : 'Adding the event failed. Nothing was changed.'), 'error');
      updateAvailability();
      return;
    }
    if (openedSlug) {
      /* Kept populated: the author is mid-edit, and the cover they just
         chose is now committed, so the file input is cleared rather than
         re-sent on the next save. */
      setStatus('add-status', 'Saved. The change is live once the deploy finishes.', 'ok');
      $('img-file').value = '';
      onCoverChosen();
    } else {
      setStatus('add-status',
        'Added. It appears on the site once the deploy finishes, a minute or two from now.', 'ok');
      resetForm();
      setOpened('');
    }
    loadEvents();
  } catch (error) {
    setStatus('add-status', 'The request failed. Check your connection and try again.', 'error');
  }
  updateAvailability();
}

function resetForm() {
  ['f-name', 'f-start-date', 'f-start-time', 'f-end-date', 'f-end-time',
   'f-url', 'f-place', 'f-tags', 'f-coverUrl', 'f-slug'].forEach(function (id) {
    $(id).value = '';
  });
  $('f-membersOnly').checked = false;
  /* An opened event may have left these on a non-default value. */
  ['f-city', 'f-locationType', 'f-timezone'].forEach(function (id) {
    $(id).selectedIndex = 0;
  });
  $('img-file').value = '';
  onCoverChosen();
  refresh();
}

/* ---------------------------------------------------------- open and remove */

/* The event this session has actually opened, or '' for a new one.
 *
 * This is what decides mode, and it is set ONLY by opening an event from the
 * drawer or cleared by setOpened('') -- never by what is typed in the address
 * field. An author who types an existing address into a new event gets the
 * 409 from api/add-event.js, which is the correct answer: it is a different
 * event that happens to want a taken name.
 */
var openedSlug = '';
var loadedEvents = [];

function setOpened(slug) {
  openedSlug = slug || '';
  $('edit-status').textContent = openedSlug ? 'Editing ' + openedSlug : 'New event';
  /* The slug is the filename, so changing it on an existing event would write
     a second file and leave the first -- one event silently becoming two.
     Renaming is remove-then-add, which is honest: a renamed event is a new
     address. */
  $('f-slug').disabled = !!openedSlug;
  $('f-slug').title = openedSlug
    ? 'An event\'s address cannot change. Remove it and add it again under the new name.' : '';
  $('remove-panel').hidden = !openedSlug;
  $('remove-panel').open = false;
  $('remove-confirm').value = '';
  $('btn-remove').disabled = true;
  setStatus('remove-status', '');
  $('btn-add').textContent = openedSlug ? 'Save changes' : 'Add this event';
}

async function loadEvents() {
  setStatus('events-status', 'Loading…', 'busy');
  $('events-list').innerHTML = '';
  try {
    var response = await fetch('/api/manual-events', { headers: await authHeaders() });
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      if (response.status === 401) handleUnauthorized();
      setStatus('events-status', response.status === 401
        ? 'Sign in to see the events you have added.'
        : (result.message || 'The list could not be loaded.'), 'error');
      return;
    }
    setStatus('events-status', '');
    loadedEvents = result.events || [];
    renderEvents(loadedEvents);
  } catch (error) {
    setStatus('events-status', 'The list could not be loaded. Check your connection.', 'error');
  }
}

function renderEvents(events) {
  var list = $('events-list');
  list.innerHTML = '';
  if (!events.length) {
    list.innerHTML = '<p class="empty-note">No events added yet.</p>';
    return;
  }
  events.forEach(function (event) {
    var row = document.createElement('div');
    row.className = 'post-row';
    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'post-open';
    open.innerHTML = '<strong></strong><span class="post-meta"></span>';
    open.querySelector('strong').textContent = event.name || event.slug;
    var when = event.startAt ? new Date(event.startAt).toLocaleString() : 'no date';
    open.querySelector('.post-meta').textContent = event.slug + ' · ' + when +
      (event.over ? ' · over' : '') + (event.broken ? ' · invalid' : '');
    open.addEventListener('click', function () { openEvent(event.slug); });
    row.appendChild(open);
    list.appendChild(row);
  });
}

function selectHas(id, value) {
  return Array.prototype.some.call($(id).options, function (option) {
    return option.value === value;
  });
}

/* Opened from the LIST's own data rather than re-fetching the file: the list
   came from the branch a moment ago, and each row carries its whole entry. */
function openEvent(slug) {
  var row = loadedEvents.filter(function (item) { return item.slug === slug; })[0];
  if (!row) return;
  var entry = row.entry || {};
  var notes = [];

  $('f-name').value = entry.name || '';
  /* The filename is authoritative; a hand-written file may have no slug. */
  $('f-slug').value = row.slug;
  $('f-url').value = entry.url || '';
  $('f-place').value = entry.place || '';
  $('f-city').value = selectHas('f-city', entry.city) ? entry.city : 'other';
  $('f-locationType').value =
    entry.locationType === 'offline' || entry.locationType === 'zoom' ? entry.locationType : 'offline';
  $('f-membersOnly').checked = entry.membersOnly === true;
  $('f-tags').value = (entry.tags || []).join(', ');
  $('f-coverUrl').value = entry.coverUrl || '';
  /* The file input is left alone: a cover already committed is not
     re-uploaded, and the endpoint carries coverPath forward on its own. */

  var zone = selectHas('f-timezone', entry.timezone) ? entry.timezone : 'America/New_York';
  if (zone !== entry.timezone) {
    notes.push('This event\'s time zone (' + (entry.timezone || 'none') +
      ') is not one this form offers, so it is shown in New York time. Check the times before saving.');
  }
  $('f-timezone').value = zone;

  var start = entry.startAt ? partsInZone(entry.startAt, zone) : { date: '', time: '' };
  var end = entry.endAt ? partsInZone(entry.endAt, zone) : { date: '', time: '' };
  $('f-start-date').value = start.date;
  $('f-start-time').value = start.time;
  $('f-end-date').value = end.date;
  $('f-end-time').value = end.time;

  if (row.broken) {
    notes.push('The stored event is invalid. Saving will correct it.');
  }

  setOpened(slug);
  refresh();
  setStatus('add-status', notes.join(' '), notes.length ? 'error' : '');
  closeDrawer();
}

/* The confirm field matches against the slug this session actually opened,
   not against anything typed elsewhere -- the editor's rule, for the same
   reason: the point is to make the author name what they are destroying. */
function onConfirmInput() {
  $('btn-remove').disabled = !openedSlug || slugify($('remove-confirm').value) !== openedSlug;
}

async function removeEvent() {
  if (!openedSlug || slugify($('remove-confirm').value) !== openedSlug) return;
  $('btn-remove').disabled = true;
  setStatus('remove-status', 'Removing…', 'busy');
  try {
    var response = await fetch('/api/remove-event', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ slug: openedSlug })
    });
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      if (response.status === 401) handleUnauthorized();
      setStatus('remove-status', result.message || 'Removing the event failed. Nothing was changed.', 'error');
      onConfirmInput();
      return;
    }
    resetForm();
    setOpened('');
    setStatus('add-status', 'Removed. It comes off the site once the deploy finishes.', 'ok');
    loadEvents();
  } catch (error) {
    setStatus('remove-status', 'Removing the event failed. Check your connection.', 'error');
    onConfirmInput();
  }
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
  $('btn-new').addEventListener('click', function () {
    resetForm();
    setOpened('');
    setStatus('add-status', '');
  });
  $('btn-open-event').addEventListener('click', function () {
    openDrawer('events-drawer', 'btn-open-event');
    loadEvents();
  });
  $('btn-events-close').addEventListener('click', closeDrawer);
  $('remove-confirm').addEventListener('input', onConfirmInput);
  $('btn-remove').addEventListener('click', removeEvent);
  $('btn-account').addEventListener('click', function () {
    openDrawer('account-drawer', 'btn-account');
  });
  $('btn-drawer-close').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && drawerIsOpen()) closeDrawer();
  });
  setOpened('');
  refresh();
});
