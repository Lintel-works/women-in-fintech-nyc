/* Clerk sign-in shared by the admin pages. The server verifies the session
   token on every request and is what decides; the signed-in flag here only
   drives what each page's UI offers. */

import { $, setStatus } from './dom.js';

var clerk = null;
var signedIn = false;
var onAvailabilityChange = null;
var onSignedInChange = null;

export function isSignedIn() {
  return signedIn;
}

/* Read live rather than copied at sign-in, so a role change Clerk reports is
   seen by whoever asks. */
export function currentUser() {
  return clerk && clerk.user ? clerk.user : null;
}

function notifyAvailability() {
  if (onAvailabilityChange) onAvailabilityChange();
}

/* A Clerk session token lives 60 SECONDS. Fetching one at sign-in and
   reusing it would produce a page that works for about a minute and then
   returns 401 forever -- indistinguishable, to an author, from a revoked
   account. getToken() is therefore called per request, and never stored. */
export async function authHeaders() {
  var headers = { 'content-type': 'application/json' };
  if (clerk && clerk.session) {
    var token = await clerk.session.getToken();
    if (token) headers.authorization = 'Bearer ' + token;
  }
  return headers;
}

/* With 60-second tokens, a 401 usually means the token aged out mid-request,
   not that the author signed out. Only drop the signed-in state when Clerk
   itself says there is no session; otherwise leave the primary action
   enabled so the author can simply retry with a fresh token. */
export function handleUnauthorized() {
  if (!clerk || !clerk.isSignedIn) {
    signedIn = false;
    notifyAvailability();
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
    /* Runs only on a flip (see above), so a page's hook never fires for the
       intermediate sign-in steps. */
    if (onSignedInChange) onSignedInChange(signedIn);
    notifyAvailability();
  }

  clerk.addListener(function () { render(); });
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

/* options.onAvailabilityChange: the page re-evaluates its primary button
   whenever the signed-in state changes.
   options.onSignedInChange(signedIn): optional, for page-only UI that depends
   on who signed in. */
export function startClerk(options) {
  onAvailabilityChange = options && options.onAvailabilityChange || null;
  onSignedInChange = options && options.onSignedInChange || null;
  /* A throw inside initClerk would otherwise be an unhandled rejection and
     leave the author a blank panel with no explanation. */
  initClerk().catch(function () {
    setStatus('signin-status', 'Could not load the sign-in form. Check your connection and reload.', 'error');
  });
}
