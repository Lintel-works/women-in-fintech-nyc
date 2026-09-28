# Authenticated Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in author presses Publish in the deployed `/admin` editor and the post is live, with no review step and nobody to commit on their behalf.

**Architecture:** Two Vercel functions (`api/login.js`, `api/publish.js`) sit in front of three pure, unit-testable modules (`lib/session.mjs`, `lib/publish-validate.mjs`, `lib/github.mjs`). The browser sends structured data, never file bytes and never a path; the server validates it, renders it through the real renderer to prove it will build, serializes it with `lib/post-file.mjs`, and writes the post and its cover image to GitHub in a single commit via the Git Data API. Vercel's existing git integration rebuilds.

**Tech Stack:** Node 22, Vercel Functions (default Node runtime), Eleventy 3, plain ES modules, `node --test`, Node's built-in `crypto`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-28-authenticated-publishing-design.md`

## Global Constraints

- ES modules everywhere (`import`/`export`), never CommonJS. 2-space indent.
- **No new dependencies.** `node --test` is built in; `crypto` is built in. Nothing is added to `package.json`.
- Node 22.x (`package.json` `engines`).
- **No credential capable of writing to the repository may reach the browser.** `GITHUB_APP_*`, `AUTH_SECRET` and `AUTH_USERS` are read in `api/` only, never imported by `src/admin/`.
- The seven published FFF pages and every other page in `_site/` must stay **byte-identical** through every task. This phase adds server code and editor UI; it changes no template that a published page renders through.
- **`npm run verify` is NOT the gate.** Every page already differs from the `pre-eleventy` tag, so it always exits non-zero. The gate is a build-to-build canonicalized comparison: build at BASE, build the working tree, compare each file through the `canonicalize` export of `tools/htmlcanon.mjs`. `npm run verify` may still be run as a smoke test that all 18 pages are produced.
- Comments explain WHY, never WHAT. Match the density of the surrounding files.
- Errors surface in terms an author can act on: no stack traces as the primary message, no silent recovery.
- The path a post is written to is **always** computed server-side as `src/posts/<slug>.html`. No code path accepts a path from the client.

## Review Focus

Input classes the spec implies but no happy-path test exercises. Each has a test assigned to the task that owns the code.

1. **A tampered, truncated or forged session cookie** — a missing separator, a swapped signature, a payload edited to extend `exp`, an empty string. `verifySession` must return `null` for every one, never throw and never accept. → Task 1.
2. **A title that slugifies to nothing or to a traversal** — `"../../eleventy.config"`, `"..."`, `"   "`, emoji only, or a name of 400 characters. The computed path must stay inside `src/posts/` or the publish must be refused naming why. → Task 2.
3. **An image larger than the platform body limit** — Vercel caps a function request body at 4.5 MB. The editor must refuse or shrink before sending, with an author-readable message, rather than letting the request fail with an opaque 413. → Task 7.
4. **Two authors publishing at the same moment** — the second commit's parent is stale. The ref update must fail rather than clobber, retry once against the new head, and then surface "someone else just published". → Task 5.
5. **A post the renderer rejects** — an unknown block type, or content that makes `renderBlocks` throw. It must be refused *before* any GitHub call, with zero blobs and zero commits created. → Task 5.

---

## Task 1: `lib/session.mjs` — signing and verifying a session

**Files:**
- Create: `lib/session.mjs`
- Create: `tools/session.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `signSession(payload, secret)` → `string`. `payload` is `{ sub: string, exp: number }` where `exp` is epoch seconds. Returns `"<base64url-json>.<base64url-hmac>"`.
  - `verifySession(token, secret, now)` → the payload object, or `null`. `now` is epoch seconds, defaulting to `Date.now()/1000`, so tests control expiry without sleeping.
  - `SESSION_TTL_SECONDS` → `43200` (12 hours).

- [ ] **Step 1: Write the failing test**

```javascript
// tools/session.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, SESSION_TTL_SECONDS } from '../lib/session.mjs';

const SECRET = 'a-test-secret-that-is-long-enough';

test('a signed session verifies and returns its payload', () => {
  const exp = 1800000000;
  const token = signSession({ sub: 'jane@example.com', exp }, SECRET);
  assert.deepEqual(verifySession(token, SECRET, exp - 10), { sub: 'jane@example.com', exp });
});

