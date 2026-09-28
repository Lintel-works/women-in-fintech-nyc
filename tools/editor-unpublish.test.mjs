import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { serializePost } from '../lib/post-file.mjs';

/* editor.js imports from '/lib/...' -- a server-relative path only a browser
   or a dev server can resolve. This loader (see its own file for why) makes
   that resolvable under plain Node, which is what makes it possible to
   exercise unpublishPost() itself -- the actual DOM-driven code path -- for
   the one thing a browser has never been available to check in this repo:
   which slug a click on Unpublish actually sends. */
register('./_test-lib-loader.mjs', import.meta.url);

/* A minimal stand-in DOM. Every element auto-vivifies with generic defaults
   (a real browser element's shape editor.js incidentally touches --
   clientWidth, parentNode, classList, etc.) so init()'s layout code
   (fitPreview, renderFields, renderBlocks...) runs to completion without
   crashing, even though none of it is what this test is checking.

   Critically, `id` is an accessor, not a plain property: editor.js builds
   its form inputs with document.createElement(...) and then assigns
   `input.id = 'f-' + f.key` (renderFields in src/admin/editor.js) -- it never
   calls document.getElementById to register them. A real DOM resolves
   getElementById by searching the live tree, so that assignment alone is
   enough; this fake has no tree to search, so the accessor below registers
   the element into the SAME map getElementById reads, the moment editor.js
   sets its id. Without this, doc.getElementById('f-slug') in a test returns
   a disconnected dummy element that editor.js's own listeners never touch --
   which is exactly the failure mode that let an earlier draft of this test
   pass while silently testing nothing. */
function makeFakeDocument() {
  const registry = new Map();

  function makeElement(initialId) {
    const handlers = {};
    let idValue = initialId || '';
    const el = {
      value: '', textContent: '', innerHTML: '', className: '',
      disabled: false, title: '', checked: false, type: '', placeholder: '',
      maxLength: 0, style: {}, clientWidth: 800, offsetHeight: 100,
      parentNode: { clientWidth: 800, offsetHeight: 100, parentNode: { clientWidth: 800, offsetHeight: 100 } },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      children: [],
      appendChild(child) { el.children.push(child); return child; },
      removeChild(child) { const i = el.children.indexOf(child); if (i >= 0) el.children.splice(i, 1); },
      setAttribute(k, v) { if (k === 'id') { el.id = v; } else el[k] = v; },
      addEventListener(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); },
      removeEventListener() {},
      fire(evtName, payload) { (handlers[evtName] || []).slice().forEach((fn) => fn(payload || { target: el })); },
      click() { el.fire('click'); },
      querySelector() { return null; },
      focus() {}
    };
    Object.defineProperty(el, 'id', {
      enumerable: true,
      get() { return idValue; },
      set(v) { idValue = v; if (v) registry.set(v, el); }
    });
    if (initialId) registry.set(initialId, el);
    return el;
  }

  return {
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeElement(id));
      return registry.get(id);
    },
    createElement() { return makeElement(); },
    createTextNode(text) { return { nodeType: 3, textContent: text }; },
    addEventListener() {},
    body: makeElement('body'),
    readyState: 'complete'
  };
}

function makeFakeLocalStorage() {
  const store = new Map();
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); }
  };
}

/* Loads a fresh copy of editor.js under a fresh fake DOM. The query string
   busts the ESM cache -- editor.js runs its module-level init() as a side
   effect of being imported, and each test needs that to happen again against
   its own document, not a cached module instance from an earlier test. */
let loadCount = 0;
async function loadEditor(typeParam) {
  loadCount += 1;
  globalThis.window = globalThis;
  globalThis.location = { search: '?type=' + (typeParam || 'post') };
  const doc = makeFakeDocument();
  globalThis.document = doc;
  globalThis.localStorage = makeFakeLocalStorage();
  if (typeof globalThis.addEventListener !== 'function') globalThis.addEventListener = function () {};
  const editorUrl = new URL('../src/admin/editor.js', import.meta.url).href + '?instance=' + loadCount;
  await import(editorUrl);
  /* The type these tests asked for must be the type the editor actually
     loaded. Jobs & Happenings is hidden for launch, and editor.js falls back
     to fff for a type it will not offer -- so without this check a change to
     that fallback would leave every test below silently exercising the FFF
     form while claiming to test the news form. Failing loudly is the point. */
  assert.equal(
    doc.getElementById('type-select').value,
    typeParam || 'post',
    'the editor loaded a different type than the test asked for'
  );
  return doc;
}

test('unpublish sends openedSlug, not the current form\'s (possibly edited) slug', async () => {
  const doc = await loadEditor('post');

  // Simulate "Open post": the real, DOM-driven path openedSlug is actually
  // set through, exercising openPostFile() itself rather than a shortcut.
  const live = serializePost({
    type: 'post', slug: 'live-post', title: 'Live Post', blocks: []
  });
  const fakeFile = { text: async () => live };
  doc.getElementById('post-file').fire('change', { target: { files: [fakeFile], value: '' } });
  // openPostFile is async; let its promise chain settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Retitle without publishing: edit the slug field directly, which is what
  // makes resolved().slug diverge from openedSlug (openPostFile sets
  // slugTouched = true, so the title field alone would not do it).
  const slugInput = doc.getElementById('f-slug');
  slugInput.value = 'a-totally-different-address';
  slugInput.fire('input');

  doc.getElementById('unpublish-confirm').value = 'live-post';

  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ commit: 'abc123' }) };
  };

  doc.getElementById('btn-unpublish').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1, 'expected exactly one /api/unpublish call');
  assert.equal(calls[0].url, '/api/unpublish');
  assert.equal(calls[0].body.slug, 'live-post', 'must target the slug the post was opened at, not the edited form slug');
  assert.notEqual(calls[0].body.slug, 'a-totally-different-address');
});

test('unpublish refuses (no fetch call) when the confirm text does not match openedSlug', async () => {
  const doc = await loadEditor('post');

  const live = serializePost({ type: 'post', slug: 'another-live-post', title: 'Another', blocks: [] });
  const fakeFile = { text: async () => live };
  doc.getElementById('post-file').fire('change', { target: { files: [fakeFile], value: '' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  doc.getElementById('unpublish-confirm').value = 'not-the-right-slug';

  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };

  doc.getElementById('btn-unpublish').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fetchCalled, false, 'a mismatched confirm string must not reach the network');
  assert.match(doc.getElementById('unpublish-status').textContent, /another-live-post/);
});
