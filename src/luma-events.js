/* Shared renderer for the Luma-backed event cards.
 *
 * Four pages show upcoming events: the Events page (all cities, every event)
 * and the three chapter pages (one city, the next two). They all read the same
 * /api/events endpoint, which reads Luma's public feed on the server and
 * merges in the manually committed events.
 *
 * Every caller keeps the events already in its HTML as the fallback: if the
 * endpoint is unreachable, or has nothing for that city, the markup on the
 * page is left untouched rather than replaced with an empty section.
 *
 * An event may legitimately arrive with no coverUrl and no tags -- the feed
 * does not carry tags at all, and only the soonest few events are enriched
 * with a cover. card() below renders both cases, and that is not a bug to be
 * tidied away.
 */
(function () {
  const DEFAULT_VARIANTS = ['', 'v-pink', 'v-plum', 'v-sun', 'v-mint'];

  function fmt(iso, timezone, opts) {
    try {
      return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: timezone }, opts)).format(new Date(iso));
    } catch (e) {
      return new Intl.DateTimeFormat('en-US', opts).format(new Date(iso));
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;   // never innerHTML: event names come from Luma
    return node;
  }

  function eventTag(ev) {
    if (ev.tags && ev.tags.length) return ev.tags[0];
    if (ev.membersOnly) return 'Members only';
    if (ev.locationType === 'zoom' || ev.locationType === 'meet') return 'Online';
    return 'In person';
  }

  function card(ev, index, variants) {
    const variant = variants[index % variants.length];
    const a = el('a', 'event' + (variant ? ' ' + variant : ''));
    a.href = ev.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.dataset.city = ev.city;

    const img = el('div', 'event-img');
    if (ev.coverUrl) {
      img.classList.add('has-cover');
      img.style.backgroundImage = 'url("' + encodeURI(ev.coverUrl) + '")';
    } else {
      img.appendChild(el('span', null, 'NYC Fintech Women'));
    }
    const chip = el('div', 'date-chip');
    chip.appendChild(el('div', 'd', fmt(ev.startAt, ev.timezone, { day: '2-digit' })));
    chip.appendChild(el('div', 'm', fmt(ev.startAt, ev.timezone, { month: 'short' })));
    img.appendChild(chip);
    a.appendChild(img);

    const body = el('div', 'event-body');
    body.appendChild(el('span', 'event-tag', eventTag(ev)));
    body.appendChild(el('h3', 'event-name', ev.name));

    const meta = el('div', 'event-meta');
    meta.appendChild(el('span', null,
      fmt(ev.startAt, ev.timezone, { month: 'short', day: 'numeric' }) + ' · ' +
      fmt(ev.startAt, ev.timezone, { hour: 'numeric', minute: '2-digit' })));
    if (ev.place) {
      meta.appendChild(el('span', 'sep', '·'));
      meta.appendChild(el('span', null, ev.place));
    }
    body.appendChild(meta);
    body.appendChild(el('span', 'event-cta', 'RSVP →'));
    a.appendChild(body);
    return a;
  }

  /* load({ grid, city, limit, variants, onRender })
   *   grid     — container whose children are replaced on success (required)
   *   city     — 'nyc' | 'sf' | 'chi' to show one chapter only; omit for all
   *   limit    — maximum cards to render; omit for all of them
   *   variants — colour cycle, so each page keeps the palette it was designed with
   *   onRender — called after a successful replace (the Events page re-applies
   *              its city filter here)
   */
  async function load(options) {
    const grid = options.grid;
    if (!grid) return;
    const city = options.city || null;
    const limit = options.limit || 0;
    const variants = options.variants || DEFAULT_VARIANTS;

    grid.classList.add('is-loading');
    try {
      // no-store applies to the *browser* cache only; the CDN still serves its
      // own cached copy (s-maxage=300), so Luma is not hit on every view.
      const res = await fetch('/api/events', { cache: 'no-store', headers: { accept: 'application/json' } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.warn('[events] keeping built-in events — /api/events returned', res.status, body.error || '');
        return;
      }
      const data = await res.json();
      let events = Array.isArray(data.events) ? data.events : [];
      if (city) events = events.filter((ev) => ev.city === city);
      if (limit) events = events.slice(0, limit);
      if (!events.length) {
        console.warn('[events] keeping built-in events — no upcoming events' + (city ? ' for ' + city : ''));
        return;
      }
      grid.replaceChildren(...events.map((ev, index) => card(ev, index, variants)));
      if (options.onRender) options.onRender();
    } catch (err) {
      console.warn('[events] keeping built-in events —', err.message);
    } finally {
      grid.classList.remove('is-loading');
    }
  }

  window.LumaEvents = { load: load };
})();