test('the session TTL is twelve hours', () => {
  assert.equal(SESSION_TTL_SECONDS, 43200);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tools/session.test.mjs`
Expected: FAIL — cannot find module `../lib/session.mjs`.

- [ ] **Step 3: Write the minimal implementation**

```javascript
// lib/session.mjs
/* Session signing for the admin editor.
 *
 * Why this is a separate, pure module: it is the seam the whole auth decision
 * sits behind. api/publish.js asks it one question -- who is this caller --
 * and knows nothing about how they proved it. Swapping to GitHub OAuth or a
 * managed provider replaces this file and api/login.js and touches nothing
 * else. Being pure also means it tests under node --test with no server.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_SECONDS = 43200; // 12 hours

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(body, secret) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function signSession(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

export function verifySession(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const given = token.slice(dot + 1);

  const expected = sign(body, secret);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // Length must match before timingSafeEqual, which throws on a mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp <= now) return null;
  return payload;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tools/session.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the Review Focus tests (item 1 — hostile cookies)**

```javascript
test('a tampered signature is rejected', () => {
  const token = signSession({ sub: 'jane@example.com', exp: 1800000000 }, SECRET);
  const [body] = token.split('.');
  assert.equal(verifySession(`${body}.not-the-signature`, SECRET, 1799999990), null);
});

test('a payload edited to extend expiry is rejected', () => {
  const token = signSession({ sub: 'jane@example.com', exp: 1000 }, SECRET);
  const forged = Buffer.from(JSON.stringify({ sub: 'jane@example.com', exp: 9999999999 })).toString('base64url');
  assert.equal(verifySession(`${forged}.${token.split('.')[1]}`, SECRET, 2000), null);
});

test('a session signed with another secret is rejected', () => {
  const token = signSession({ sub: 'jane@example.com', exp: 1800000000 }, 'a-different-secret');
  assert.equal(verifySession(token, SECRET, 1799999990), null);
});

test('an expired session is rejected', () => {
  const token = signSession({ sub: 'jane@example.com', exp: 1000 }, SECRET);
  assert.equal(verifySession(token, SECRET, 1001), null);
});

test('malformed tokens are rejected without throwing', () => {
  for (const bad of ['', '.', 'nodot', '.leading', 'trailing.', null, undefined, 42, {}]) {
    assert.equal(verifySession(bad, SECRET, 1000), null, `accepted ${JSON.stringify(bad)}`);
  }
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tools/session.test.mjs`
Expected: PASS, 7 tests. If any throw rather than return `null`, fix `verifySession` — never the test.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS — 98 existing plus 7 new.

- [ ] **Step 8: Commit**

```bash
git add lib/session.mjs tools/session.test.mjs
git commit -m "Sign and verify editor sessions"
```

---

## Task 2: `lib/publish-validate.mjs` — validating a payload and computing its path

**Files:**
- Create: `lib/publish-validate.mjs`
- Create: `tools/publish-validate.test.mjs`

**Interfaces:**
- Consumes: `POST_TYPES`, `typeOf` from `lib/post-types.mjs` (Task 0 — already in the repo).
- Produces:
  - `slugify(text)` → `string`. Lowercase, non-alphanumerics to single hyphens, trimmed of leading/trailing hyphens, capped at 80 characters. Returns `''` when nothing survives.
  - `postPath(slug)` → `string`, always `src/posts/<slug>.html`.
  - `validatePublish(payload)` → `{ ok: true, type, slug, path, post }` or `{ ok: false, message }` where `message` is written for an author.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/publish-validate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, postPath, validatePublish } from '../lib/publish-validate.mjs';

test('a title becomes a slug', () => {
  assert.equal(slugify('October in Review: Three Sold-Out Nights'), 'october-in-review-three-sold-out-nights');
});

test('a valid news payload passes and computes its own path', () => {
  const result = validatePublish({
    type: 'post',
    mode: 'create',
    fields: { title: 'October Recap' },
    blocks: [{ type: 'p', text: 'A paragraph.' }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.slug, 'october-recap');
  assert.equal(result.path, 'src/posts/october-recap.html');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tools/publish-validate.test.mjs`
Expected: FAIL — cannot find module `../lib/publish-validate.mjs`.

- [ ] **Step 3: Write the minimal implementation**

```javascript
// lib/publish-validate.mjs
/* Validates what the browser sent and decides where it may be written.
 *
 * Why the server computes the path: if the browser supplied file text and a
 * destination, anything that compromised the editor page could write anywhere
 * in the repository -- eleventy.config.js, api/events.js, a CI workflow.
 * Deriving the path here from a validated type and a slugified title reduces
 * the write surface to one directory whatever the client sends.
 */
import { POST_TYPES } from './post-types.mjs';

const MAX_SLUG = 80;

/* The block types lib/render-blocks.mjs actually renders, verified by calling
   it with each. This list is load-bearing, not belt-and-braces: renderBlocks
   looks up BLOCK_RENDERERS[b.type] and returns '' on a miss, so an unknown
   block is dropped SILENTLY rather than throwing. The render gate in
   lib/publish.mjs cannot catch it. This is the only thing that can. */
const KNOWN_BLOCKS = new Set(['paragraph', 'heading', 'image', 'list', 'qa', 'quote']);

export function slugify(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
}

export function postPath(slug) {
  return `src/posts/${slug}.html`;
}

export function validatePublish(payload) {
  const fail = (message) => ({ ok: false, message });
  if (!payload || typeof payload !== 'object') return fail('Nothing was sent to publish.');

  const typeKey = String(payload.type || '').trim();
  const type = POST_TYPES[typeKey];
  if (!type) {
    return fail(`"${typeKey}" is not a post type. Choose one of: ${Object.keys(POST_TYPES).join(', ')}.`);
  }

  if (payload.mode !== 'create' && payload.mode !== 'update') {
    return fail('The editor did not say whether this is a new post or an edit. Reload and try again.');
  }

  const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
  const source = fields[type.slugSource];
  if (!String(source || '').trim()) {
    return fail(`Add a ${type.slugSource} — a ${type.label} post needs one before it can publish.`);
  }

  const slug = slugify(source);
  if (!slug) {
    return fail('That title has no letters or numbers in it, so it cannot become a web address. Add some words.');
  }

  const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
  for (const block of blocks) {
    const kind = block && block.type;
    if (!KNOWN_BLOCKS.has(kind)) {
      return fail(`This post contains a "${kind}" section, which the site does not know how to show.`);
    }
  }

  return { ok: true, type: typeKey, slug, path: postPath(slug), post: { ...fields, type: typeKey, slug, blocks } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tools/publish-validate.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Confirm the block list matches the renderer**

`renderBlocks` dispatches through a private `BLOCK_RENDERERS` map, so grepping for `case` finds nothing. Confirm empirically instead:

```bash
node -e "import('./lib/render-blocks.mjs').then(m => {
  for (const t of ['paragraph','heading','image','list','qa','quote','p','h2']) {
    const out = m.renderBlocks([{ type: t, text: 'x', items: ['a'], src: 'i.jpg', q: 'q', a: 'a' }]);
    console.log(t.padEnd(10), out ? 'RENDERS' : 'dropped silently');
  }
});"
```

Expected: the six in `KNOWN_BLOCKS` render; `p` and `h2` are dropped. If a type renders that `KNOWN_BLOCKS` omits, add it — a missing entry refuses a legitimate post. This set cannot be inferred from the render gate, because an unknown type is dropped silently rather than throwing.

- [ ] **Step 6: Write the Review Focus tests (item 2 — hostile titles)**

```javascript
test('a title that is only punctuation is refused, not silently pathed', () => {
  const result = validatePublish({
    type: 'post', mode: 'create', fields: { title: '...' }, blocks: []
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /letters or numbers/);
});

test('a traversal in the title cannot escape src/posts', () => {
  const result = validatePublish({
    type: 'post', mode: 'create', fields: { title: '../../eleventy.config' }, blocks: []
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, 'src/posts/eleventy-config.html');
  assert.ok(!result.path.includes('..'), 'path escaped src/posts/');
});

test('slugify never emits a path separator or a dot segment', () => {
  for (const hostile of ['../x', 'a/b/c', '..', './.', 'x\\y', '%2e%2e']) {
    const slug = slugify(hostile);
    assert.ok(!slug.includes('/'), `slash survived in ${hostile}`);
    assert.ok(!slug.includes('\\'), `backslash survived in ${hostile}`);
    assert.ok(slug !== '..' && slug !== '.', `dot segment survived in ${hostile}`);
  }
});

test('a very long title is capped and does not end in a hyphen', () => {
  const slug = slugify('word '.repeat(200));
  assert.ok(slug.length <= 80, `slug was ${slug.length} characters`);
  assert.ok(!slug.endsWith('-'), 'slug ended in a hyphen');
});

test('an emoji-only title is refused', () => {
  const result = validatePublish({
    type: 'post', mode: 'create', fields: { title: '🎉🎉🎉' }, blocks: []
  });
  assert.equal(result.ok, false);
});

test('an unknown post type is refused naming the known ones', () => {
  const result = validatePublish({
    type: 'newsletter', mode: 'create', fields: { title: 'Hello' }, blocks: []
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /fff/);
});

test('an unknown block type is refused', () => {
  const result = validatePublish({
    type: 'post', mode: 'create', fields: { title: 'Hello' },
    blocks: [{ type: 'video', src: 'x' }]
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /video/);
});

test('an fff post slugs from name, not title', () => {
  const result = validatePublish({
    type: 'fff', mode: 'create', fields: { name: 'Jane Doe' }, blocks: []
  });
  assert.equal(result.ok, true);
  assert.equal(result.slug, 'jane-doe');
});
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tools/publish-validate.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 8: Run the whole suite and commit**

```bash
npm test
git add lib/publish-validate.mjs tools/publish-validate.test.mjs
git commit -m "Validate a publish payload and compute its path"
```

---

## Task 3: `tools/hash-password.mjs` and `api/login.js` — signing in

**Files:**
- Create: `tools/hash-password.mjs`
- Create: `lib/password.mjs`
- Create: `api/login.js`
- Create: `tools/password.test.mjs`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `signSession`, `SESSION_TTL_SECONDS` from `lib/session.mjs`.
- Produces:
  - `hashPassword(password)` → `string` of the form `"<saltHex>:<hashHex>"`.
  - `verifyPassword(password, stored)` → `boolean`, timing-safe.
  - `POST /api/login` accepting `{ email, password }`, responding `204` with a `Set-Cookie`, or `401` with `{ error: 'bad_credentials' }`.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/password.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../lib/password.mjs';

test('a password verifies against its own hash', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
});

test('a wrong password does not verify', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('Correct Horse Battery Staple', stored), false);
});

test('two hashes of the same password differ, because the salt is random', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('a malformed stored value is rejected without throwing', () => {
  for (const bad of ['', 'nocolon', ':', 'a:', ':b', null, undefined]) {
    assert.equal(verifyPassword('x', bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the dummy hash api/login.js uses actually reaches scrypt', () => {
  // If this returns before hashing, the unknown-email path is fast and the
  // known-email path is slow, which tells an attacker which emails exist.
  // A valid-shaped dummy is the only thing that makes the timing equal.
  const DUMMY_HASH = '00'.repeat(16) + ':' + '00'.repeat(64);
  const start = process.hrtime.bigint();
  assert.equal(verifyPassword('anything', DUMMY_HASH), false);
  const dummyNs = process.hrtime.bigint() - start;

  const real = hashPassword('some real password');
  const start2 = process.hrtime.bigint();
  verifyPassword('wrong', real);
  const realNs = process.hrtime.bigint() - start2;

  // Both paths do the same scrypt work, so they land within an order of
  // magnitude. A dummy that short-circuits is ~1000x faster and fails here.
  const ratio = Number(realNs) / Number(dummyNs);
  assert.ok(ratio < 10 && ratio > 0.1, `timing differed by ${ratio.toFixed(1)}x — the dummy hash is short-circuiting`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tools/password.test.mjs`
Expected: FAIL — cannot find module `../lib/password.mjs`.

- [ ] **Step 3: Write `lib/password.mjs`**

```javascript
// lib/password.mjs
/* scrypt password hashing.
 *
 * scrypt is deliberately slow, which is the point: this project has no
 * storage to rate-limit sign-in attempts with, so the cost per guess is the
 * defence. Paired with generated (not chosen) passwords, online guessing is
 * not viable. Recorded as a mitigation, not a rate limiter.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  let salt, expected;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (!salt.length || expected.length !== KEYLEN) return false;
  const actual = scryptSync(String(password), salt, KEYLEN);
  return timingSafeEqual(actual, expected);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tools/password.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the hash generator**

```javascript
// tools/hash-password.mjs
/* node tools/hash-password.mjs 'the password'
 *
 * Prints one entry for AUTH_USERS. Setting up a new author is: generate a
 * long random password, run this, paste the line into the Vercel env var,
 * hand the author the password. Removing one is deleting its line.
 */
import { hashPassword } from '../lib/password.mjs';

const password = process.argv[2];
if (!password) {
  console.error("Usage: node tools/hash-password.mjs 'the password'");
  process.exit(1);
}
console.log(hashPassword(password));
```

- [ ] **Step 6: Write `api/login.js`**

```javascript
// api/login.js
/* POST /api/login — exchange an email and password for a session cookie.
 *
 * This is the only code that touches AUTH_USERS. It follows the discipline
 * api/events.js established: one method, nothing from the request forwarded
 * anywhere, and a response that never hints which half of the credential was
 * wrong -- that hint is what turns a leaked email list into a target list.
 *
 * Env:
 *   AUTH_SECRET — random string, at least 32 characters, signs the session
 *   AUTH_USERS  — JSON: {"jane@example.com": "<salt>:<hash>"}
 */
import { verifyPassword } from '../lib/password.mjs';
import { signSession, SESSION_TTL_SECONDS } from '../lib/session.mjs';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const secret = process.env.AUTH_SECRET;
  let users;
  try {
    users = JSON.parse(process.env.AUTH_USERS || '{}');
  } catch {
    users = null;
  }
  if (!secret || secret.length < 32 || !users || !Object.keys(users).length) {
    // Misconfiguration, not a bad password. Say so distinctly: an author
    // retyping a correct password forever is the worst possible failure here.
    console.error('Sign-in is not configured: AUTH_SECRET and/or AUTH_USERS missing or invalid');
    return response.status(503).json({ error: 'not_configured' });
  }

  const body = typeof request.body === 'object' && request.body ? request.body : {};
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  const stored = Object.prototype.hasOwnProperty.call(users, email) ? users[email] : null;
  // Hash even when the email is unknown, so a missing account and a wrong
  // password cost the same time and cannot be told apart from outside.
  //
  // The dummy must be a VALID hash shape or this does nothing: verifyPassword
  // rejects a malformed stored value before it reaches scryptSync, which would
  // make the unknown-email path fast and the known-email path slow -- exactly
  // the oracle this line exists to close.
  const DUMMY_HASH = '00'.repeat(16) + ':' + '00'.repeat(64);
  const ok = verifyPassword(password, stored || DUMMY_HASH);

  if (!stored || !ok) {
    return response.status(401).json({ error: 'bad_credentials' });
  }

  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = signSession({ sub: email, exp }, secret);
  response.setHeader(
    'Set-Cookie',
    `wif_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`
  );
  return response.status(204).end();
}
```

- [ ] **Step 7: Document the env vars**

Append to `.env.example`:

```
# Admin sign-in — required by /api/login and /api/publish.
#
# AUTH_SECRET signs the session cookie. Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Rotating it signs every author out; that is the intended way to do it.
AUTH_SECRET=

# AUTH_USERS maps an email to a scrypt hash. Add an author with:
#   node tools/hash-password.mjs 'their generated password'
# Passwords must be GENERATED, not chosen -- there is no rate limiting.
# Removing an author is deleting their entry.
AUTH_USERS={}
```

- [ ] **Step 8: Run the suite and commit**

```bash
npm test
git add lib/password.mjs tools/hash-password.mjs tools/password.test.mjs api/login.js .env.example
git commit -m "Exchange a password for a session cookie"
```

---

## Task 4: `lib/github.mjs` — one commit through the Git Data API

**Files:**
- Create: `lib/github.mjs`
- Create: `tools/github.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `commitFiles({ token, owner, repo, branch, message, author, files, fetchImpl })` → `{ sha, url }`.
    `files` is an array of `{ path, content, encoding }` where `encoding` is `'utf-8'` or `'base64'`, or `{ path, delete: true }`.
    `fetchImpl` defaults to global `fetch` and exists so tests drive it without a network.
  - `pathExists({ token, owner, repo, branch, path, fetchImpl })` → `boolean`. Used to enforce create-versus-update.
  - `commitWithRetry(options)` → `{ sha, url }`. Calls `commitFiles`, and on a single `stale_head` re-reads the head and tries once more. Extracted so the retry is testable rather than buried in a handler.
  - Throws `Error` with a `code` property: `'stale_head'` when the ref moved, `'auth'` on 401/403, `'github'` otherwise.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/github.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitFiles } from '../lib/github.mjs';

/* A scripted fetch: each call shifts the next canned response and records the
   request, so the test asserts the exact Git Data API sequence. */
function scriptedFetch(responses) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return {
      ok: next.status < 400,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body)
    };
  };
  impl.calls = calls;
  return impl;
}

