import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

/* Same technique as tools/editor-unpublish.test.mjs -- see that file's own
   comment for why this is the only way to exercise editor.js's actual
   DOM-driven code (as opposed to lib/post-types.mjs's coverPathFor in
   isolation, which tools/post-types.test.mjs already covers) under plain
   Node. */
register('./_test-lib-loader.mjs', import.meta.url);

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

let loadCount = 0;
async function loadEditor(typeParam) {
  loadCount += 1;
  globalThis.window = globalThis;
  globalThis.location = { search: '?type=' + (typeParam || 'post') };
  const doc = makeFakeDocument();
  globalThis.document = doc;
  globalThis.localStorage = makeFakeLocalStorage();
  if (typeof globalThis.addEventListener !== 'function') globalThis.addEventListener = function () {};
  // Node's real URL.createObjectURL only accepts an actual Blob; the fake
  // File-like objects these tests hand editor.js are not one, so it is
  // always overridden here rather than only when absent.
  globalThis.URL.createObjectURL = () => 'blob:fake';
  globalThis.URL.revokeObjectURL = () => {};
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

// FIX 4 (final wave): EXT_BY_MIME admits webp/avif/gif, but api/publish.js
// only ever writes a jpg or a png. "Keep original" on anything outside that
// pair must be refused in the editor, with no network call -- letting it
// through would mean the server's allowlist decides it silently (or,
// before FIX 4, that the wrong bytes got written under the right-looking
// extension entirely).
test('publishing a webp cover with "keep original" checked is refused, no network call', async () => {
  const doc = await loadEditor('post');

  const titleInput = doc.getElementById('f-title');
  titleInput.value = 'October Recap';
  titleInput.fire('input');

  const fakeWebp = { type: 'image/webp', name: 'cover.webp' };
  doc.getElementById('img-file').fire('change', { target: { files: [fakeWebp] } });

  doc.getElementById('img-keep').checked = true;
  doc.getElementById('img-keep').fire('change');

  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };

  doc.getElementById('btn-publish').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fetchCalled, false, 'a non-publishable "keep original" extension must never reach the network');
  assert.match(doc.getElementById('publish-status').textContent, /webp/);
  assert.match(doc.getElementById('publish-status').textContent, /keep original/i);
});

// A jpg with "keep original" unchecked (the ordinary resize path) must NOT
// be refused -- proves the check above is scoped to keep-original, not to
// publishing an image at all.
test('publishing a jpg cover with "keep original" unchecked is not refused by the ext check', async () => {
  const doc = await loadEditor('post');

  const titleInput = doc.getElementById('f-title');
  titleInput.value = 'October Recap';
  titleInput.fire('input');

  const fakeJpg = { type: 'image/jpeg', name: 'cover.jpg' };
  doc.getElementById('img-file').fire('change', { target: { files: [fakeJpg] } });
  // img-keep left unchecked (default false).

  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: false, status: 400, json: async () => ({ message: 'stop here -- image encoding is not under test' }) };
  };

  doc.getElementById('btn-publish').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  // It may still fail downstream (coverAsBase64 needs a real Image/canvas
  // this fake DOM does not provide), but it must get PAST the ext check --
  // i.e. never show the "keep original" refusal message.
  assert.ok(!/keep original/i.test(doc.getElementById('publish-status').textContent));
});
