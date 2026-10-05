/* Slide-in drawers shared by the admin pages. Nothing here knows about Clerk:
   each page opens its account drawer and its own list drawer through this. */

import { $ } from './dom.js';

/* Which drawer is open, and what opened it -- closing returns focus to the
   control the author came from rather than always to the account button. */
var openDrawerId = null;
var drawerTriggerId = null;

export function drawerIsOpen() {
  return !!openDrawerId;
}

export function openDrawer(id, triggerId) {
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

export function closeDrawer() {
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