test('a commit walks ref, commit, blob, tree, commit, ref', async () => {
  const fetchImpl = scriptedFetch([
    { status: 200, body: { object: { sha: 'HEADSHA' } } },          // get ref
    { status: 200, body: { tree: { sha: 'BASETREE' } } },           // get commit
    { status: 201, body: { sha: 'BLOB1' } },                        // create blob
    { status: 201, body: { sha: 'NEWTREE' } },                      // create tree
    { status: 201, body: { sha: 'NEWCOMMIT' } },                    // create commit
    { status: 200, body: { object: { sha: 'NEWCOMMIT' } } }         // update ref
  ]);

  const result = await commitFiles({
    token: 't', owner: 'o', repo: 'r', branch: 'main',
    message: 'Publish a post',
    author: { name: 'Jane', email: 'jane@example.com' },
    files: [{ path: 'src/posts/x.html', content: 'hello', encoding: 'utf-8' }],
    fetchImpl
  });

  assert.equal(result.sha, 'NEWCOMMIT');
  assert.equal(fetchImpl.calls.length, 6);
  assert.match(fetchImpl.calls[0].url, /git\/ref\/heads\/main$/);
  assert.equal(fetchImpl.calls[3].body.base_tree, 'BASETREE');
  assert.equal(fetchImpl.calls[4].body.parents[0], 'HEADSHA');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tools/github.test.mjs`
Expected: FAIL — cannot find module `../lib/github.mjs`.

- [ ] **Step 3: Write the implementation**

```javascript
// lib/github.mjs
/* Writes one commit containing any number of files, via the Git Data API.
 *
 * Why not the simpler Contents API: it writes one file per call, so a post
 * plus its cover image would be two commits and two deploys. Building a tree
 * lets the post and the image land together, which is what an author means by
 * "publish".
 *
 * fetchImpl is injectable so the sequence can be tested without a network.
 * The real GitHub write is exercised against a scratch repository in Task 10.
 */
const API = 'https://api.github.com';

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function call(fetchImpl, token, path, options = {}) {
  const response = await fetchImpl(`${API}${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'nyc-fintech-women-admin',
      ...(options.headers || {})
    }
  });
  if (response.status === 401 || response.status === 403) {
    throw fail('GitHub rejected the credential', 'auth');
  }
  if (response.status === 409 || response.status === 422) {
    throw fail('The branch moved before this commit could be written', 'stale_head');
  }
  if (!response.ok) {
    throw fail(`GitHub returned ${response.status}`, 'github');
  }
  return response.json();
}

export async function commitFiles({ token, owner, repo, branch, message, author, files, fetchImpl = fetch }) {
  const base = `/repos/${owner}/${repo}`;
  const head = await call(fetchImpl, token, `${base}/git/ref/heads/${branch}`);
  const headSha = head.object.sha;
  const headCommit = await call(fetchImpl, token, `${base}/git/commits/${headSha}`);
  const baseTree = headCommit.tree.sha;

  const tree = [];
  for (const file of files) {
    if (file.delete) {
      // A null sha in a tree entry deletes the path.
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = await call(fetchImpl, token, `${base}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: file.content, encoding: file.encoding })
    });
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await call(fetchImpl, token, `${base}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree })
  });

  const commit = await call(fetchImpl, token, `${base}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha], author })
  });

  await call(fetchImpl, token, `${base}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false })
  });

  return { sha: commit.sha, url: `https://github.com/${owner}/${repo}/commit/${commit.sha}` };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tools/github.test.mjs`
Expected: PASS, 1 test.

- [ ] **Step 5: Write the remaining tests**

```javascript
test('a deletion sends a null sha and creates no blob', async () => {
  const fetchImpl = scriptedFetch([
    { status: 200, body: { object: { sha: 'HEADSHA' } } },
    { status: 200, body: { tree: { sha: 'BASETREE' } } },
    { status: 201, body: { sha: 'NEWTREE' } },
    { status: 201, body: { sha: 'NEWCOMMIT' } },
    { status: 200, body: { object: { sha: 'NEWCOMMIT' } } }
  ]);
  await commitFiles({
    token: 't', owner: 'o', repo: 'r', branch: 'main', message: 'Unpublish',
    author: { name: 'Jane', email: 'jane@example.com' },
    files: [{ path: 'src/posts/x.html', delete: true }],
    fetchImpl
  });
  const treeCall = fetchImpl.calls.find((c) => c.url.endsWith('/git/trees'));
  assert.equal(treeCall.body.tree[0].sha, null);
  assert.ok(!fetchImpl.calls.some((c) => c.url.endsWith('/git/blobs')), 'a blob was created for a deletion');
});

test('a moved branch surfaces as stale_head', async () => {
  const fetchImpl = scriptedFetch([{ status: 409, body: { message: 'conflict' } }]);
  await assert.rejects(
    () => commitFiles({
      token: 't', owner: 'o', repo: 'r', branch: 'main', message: 'x',
      author: { name: 'J', email: 'j@example.com' }, files: [], fetchImpl
    }),
    (error) => error.code === 'stale_head'
  );
});

test('a rejected credential surfaces as auth', async () => {
  const fetchImpl = scriptedFetch([{ status: 401, body: { message: 'bad' } }]);
  await assert.rejects(
    () => commitFiles({
      token: 't', owner: 'o', repo: 'r', branch: 'main', message: 'x',
      author: { name: 'J', email: 'j@example.com' }, files: [], fetchImpl
    }),
    (error) => error.code === 'auth'
  );
});

test('the token never appears in a thrown message', async () => {
  const fetchImpl = scriptedFetch([{ status: 500, body: { message: 'boom' } }]);
  await assert.rejects(
    () => commitFiles({
      token: 'super-secret-token', owner: 'o', repo: 'r', branch: 'main', message: 'x',
      author: { name: 'J', email: 'j@example.com' }, files: [], fetchImpl
    }),
    (error) => !String(error.message).includes('super-secret-token')
  );
});
```

- [ ] **Step 6: Add `pathExists` and `commitWithRetry`**

```javascript
/* Whether a path already exists on the branch. This is what makes "create"
   and "update" mean something: without it, a new post silently overwrites an
   existing one whose title happens to slugify the same way. */
export async function pathExists({ token, owner, repo, branch, path, fetchImpl = fetch }) {
  const response = await fetchImpl(
    `${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'nyc-fintech-women-admin'
      }
    }
  );
  if (response.status === 404) return false;
  if (response.status === 401 || response.status === 403) {
    throw fail('GitHub rejected the credential', 'auth');
  }
  if (!response.ok) throw fail(`GitHub returned ${response.status}`, 'github');
  return true;
}

