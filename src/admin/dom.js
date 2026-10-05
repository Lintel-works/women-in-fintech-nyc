/* The two DOM helpers every admin page needs. They lived in four files at
   once and had already drifted apart — one copy printed "undefined" for a
   missing message and kept the tone class on a cleared line, the others did
   not. One copy, so the next edit lands everywhere.

   Status text alone cannot tell you whether something worked: 'Published.'
   and 'Publishing failed.' render identically as grey copy. Every status goes
   through setStatus() so the tone — busy, ok, error — carries a colour and a
   glyph from .status-line as well as the wording. */

export function $(id) { return document.getElementById(id); }

export function setStatus(target, message, tone) {
  var el = typeof target === 'string' ? $(target) : target;
  if (!el) return;
  el.textContent = message || '';
  el.className = 'status-line' + (message && tone ? ' is-' + tone : '');
}