/* One retry, and only for a moved branch. Another author publishing at the
   same moment is the expected cause; commitFiles re-reads the head each time
   and never force-updates the ref, so retrying cannot clobber their commit. */
export async function commitWithRetry(options) {
  try {
    return await commitFiles(options);
  } catch (error) {
    if (error.code !== 'stale_head') throw error;
    return commitFiles(options);
  }
}
```

- [ ] **Step 7: Test them (Review Focus item 4 — simultaneous publishes)**

```javascript
import { pathExists, commitWithRetry } from '../lib/github.mjs';

test('pathExists is false on 404 and true on 200', async () => {
  assert.equal(await pathExists({
    token: 't', owner: 'o', repo: 'r', branch: 'main', path: 'src/posts/x.html',
    fetchImpl: scriptedFetch([{ status: 404, body: {} }])
  }), false);
  assert.equal(await pathExists({
    token: 't', owner: 'o', repo: 'r', branch: 'main', path: 'src/posts/x.html',
    fetchImpl: scriptedFetch([{ status: 200, body: { sha: 'abc' } }])
  }), true);
});

test('a stale head is retried once and then succeeds', async () => {
  const ok = [
    { status: 200, body: { object: { sha: 'HEAD2' } } },
    { status: 200, body: { tree: { sha: 'TREE2' } } },
    { status: 201, body: { sha: 'BLOB' } },
    { status: 201, body: { sha: 'TREE3' } },
    { status: 201, body: { sha: 'COMMIT2' } },
    { status: 200, body: { object: { sha: 'COMMIT2' } } }
  ];
  const fetchImpl = scriptedFetch([{ status: 409, body: {} }, ...ok]);
  const result = await commitWithRetry({
    token: 't', owner: 'o', repo: 'r', branch: 'main', message: 'x',
    author: { name: 'J', email: 'j@example.com' },
    files: [{ path: 'src/posts/x.html', content: 'hi', encoding: 'utf-8' }],
    fetchImpl
  });
  assert.equal(result.sha, 'COMMIT2');
});

test('a second stale head gives up rather than looping', async () => {
  const fetchImpl = scriptedFetch([{ status: 409, body: {} }, { status: 409, body: {} }]);
  await assert.rejects(
    () => commitWithRetry({
      token: 't', owner: 'o', repo: 'r', branch: 'main', message: 'x',
      author: { name: 'J', email: 'j@example.com' }, files: [], fetchImpl
    }),
    (error) => error.code === 'stale_head'
  );
});
```

- [ ] **Step 8: Run the tests and commit**

```bash
node --test tools/github.test.mjs
npm test
git add lib/github.mjs tools/github.test.mjs
git commit -m "Write one commit through the Git Data API"
```

---

## Task 5: `api/publish.js` — the write endpoint

**Files:**
- Create: `api/publish.js`
- Create: `lib/publish.mjs`
- Create: `tools/publish.test.mjs`

**Interfaces:**
- Consumes: `verifySession` (Task 1), `validatePublish` (Task 2), `commitWithRetry` and `pathExists` (Task 4), `serializePost` from `lib/post-file.mjs`, `buildPostView` from `lib/render-blocks.mjs`.
- Produces:
  - `preparePublish(payload)` → `{ ok: true, path, text, slug, type }` or `{ ok: false, message }`. Runs validation **and** the render gate. Pure; no I/O.
  - `POST /api/publish` responding `200 { url, commit }`, `401`, `400 { message }`, `409 { message }` or `503`.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/publish.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparePublish } from '../lib/publish.mjs';

test('a valid post prepares to file text at a computed path', () => {
  const result = preparePublish({
    type: 'post', mode: 'create',
    fields: { title: 'October Recap', gradient: 'g3' },
    blocks: [{ type: 'p', text: 'A paragraph.' }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, 'src/posts/october-recap.html');
  assert.match(result.text, /^---\n/);
  assert.match(result.text, /type: post/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tools/publish.test.mjs`
Expected: FAIL — cannot find module `../lib/publish.mjs`.

- [ ] **Step 3: Write `lib/publish.mjs`**

```javascript
// lib/publish.mjs
/* Turns a validated payload into the exact bytes of a post file -- and proves
 * they will render before anybody commits them.
 *
 * The render gate is the point of this module. A post that throws in the
 * renderer would fail the Vercel build, and a failed build leaves the previous
 * deployment serving: the site stays up, the post never appears, and nobody is
 * watching the build log to notice. Rendering here turns that silence into a
 * message the author reads while they are still looking at the screen.
 */
import { validatePublish } from './publish-validate.mjs';
import { serializePost } from './post-file.mjs';
import { buildPostView } from './render-blocks.mjs';

export function preparePublish(payload) {
  const valid = validatePublish(payload);
  if (!valid.ok) return valid;

  try {
    buildPostView(valid.post);
  } catch (error) {
    return { ok: false, message: `This post cannot be shown on the site yet: ${error.message}` };
  }

  return {
    ok: true,
    path: valid.path,
    slug: valid.slug,
    type: valid.type,
    text: serializePost(valid.post)
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tools/publish.test.mjs`
Expected: PASS, 1 test.

- [ ] **Step 5: Write the Review Focus test (item 5 — the render gate)**

```javascript
test('a post the renderer rejects is refused before anything is written', () => {
  // A block the validator allows but whose shape the renderer cannot use.
  const result = preparePublish({
    type: 'post', mode: 'create',
    fields: { title: 'Bad Post' },
    blocks: [{ type: 'list', items: 'not-an-array' }]
  });
  // Either the validator or the render gate must catch it. What must NOT
  // happen is ok:true with text that breaks the build.
  if (result.ok) {
    assert.fail('a post that cannot render was prepared for commit');
  }
  assert.ok(result.message.length > 0);
});

test('preparePublish performs no I/O and no network call', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('preparePublish made a network call'); };
  try {
    preparePublish({ type: 'post', mode: 'create', fields: { title: 'Fine' }, blocks: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 6: Run the test**

Run: `node --test tools/publish.test.mjs`
Expected: PASS, 3 tests. If `{ type: 'list', items: 'not-an-array' }` renders without throwing, replace it with an input that does throw — read `renderBlocks` in `lib/render-blocks.mjs` to find one, and keep the assertion.

- [ ] **Step 7: Write `api/publish.js`**

```javascript
// api/publish.js
/* POST /api/publish — the only code in this project that can write to the
 * repository.
 *
 * Order matters and every step refuses before the next: verify the session,
 * validate the payload, render it, and only then touch GitHub. Nothing is
 * committed until the post is known to build.
 *
 * Env:
 *   AUTH_SECRET   — verifies the session cookie (see api/login.js)
 *   GITHUB_TOKEN  — the GitHub App installation token; repo contents: write
 *   GITHUB_OWNER  — repository owner
 *   GITHUB_REPO   — repository name
 *   GITHUB_BRANCH — defaults to main
 */
import { verifySession } from '../lib/session.mjs';
import { preparePublish } from '../lib/publish.mjs';
import { commitWithRetry, pathExists } from '../lib/github.mjs';
import { POST_TYPES } from '../lib/post-types.mjs';

const MAX_IMAGE_BYTES = 3_500_000; // under Vercel's 4.5 MB body cap, with room for the JSON

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const secret = process.env.AUTH_SECRET;
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!secret || !token || !owner || !repo) {
    console.error('Publishing is not configured: missing AUTH_SECRET/GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }

  const session = verifySession(readCookie(request.headers.cookie, 'wif_session'), secret);
  if (!session) {
    return response.status(401).json({ message: 'Your session expired — sign in again.' });
  }

  const payload = typeof request.body === 'object' && request.body ? request.body : {};
  const prepared = preparePublish(payload);
  if (!prepared.ok) {
    return response.status(400).json({ message: prepared.message });
  }

  // Create versus update means nothing without this check: two different
  // titles can slugify the same way, and a "new" post landing on an existing
  // path would silently replace somebody else's work.
  try {
    const exists = await pathExists({ token, owner, repo, branch, path: prepared.path });
    if (payload.mode === 'create' && exists) {
      return response.status(409).json({
        message: 'A post already exists at that address. Change the title, or open the existing post to edit it.'
      });
    }
    if (payload.mode === 'update' && !exists) {
      return response.status(409).json({
        message: 'There is no published post at that address yet. Publish it as a new post instead.'
      });
    }
  } catch (error) {
    if (error.code === 'auth') {
      console.error('GitHub rejected the publishing credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Could not check whether the post already exists', error);
    return response.status(502).json({ message: 'Publishing failed. Nothing was changed.' });
  }

  const files = [{ path: prepared.path, content: prepared.text, encoding: 'utf-8' }];

  if (payload.image && payload.image.base64) {
    const bytes = Math.floor(String(payload.image.base64).length * 0.75);
    if (bytes > MAX_IMAGE_BYTES) {
      return response.status(400).json({
        message: 'That cover image is too large to publish. Choose a smaller one.'
      });
    }
    const prefix = POST_TYPES[prepared.type].prefix;
    files.push({
      path: `src/images/${prefix}${prepared.slug}.jpg`,
      content: String(payload.image.base64),
      encoding: 'base64'
    });
  }

  const commit = {
    token, owner, repo, branch,
    message: `Publish ${prepared.slug}\n\nPublished from the editor by ${session.sub}.`,
    author: { name: session.sub, email: session.sub },
    files
  };

  try {
    const result = await commitWithRetry(commit);
    return response.status(200).json({
      url: `/${POST_TYPES[prepared.type].prefix}${prepared.slug}.html`,
      commit: result.sha
    });
  } catch (error) {
    if (error.code === 'stale_head') {
      return response.status(409).json({ message: 'Someone else just published. Try again.' });
    }
    if (error.code === 'auth') {
      console.error('GitHub rejected the publishing credential');
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Publish failed', error);
    return response.status(502).json({ message: 'Publishing failed. Nothing was changed.' });
  }
}
```

- [ ] **Step 8: Run the suite and commit**

```bash
npm test
git add lib/publish.mjs api/publish.js tools/publish.test.mjs
git commit -m "Publish a post as one commit, after proving it renders"
```

---

## Task 6: The editor signs in

**Files:**
- Modify: `src/admin/index.html`
- Modify: `src/admin/editor.js`

**Interfaces:**
- Consumes: `POST /api/login` (Task 3).
- Produces: a `signedIn` state in the editor, and a `requireSession()` helper other editor code calls before a publish.

- [ ] **Step 1: Add the sign-in panel to `src/admin/index.html`**

Place it as the first child of the editor's main container, before the existing form:

```html
<section id="signin" class="sec">
  <h2>Sign in to publish</h2>
  <p class="hint">You can write and download a post without signing in. Publishing needs an account.</p>
  <label for="signin-email">Email</label>
  <input id="signin-email" type="email" autocomplete="username">
  <label for="signin-password">Password</label>
  <input id="signin-password" type="password" autocomplete="current-password">
  <button id="btn-signin" type="button">Sign in</button>
  <p id="signin-status" role="status"></p>
</section>
```

- [ ] **Step 2: Wire it in `src/admin/editor.js`**

Add near the other state declarations:

```javascript
/* Publishing state. The cookie itself is HttpOnly and unreadable here by
   design -- this flag only drives what the UI offers. The server is the thing
   that actually decides, on every request. */
var signedIn = false;
```

And the handler:

```javascript
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

function updatePublishAvailability() {
  var button = $('btn-publish');
  if (!button) return;
  button.disabled = !signedIn;
  button.title = signedIn ? '' : 'Sign in to publish';
}
```

- [ ] **Step 3: Register the listener**

In the existing listener-registration block, alongside `$('btn-download').addEventListener(...)`:

```javascript
$('btn-signin').addEventListener('click', signIn);
```

- [ ] **Step 4: Verify the page still loads and the build is unchanged**

```bash
npm run build
node --test tools/*.test.mjs
```

Then compare build-to-build against the previous commit per the Global Constraints gate. Expected: every published page identical. `src/admin/` is not a published page, so the count of changed pages must be **0**.

- [ ] **Step 5: Commit**

```bash
git add src/admin/index.html src/admin/editor.js
git commit -m "Sign in from the editor"
```

---

## Task 7: The editor shrinks the cover image before sending

**Files:**
- Modify: `src/admin/editor.js`

**Interfaces:**
- Consumes: the existing `cover` state object and its `cover.file`.
- Produces: `coverAsBase64()` → `Promise<string|null>`, a JPEG data payload with the `data:` prefix stripped, capped so the request stays under the platform limit.

- [ ] **Step 1: Write the resize helper**

```javascript
/* Vercel caps a function request body at 4.5 MB, and an unmodified phone
   photo can exceed that on its own -- founders-roundtable.jpg is 383 KB only
   because it has already been through something. So this is not an
   optimisation, it is what makes publishing work at all. */
var MAX_COVER_EDGE = 1600;
var COVER_QUALITY = 0.82;

function coverAsBase64() {
  return new Promise(function (resolve, reject) {
    if (!cover.file) { resolve(null); return; }
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, MAX_COVER_EDGE / Math.max(img.width, img.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      var url = canvas.toDataURL('image/jpeg', COVER_QUALITY);
      var comma = url.indexOf(',');
      if (comma === -1) { reject(new Error('The cover image could not be prepared.')); return; }
      resolve(url.slice(comma + 1));
    };
    img.onerror = function () {
      reject(new Error('That file could not be read as an image. Choose a JPG or PNG.'));
    };
    img.src = cover.blobUrl || URL.createObjectURL(cover.file);
  });
}
```

- [ ] **Step 2: Add the size guard (Review Focus item 3)**

Immediately before the `resolve(url.slice(comma + 1))` line:

```javascript
      // Base64 inflates by about a third; check the encoded length, which is
      // what actually travels, not the pixel dimensions.
      if (url.length > 3_500_000) {
        reject(new Error('That cover image is too large to publish even after shrinking. Choose a smaller one.'));
        return;
      }
```

- [ ] **Step 3: Verify by hand in the browser**

Run `npm run dev`, open `/admin/`, attach a large photo, and in the console:

```javascript
coverAsBase64().then(s => console.log('encoded length', s.length));
```

Expected: a length well under 3,500,000 for a typical phone photo, and a rejected promise with the author-readable message for a deliberately enormous image.

- [ ] **Step 4: Commit**

```bash
git add src/admin/editor.js
git commit -m "Shrink the cover image before publishing it"
```

---

## Task 8: The Publish button

**Files:**
- Modify: `src/admin/index.html`
- Modify: `src/admin/editor.js`

**Interfaces:**
- Consumes: `coverAsBase64()` (Task 7), `signedIn` and `updatePublishAvailability()` (Task 6), `POST /api/publish` (Task 5).
- Produces: nothing later tasks consume.

- [ ] **Step 1: Add the button beside the existing download button**

```html
<button id="btn-publish" type="button" disabled title="Sign in to publish">Publish</button>
<p id="publish-status" role="status"></p>
```

- [ ] **Step 2: Write the handler**

```javascript
async function publishPost() {
  var status = $('publish-status');
  var button = $('btn-publish');
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
```

- [ ] **Step 3: Add `buildPostObject()`, `publishPayload()` and `openedSlug`**

**Read `downloadPost()` in `src/admin/editor.js` first.** It does more than gather fields, and the published file must be byte-identical to the downloaded one — otherwise publishing and downloading produce different posts, which is the divergence this whole phase exists to remove.

`downloadPost()` currently: calls `resolved()`; refuses a missing slug, a blank `postTitle`, and bad slug characters; builds `Object.assign({}, m, { type: typeKey, displayDate: m.date })`; deletes `date`; deletes every empty-string key; and **strips the `id` from every block**.

That last step is not cosmetic. `serializePost` does NOT strip block ids — verified: a block carrying `id: "b1"` serializes it into the file. Sending `model.blocks` raw would write the editor's internal row handles into every published post.

Extract the shared part into `buildPostObject()`, returning the same object `downloadPost` serializes, and have **both** call it. Then:

```javascript
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
```

Note the real names: the current type is the module-level `typeKey` (editor.js:12), **not** `model.type`, which does not exist. The merged type definition is `def` (editor.js:16).

`openedSlug` does not exist and there is no "was this opened" state at all — `openPostFile` sets `model` and `slugTouched` and nothing else. Add `var openedSlug = null;` beside the other top-of-file state, set it to the opened post's slug inside `openPostFile` after the model is assigned, and leave it otherwise. Comparing it to the current slug means an opened post that is then retitled correctly publishes as a **create**, because it is going to a new address.

`publishPost()` must also refuse the same three things `downloadPost()` refuses, before sending — an author should not learn about a blank title from the server.

- [ ] **Step 4: Register the listener and verify the build**

```javascript
$('btn-publish').addEventListener('click', publishPost);
```

```bash
npm run build && npm test
```

Then the build-to-build gate: 0 published pages changed.

- [ ] **Step 5: Commit**

```bash
git add src/admin/index.html src/admin/editor.js
git commit -m "Publish from the editor"
```

---

## Task 9: Unpublish

**Files:**
- Create: `api/unpublish.js`
- Modify: `src/admin/index.html`
- Modify: `src/admin/editor.js`

**Interfaces:**
- Consumes: `verifySession` (Task 1), `slugify`/`postPath` (Task 2), `commitWithRetry` (Task 4).
- Produces: `POST /api/unpublish` accepting `{ type, slug }`, responding `200 { commit }`.

- [ ] **Step 1: Write `api/unpublish.js`**

```javascript
// api/unpublish.js
/* POST /api/unpublish — remove a published post.
 *
 * This exists because there is no review step and no developer. The first bad
 * post is a matter of time, and without this the only recovery is somebody
 * with a checkout running git revert -- the exact dependency this phase is
 * built to remove.
 */
import { verifySession } from '../lib/session.mjs';
import { slugify, postPath } from '../lib/publish-validate.mjs';
import { commitWithRetry } from '../lib/github.mjs';
import { POST_TYPES } from '../lib/post-types.mjs';

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const secret = process.env.AUTH_SECRET;
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!secret || !token || !owner || !repo) {
    console.error('Publishing is not configured: missing AUTH_SECRET/GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }

  const session = verifySession(readCookie(request.headers.cookie, 'wif_session'), secret);
  if (!session) {
    return response.status(401).json({ message: 'Your session expired — sign in again.' });
  }

  const typeKey = String((request.body || {}).type || '').trim();
  const type = POST_TYPES[typeKey];
  if (!type) return response.status(400).json({ message: 'That is not a post type.' });

  const slug = slugify(String((request.body || {}).slug || ''));
  if (!slug) return response.status(400).json({ message: 'Name the post to unpublish.' });

  try {
    const result = await commitWithRetry({
      token, owner, repo, branch,
      message: `Unpublish ${slug}\n\nUnpublished from the editor by ${session.sub}.`,
      author: { name: session.sub, email: session.sub },
      files: [{ path: postPath(slug), delete: true }]
    });
    return response.status(200).json({ commit: result.sha });
  } catch (error) {
    if (error.code === 'auth') {
      return response.status(503).json({ message: "The site's GitHub access is not working — contact the site owner." });
    }
    console.error('Unpublish failed', error);
    return response.status(502).json({ message: 'Unpublishing failed. Nothing was changed.' });
  }
}
```

`POST_TYPES` is imported to validate the type even though the path does not
use it: an unpublish naming a type that does not exist is a bug in the caller,
and refusing it is cheaper than deleting the wrong file.

- [ ] **Step 2: Add a confirm step in the editor**

The button must require typing the slug to confirm, because this deletes a live page and there is no review step and no developer to restore it:

```html
<details id="unpublish-panel" class="sec">
  <summary>Unpublish this post</summary>
  <p class="hint">This removes the page from the site. Type the post's address to confirm.</p>
  <input id="unpublish-confirm" type="text" autocomplete="off">
  <button id="btn-unpublish" type="button">Unpublish</button>
  <p id="unpublish-status" role="status"></p>
</details>
```

Do **not** use `window.confirm` — a browser modal blocks the page and is untestable.

- [ ] **Step 3: Wire the handler**

```javascript
async function unpublishPost() {
  var status = $('unpublish-status');
  var slug = slugify(model[typeDef().slugSource] || '');
  if ($('unpublish-confirm').value.trim() !== slug) {
    status.textContent = 'Type ' + slug + ' to confirm.';
    return;
  }
  status.textContent = 'Unpublishing…';
  var response = await fetch('/api/unpublish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: model.type, slug: slug })
  });
  var data = await response.json().catch(function () { return {}; });
  status.textContent = response.ok
    ? 'Unpublished. The page will disappear in about a minute.'
    : (data.message || 'Unpublishing failed. Nothing was changed.');
}
```

**`typeDef()` is illustrative, not verbatim — no such function exists today.** Read `src/admin/editor.js` and `src/admin/types.js` and use whatever accessor genuinely exists for the current type's definition (the editor already resolves `def` somewhere to render its field list). Add a named helper only if none exists, and say in your report which you used. Do not create a second accessor alongside an existing one.

- [ ] **Step 4: Verify and commit**

```bash
npm run build && npm test
git add api/unpublish.js src/admin/index.html src/admin/editor.js
git commit -m "Unpublish a post from the editor"
```

---

## Task 10: Setup, documentation and end-to-end verification

**Files:**
- Modify: `README.md`
- Create: `docs/publishing-setup.md`

**This task commits documentation only. It writes no application code.**

- [ ] **Step 1: Create the GitHub App**

Document the exact steps taken in `docs/publishing-setup.md` as you do them:
- Create a GitHub App owned by the **organization**, not a personal account.
- Permissions: **Repository contents: Read and write**. Nothing else.
- Install it on this repository only.
- Record the App ID and installation ID; generate a private key.
- Set `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` in Vercel (Production).

State plainly in that file **why an App and not a personal access token**: a PAT expires and belongs to a person who may leave, and publishing would die with either.

- [ ] **Step 2: Create the first author**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # AUTH_SECRET
node tools/hash-password.mjs "$(node -e "console.log(require('crypto').randomBytes(16).toString('base64url'))")"
```

Record in `docs/publishing-setup.md` that passwords are **generated, never chosen**, and why (there is no rate limiting; the password's entropy is the defence).

- [ ] **Step 3: End-to-end on the deployed site**

Against the production URL, with a real sign-in:
1. Sign in. Expect the status line to name the email.
2. Publish a news post with a cover image. Expect a URL back.
3. Confirm **one** commit appeared on `main` containing **both** the post file and the image.
4. Wait for the deploy; confirm the page is live, the card is on `happenings.html`, and the image loads.
5. Unpublish it. Confirm the page and card are gone after the rebuild.
6. Call `/api/publish` with no cookie (`curl -X POST`). Expect 401 and **no** new commit.
7. Publish a post whose title is `...`. Expect a 400 with the author-readable message and no commit.

- [ ] **Step 4: Confirm the published pages never moved**

Build at the phase's merge base and at HEAD, canonicalize both with the `canonicalize` export of `tools/htmlcanon.mjs`, and compare every file. Expected: the seven FFF pages and every other pre-existing page **identical**. This phase adds server code and editor UI; if any published page differs, stop and find out why.

- [ ] **Step 5: Update the README**

Replace the editor walkthrough's step 4 ("Download post file → save… Eleventy publishes it…") with the publish flow, and keep the download as the documented fallback. Add the new env vars to the environment section. Correct the standing claim that publishing requires a checkout — after this phase it does not.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/publishing-setup.md
git commit -m "Document the publishing setup"
```

---

## Notes for the executor

- **The seven FFF pages are the tripwire.** This phase should not change any published page. A non-zero changed count in the build-to-build gate means something is wrong, not that the baseline needs re-recording.
- **`npm run verify` always exits non-zero** and is not evidence of anything. Use the build-to-build comparison.
- **Never log a token, a password, or a session cookie**, including inside an error message. Task 4 has a test pinning this for the GitHub token; hold the same line everywhere.
- **`src/admin/` must never import from `api/`** and must never read an env var. If a task seems to need it, the design is wrong — stop and say so.
