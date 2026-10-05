# Clerk User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `AUTH_USERS` environment variable with Clerk, so an admin invites authors by email from `/admin` and authors set, change, and recover their own passwords.

**Architecture:** Clerk owns identity. The browser loads Clerk from CDN script tags and calls `getToken()` before each request; serverless functions verify that RS256 token against a PEM public key held in an environment variable, using only Node's `crypto`. Three new admin-gated endpoints wrap Clerk's Backend API for invite, list, remove, and promote.

**Tech Stack:** Eleventy 3, Vercel serverless functions, Node 22, Clerk (CDN + Backend REST API), `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-01-clerk-user-management-design.md`

## Global Constraints

- **Zero npm runtime dependencies.** No `npm install` of any kind. Browser-side Clerk is two CDN `<script>` tags; server-side is `fetch` plus `node:crypto`.
- **Node 22.x** (`package.json` `engines`).
- **ES modules, `async`/`await`, 2-space indentation.** No `.then()` chains.
- **`src/admin/editor.js` uses `var` and `function` declarations throughout.** Match that style in that file; do not introduce `const`/arrow functions there.
- **Errors carry a `code` property** the handler branches on — the convention in `lib/github.mjs`, `lib/github-auth.mjs`, and `lib/mailer.mjs`.
- **Tests never touch the network.** `fetch` is injected, as `lib/mailer.mjs` does. Run with `node --test tools/*.test.mjs`.
- **The repository is public.** No key, token, hash, or user record may be committed.
- **The Clerk session token must be customized to include `email` and `public_metadata`.** Clerk's default claims are `sub` (a `user_…` id), `sid`, `azp`, `exp`, `nbf`, `iss` — no email and no metadata. Without this customization commits are authored by a user id instead of a person, and the admin gate has no role to read. This is a Clerk Dashboard setting, not code.
- **Clerk API version `2026-05-12` or later:** `public_metadata` must be written via `PATCH /v1/users/{id}/metadata`, not `PATCH /v1/users/{id}`, which now ignores it while still returning 200.
- **`POST /v1/invitations` is rate limited to 100/hour per instance.** A 429 carries `Retry-After`.

## Review Focus

1. **Algorithm confusion.** A token whose header says `alg: HS256` or `alg: none`, signed with the public key as an HMAC secret, must be rejected. Pinning `alg === 'RS256'` *before* verifying is the defense. Test in Task 1.
2. **Clock skew.** Vercel and Clerk clocks differ by a second or two; a 60-second token with zero leeway will reject valid tokens intermittently. A small symmetric leeway is required, and `exp` must still reject a genuinely old token. Test in Task 1.
3. **Malformed token.** Two segments, empty string, non-base64, or valid base64 that is not JSON must yield `invalid` — never an uncaught throw that Vercel renders as a 500. Test in Task 1.
4. **Missing email claim.** If the session token lacks `email` (the dashboard customization was never applied), publishing must refuse with a configuration error rather than commit as `undefined` or `user_2Rf…`. Test in Task 3.
5. **Clerk Backend API unreachable or 5xx.** An invite attempted while Clerk is down must report a retryable failure, not "not configured" — the same conflation `publishing-setup.md` documents for GitHub 403s. Test in Task 6.

---

### Task 1: Token verifier

**Files:**
- Create: `lib/clerk-jwt.mjs`
- Test: `tools/clerk-jwt.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `verifyClerkToken(token, { publicKey, authorizedParties, now?, leewaySeconds? })` → returns the decoded payload object, or throws an `Error` with `.code` of `'config' | 'invalid' | 'expired'`.

- [ ] **Step 1: Write the failing test**

Create `tools/clerk-jwt.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { verifyClerkToken } from '../lib/clerk-jwt.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });
const PARTIES = ['https://nycfintechwomen.com'];

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function makeToken(payloadOverrides = {}, headerOverrides = {}) {
  const header = { alg: 'RS256', typ: 'JWT', ...headerOverrides };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 'user_123',
    email: 'jane@example.com',
    azp: PARTIES[0],
    exp: now + 60,
    nbf: now - 5,
    ...payloadOverrides
  };
  const input = `${b64(header)}.${b64(payload)}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `${input}.${signature}`;
}

const opts = (over = {}) => ({ publicKey: PEM, authorizedParties: PARTIES, ...over });

function codeOf(fn) {
  try { fn(); return null; } catch (error) { return error.code; }
}

test('a valid token returns its payload', () => {
  const payload = verifyClerkToken(makeToken(), opts());
  assert.equal(payload.email, 'jane@example.com');
  assert.equal(payload.sub, 'user_123');
});

test('a missing public key is a configuration fault, not a bad token', () => {
  assert.equal(codeOf(() => verifyClerkToken(makeToken(), opts({ publicKey: '' }))), 'config');
});

test('an expired token is distinguishable from an invalid one', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(codeOf(() => verifyClerkToken(makeToken({ exp: now - 600 }), opts())), 'expired');
});

test('a tampered signature is invalid', () => {
  const token = makeToken();
  const tampered = token.slice(0, -4) + 'AAAA';
  assert.equal(codeOf(() => verifyClerkToken(tampered, opts())), 'invalid');
});

/* Review Focus 1: algorithm confusion. A token asking to be verified with
   HMAC, using the public key as the shared secret, is the classic JWT
   forgery. The alg must be pinned before any verification happens. */
test('a token claiming HS256 or none is rejected without verification', () => {
  for (const alg of ['HS256', 'none', 'RS512']) {
    const token = makeToken({}, { alg });
    assert.equal(codeOf(() => verifyClerkToken(token, opts())), 'invalid', `alg ${alg} must be refused`);
  }
});

/* Review Focus 2: clock skew. Tokens live 60 seconds; a second of skew
   between Vercel and Clerk must not reject a valid token, and leeway must
   not resurrect a genuinely expired one. */
test('small clock skew is tolerated but real expiry is not', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.ok(verifyClerkToken(makeToken({ exp: now - 2 }), opts({ now })), 'two seconds of skew must pass');
  assert.ok(verifyClerkToken(makeToken({ nbf: now + 2 }), opts({ now })), 'nbf two seconds ahead must pass');
  assert.equal(codeOf(() => verifyClerkToken(makeToken({ exp: now - 60 }), opts({ now }))), 'expired');
  assert.equal(codeOf(() => verifyClerkToken(makeToken({ nbf: now + 600 }), opts({ now }))), 'invalid');
});

/* Review Focus 3: a malformed token must never throw uncaught — Vercel would
   render that as a 500 and an author would be told the site is broken. */
test('malformed tokens yield invalid rather than throwing', () => {
  for (const bad of ['', 'a.b', 'a.b.c.d', 'not-base64!.x.y', `${Buffer.from('not json').toString('base64url')}.x.y`, null, undefined]) {
    assert.equal(codeOf(() => verifyClerkToken(bad, opts())), 'invalid', `${String(bad)} must be invalid`);
  }
});

test('a token from another origin is rejected', () => {
  assert.equal(codeOf(() => verifyClerkToken(makeToken({ azp: 'https://evil.example' }), opts())), 'invalid');
});

test('role and email are read from the customized claims', () => {
  const payload = verifyClerkToken(makeToken({ public_metadata: { role: 'admin' } }), opts());
  assert.equal(payload.public_metadata.role, 'admin');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/clerk-jwt.test.mjs`
Expected: FAIL — `Cannot find module '../lib/clerk-jwt.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/clerk-jwt.mjs`:

```js
/* Verifies a Clerk session token.
 *
 * Why no JWKS fetch: Clerk publishes the instance's RS256 public key as PEM,
 * so verification is a local signature check against an environment
 * variable. No network call, no cache, and no cache invalidation to get
 * wrong -- the same reasoning lib/github-auth.mjs applies to signing its own
 * JWT with node:crypto rather than taking a dependency.
 *
 * Why the three codes are distinct: a Clerk session token lives 60 seconds,
 * so 'expired' is the ordinary state of affairs a minute after sign-in, not
 * a fault. Reporting it the way a tampered token is reported would send an
 * author -- or whoever maintains this -- chasing a broken credential that is
 * working exactly as designed. publishing-setup.md documents the same
 * conflation costing real debugging time with GitHub's 403s.
 */
import { createVerify, createPublicKey } from 'node:crypto';

/* Clerk and Vercel do not share a clock. With a 60-second token, a second or
   two of skew would otherwise reject tokens that are perfectly valid, which
   presents as publishing that fails roughly at random. */
const DEFAULT_LEEWAY_SECONDS = 5;

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

export function verifyClerkToken(token, {
  publicKey,
  authorizedParties = [],
  now = Math.floor(Date.now() / 1000),
  leewaySeconds = DEFAULT_LEEWAY_SECONDS
} = {}) {
  if (!publicKey) {
    throw fail("The site's sign-in key is not configured — contact the site owner.", 'config');
  }

  const parts = String(token == null ? '' : token).split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw fail('Not signed in.', 'invalid');
  }

  let header;
  let payload;
  try {
    header = decodeSegment(parts[0]);
    payload = decodeSegment(parts[1]);
  } catch {
    throw fail('Not signed in.', 'invalid');
  }
  if (!header || !payload || typeof payload !== 'object') {
    throw fail('Not signed in.', 'invalid');
  }

  /* Pinned BEFORE verifying, not after. A token whose header asks for HS256
     invites the verifier to treat the public key as a shared HMAC secret --
     a key anyone can read -- which forges any payload at will. */
  if (header.alg !== 'RS256') {
    throw fail('Not signed in.', 'invalid');
  }

  let key;
  try {
    key = createPublicKey(publicKey);
  } catch {
    throw fail("The site's sign-in key could not be read — contact the site owner.", 'config');
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  let verified = false;
  try {
    verified = createVerify('RSA-SHA256')
      .update(signingInput)
      .verify(key, Buffer.from(parts[2], 'base64url'));
  } catch {
    verified = false;
  }
  if (!verified) throw fail('Not signed in.', 'invalid');

  // Claims are only trusted after the signature is known good.
  if (typeof payload.exp !== 'number' || payload.exp + leewaySeconds <= now) {
    throw fail('Your session expired — sign in again.', 'expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf - leewaySeconds > now) {
    throw fail('Not signed in.', 'invalid');
  }
  if (payload.azp && authorizedParties.length && !authorizedParties.includes(payload.azp)) {
    throw fail('Not signed in.', 'invalid');
  }

  return payload;
}

/* The role lives in public_metadata, which only Clerk's Backend API can
   write. user_metadata would be writable by the user it describes, which
   would make self-promotion to admin a single request. */
export function isAdmin(payload) {
  return !!payload && !!payload.public_metadata && payload.public_metadata.role === 'admin';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/clerk-jwt.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add lib/clerk-jwt.mjs tools/clerk-jwt.test.mjs
git commit -m "Add a Clerk session token verifier"
```

---

### Task 2: Build-time Clerk keys and the passthrough guard

**Files:**
- Modify: `eleventy.config.js:19-33` (generates `admin/clerk-config.js`)
- Modify: `tools/eleventy-config.test.mjs:33-48`

**Interfaces:**
- Consumes: nothing.
- Produces: `/admin/clerk-config.js`, a generated file defining `window.CLERK_PUBLISHABLE_KEY` and `window.CLERK_FRONTEND_API_URL` for Task 4's script tags.

- [ ] **Step 1: Write the failing test**

Add to `tools/eleventy-config.test.mjs`, replacing the `for (const secret of …)` loop inside the existing `'only the four browser-imported lib/ modules are passed through'` test so the list names files that still exist and adds the new verifier:

```js
  for (const secret of ['lib/clerk-jwt.mjs', 'lib/github.mjs', 'lib/github-auth.mjs', 'lib/publish.mjs', 'lib/publish-validate.mjs']) {
    assert.ok(!libSources.includes(secret), `${secret} must not be served publicly`);
  }
```

Then add a new test at the end of the file:

```js
/* The publishable key is public by design, but it still has to REACH the
   browser: /admin is rendered statically, so a key read from process.env at
   request time would never arrive. Eleventy writes it at build time, which
   also means rotating it needs a redeploy -- unlike every other variable in
   this project. */
test('Clerk browser configuration is generated at build time', () => {
  const saved = { ...process.env };
  process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_abc';
  process.env.CLERK_FRONTEND_API_URL = 'https://example.clerk.accounts.dev';
  try {
    const fake = makeFakeEleventyConfig();
    eleventyConfigFn(fake);
    const generated = fake.templates.find((entry) => entry.path === 'admin/clerk-config.js');
    assert.ok(generated, 'admin/clerk-config.js must be generated');
    assert.match(generated.content, /pk_test_abc/);
    assert.match(generated.content, /example\.clerk\.accounts\.dev/);
  } finally {
    process.env = saved;
  }
});

test('a missing publishable key fails the build rather than shipping a dead editor', () => {
  const saved = { ...process.env };
  delete process.env.CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_FRONTEND_API_URL;
  try {
    const fake = makeFakeEleventyConfig();
    assert.throws(() => eleventyConfigFn(fake), /CLERK_PUBLISHABLE_KEY/);
  } finally {
    process.env = saved;
  }
});
```

`makeFakeEleventyConfig` must gain a `templates` array and an `addTemplate` recorder. Find it near the top of `tools/eleventy-config.test.mjs` and add:

```js
    templates: [],
    addTemplate(path, content) { this.templates.push({ path, content }); },
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/eleventy-config.test.mjs`
Expected: FAIL — `admin/clerk-config.js must be generated`

- [ ] **Step 3: Write minimal implementation**

In `eleventy.config.js`, immediately after the `eleventyConfig.addPassthroughCopy({ 'src/admin': 'admin' });` line, insert:

```js
  /* The editor needs two public Clerk values in the browser. /admin is
     rendered statically and copied verbatim, so there is no request-time
     hook to read process.env from -- the values are written into a generated
     file at build time instead. The consequence worth knowing: rotating
     either key requires a redeploy, not just an environment variable edit.

     Failing the build when they are absent is deliberate. A deployed editor
     with no publishable key renders a sign-in form that can never succeed,
     and the error surfaces in the browser console of whoever happens to try
     it -- which is nobody, until an author needs to publish. */
  const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  const clerkFrontendApiUrl = process.env.CLERK_FRONTEND_API_URL;
  if (!clerkPublishableKey || !clerkFrontendApiUrl) {
    throw new Error(
      'CLERK_PUBLISHABLE_KEY and CLERK_FRONTEND_API_URL must be set at build time; /admin cannot sign anyone in without them.'
    );
  }
  /* The loader lives here rather than in index.html because Clerk serves its
     browser bundles from the instance's OWN Frontend API host, which differs
     between the development and production instances. Hardcoding a public CDN
     in the markup would load a bundle pointed at the wrong instance, which
     presents as a sign-in form that renders and then rejects every
     credential. */
  eleventyConfig.addTemplate(
    'admin/clerk-config.js',
    `window.CLERK_PUBLISHABLE_KEY = ${JSON.stringify(clerkPublishableKey)};\n` +
    `window.CLERK_FRONTEND_API_URL = ${JSON.stringify(clerkFrontendApiUrl)};\n` +
    `(function () {\n` +
    `  var host = ${JSON.stringify(clerkFrontendApiUrl)}.replace(/\\/$/, '');\n` +
    `  [host + '/npm/@clerk/ui@1/dist/ui.browser.js',\n` +
    `   host + '/npm/@clerk/clerk-js@6/dist/clerk.browser.js'].forEach(function (src) {\n` +
    `    var tag = document.createElement('script');\n` +
    `    tag.src = src; tag.defer = true; tag.crossOrigin = 'anonymous';\n` +
    `    tag.setAttribute('data-clerk-publishable-key', window.CLERK_PUBLISHABLE_KEY);\n` +
    `    document.head.appendChild(tag);\n` +
    `  });\n` +
    `}());\n`
  );
```

Also update the comment block above the `addPassthroughCopy` of the four lib modules: it names `lib/session.mjs` and `lib/password.mjs` as examples of what must not be served. Replace those two names with `lib/clerk-jwt.mjs`, since Task 7 deletes the first two.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/eleventy-config.test.mjs`
Expected: PASS

Then confirm the real build still works, with the variables present:

Run: `CLERK_PUBLISHABLE_KEY=pk_test_x CLERK_FRONTEND_API_URL=https://x.clerk.accounts.dev npm run build`
Expected: build completes; `_site/admin/clerk-config.js` exists and contains `pk_test_x`

- [ ] **Step 5: Commit**

```bash
git add eleventy.config.js tools/eleventy-config.test.mjs
git commit -m "Generate the admin Clerk configuration at build time"
```

---

### Task 3: Verify Clerk tokens in publish and unpublish

**Files:**
- Modify: `api/publish.js:26` (import), `:66-82` (configuration and session gate), `:174` (author)
- Modify: `api/unpublish.js:11` (import), `:30-45` (configuration and session gate)
- Modify: `tools/publish-handler.test.mjs:1-56`
- Modify: `tools/unpublish.test.mjs`

**Interfaces:**
- Consumes: `verifyClerkToken` from Task 1.
- Produces: both endpoints read `Authorization: Bearer <token>`; `request.headers.cookie` is no longer consulted.

- [ ] **Step 1: Write the failing test**

In `tools/publish-handler.test.mjs`, replace the `ENV` constant, delete the `signSession` import, and replace `validCookie` with a bearer-token helper:

```js
import { generateKeyPairSync, createSign } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CLERK_PEM = publicKey.export({ type: 'spki', format: 'pem' });

const ENV = {
  CLERK_PEM_PUBLIC_KEY: CLERK_PEM,
  CLERK_AUTHORIZED_PARTIES: 'https://nycfintechwomen.com',
  GITHUB_TOKEN: 'ghtoken',
  GITHUB_OWNER: 'owner',
  GITHUB_REPO: 'repo',
  GITHUB_BRANCH: 'main'
};

function bearer({ email = 'jane@example.com', role, exp } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    sub: 'user_123',
    azp: 'https://nycfintechwomen.com',
    exp: exp === undefined ? now + 60 : exp,
    nbf: now - 5
  };
  if (email !== null) payload.email = email;
  if (role) payload.public_metadata = { role };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const input = `${b64(header)}.${b64(payload)}`;
  const sig = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `Bearer ${input}.${sig}`;
}
```

Change `makeRequest` to carry an authorization header instead of a cookie:

```js
function makeRequest({ method = 'POST', authorization, body } = {}) {
  return { method, headers: authorization ? { authorization } : {}, body };
}
```

Every existing call site passing `cookie: validCookie()` becomes `authorization: bearer()`. Then add these tests:

```js
test('a request with no bearer token is refused', async () => {
  await withEnv(ENV, async () => {
    const response = makeResponse();
    await handler(makeRequest({ body: {} }), response);
    assert.equal(response.statusCode, 401);
  });
});

test('an expired token says so, distinctly from a bad one', async () => {
  await withEnv(ENV, async () => {
    const response = makeResponse();
    const now = Math.floor(Date.now() / 1000);
    await handler(makeRequest({ authorization: bearer({ exp: now - 600 }), body: {} }), response);
    assert.equal(response.statusCode, 401);
    assert.match(response.body.message, /expired/i);
  });
});

/* Review Focus 4: Clerk's default session token carries no email claim --
   only a user_… id. If the dashboard customization was never applied, the
   commit author would silently become a meaningless id, which is invisible
   until somebody reads git log months later. Refuse instead. */
test('a token with no email claim is a configuration fault, not an author', async () => {
  await withEnv(ENV, async () => {
    const response = makeResponse();
    await handler(makeRequest({ authorization: bearer({ email: null }), body: {} }), response);
    assert.equal(response.statusCode, 503);
    assert.match(response.body.message, /not set up/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/publish-handler.test.mjs`
Expected: FAIL — the handler still reads `AUTH_SECRET` and returns 503 for every request

- [ ] **Step 3: Write minimal implementation**

In `api/publish.js`, replace the session import on line 26:

```js
import { verifyClerkToken } from '../lib/clerk-jwt.mjs';
import { authorNameFromSub } from '../lib/session.mjs';
```

Replace the `const secret = process.env.AUTH_SECRET;` line and the configuration guard with:

```js
  const clerkPublicKey = process.env.CLERK_PEM_PUBLIC_KEY;
  const authorizedParties = String(process.env.CLERK_AUTHORIZED_PARTIES || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const hasGithubCredential = !!process.env.GITHUB_TOKEN ||
    !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_INSTALLATION_ID);
  if (!clerkPublicKey || !owner || !repo || !hasGithubCredential) {
    console.error('Publishing is not configured: missing CLERK_PEM_PUBLIC_KEY/GITHUB_OWNER/GITHUB_REPO, or no usable GitHub credential (GITHUB_TOKEN, or GITHUB_APP_ID+GITHUB_APP_PRIVATE_KEY+GITHUB_INSTALLATION_ID)');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }
```

Replace the session gate with:

```js
  /* The token arrives in a header, not a cookie: the browser holds the
     session through Clerk and mints a fresh 60-second token per request, so
     there is nothing for this endpoint to read a cookie for. */
  const bearer = String(request.headers.authorization || '');
  let session;
  try {
    session = verifyClerkToken(bearer.replace(/^Bearer\s+/i, ''), {
      publicKey: clerkPublicKey,
      authorizedParties
    });
  } catch (error) {
    if (error.code === 'config') {
      console.error(`Publishing is not configured: ${error.message}`);
      return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
    }
    return response.status(401).json({ message: error.message });
  }

  /* Clerk's DEFAULT session token has no email claim -- only a user_… id.
     Committing that id as the author would be silently wrong: nothing fails,
     and the damage only shows up in git log long afterwards. The dashboard
     must be configured to add the claim, and until it is, refusing is the
     only honest answer. */
  const authorEmail = String(session.email || '').trim().toLowerCase();
  if (!authorEmail) {
    console.error('Publishing is not configured: the Clerk session token carries no email claim. Add {{user.primary_email_address}} to the session token in the Clerk Dashboard.');
    return response.status(503).json({ message: 'Publishing is not set up on this site yet.' });
  }
```

At line 174, replace `email: session.sub` with `email: authorEmail`, and the `authorName` derivation above it with `authorNameFromSub(authorEmail)`.

Apply the identical changes to `api/unpublish.js` (import, configuration guard, session gate, author email).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tools/publish-handler.test.mjs tools/unpublish.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/publish.js api/unpublish.js tools/publish-handler.test.mjs tools/unpublish.test.mjs
git commit -m "Verify Clerk tokens when publishing and unpublishing"
```

---

### Task 4: Clerk sign-in in the editor

**Files:**
- Modify: `src/admin/index.html:203-211` (the sign-in section), `:295` (scripts)
- Modify: `src/admin/editor.js:30`, `:682-707` (`signIn`), `:876-895` (publish fetch), `:930-951` (unpublish fetch), `:1058` (listener)

**Interfaces:**
- Consumes: `/admin/clerk-config.js` from Task 2; the bearer-token contract from Task 3.
- Produces: `authHeaders()` returning `{ 'content-type': 'application/json', authorization: 'Bearer <token>' }`, awaited immediately before each request.

- [ ] **Step 1: Replace the sign-in markup**

In `src/admin/index.html`, replace lines 203-211 with:

```html
    <section id="signin" class="sec">
      <h2>Account</h2>
      <p class="hint">You can write and download a post without signing in. Publishing needs an account.</p>
      <div id="clerk-auth"></div>
      <p id="signin-status" role="status"></p>
    </section>
```

Above `<script type="module" src="editor.js"></script>`, add:

```html
<script src="clerk-config.js"></script>
```

That one tag is the whole of it: `clerk-config.js`, generated in Task 2, appends Clerk's two bundles itself using the instance's own Frontend API host. Nothing about the CDN is hardcoded in this file.

Because the bundles load asynchronously, `window.Clerk` may not exist when `editor.js` runs. Step 3 handles that by waiting for it rather than assuming it.

- [ ] **Step 2: Write the failing check**

There is no DOM test harness in this project, so this task is verified by running the editor. Record the expected behavior as a checklist to execute in Step 4 rather than an automated test. Do not add a test framework.

- [ ] **Step 3: Rewire the editor**

In `src/admin/editor.js`, replace the whole `signIn` function (lines 682-707) with:

```js
var clerk = null;

/* A Clerk session token lives 60 SECONDS. Fetching one at sign-in and
   reusing it would produce an editor that publishes successfully for about a
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

/* clerk-config.js appends Clerk's bundles with `defer`, so window.Clerk is
   not there yet when this module runs. Polling briefly is cheaper than a
   load event on a tag this file did not create. */
function waitForClerk(timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  return new Promise(function (resolve) {
    (function poll() {
      if (window.Clerk) return resolve(window.Clerk);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(poll, 50);
    }());
  });
}

async function initClerk() {
  var status = $('signin-status');
  var mount = $('clerk-auth');
  clerk = await waitForClerk(10000);
  if (!clerk) {
    status.textContent = 'Could not load the sign-in form. Check your connection and reload.';
    return;
  }
  try {
    await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  } catch (error) {
    status.textContent = 'Could not load the sign-in form. Check your connection and reload.';
    return;
  }
  render();

  function render() {
    mount.innerHTML = '';
    if (clerk.isSignedIn) {
      signedIn = true;
      var email = clerk.user && clerk.user.primaryEmailAddress
        ? clerk.user.primaryEmailAddress.emailAddress : '';
      status.textContent = 'Signed in as ' + email + '.';
      clerk.mountUserButton(mount);
      renderAdminTools(isAdminUser());
    } else {
      signedIn = false;
      status.textContent = '';
      clerk.mountSignIn(mount);
      renderAdminTools(false);
    }
    updatePublishAvailability();
  }

  clerk.addListener(function () { render(); });
}

function isAdminUser() {
  return !!(clerk && clerk.user && clerk.user.publicMetadata && clerk.user.publicMetadata.role === 'admin');
}
```

Replace line 1058's `$('btn-signin').addEventListener('click', signIn);` with:

```js
  initClerk();
```

In the publish fetch (line 876) and the unpublish fetch (line 930), replace the inline `headers: { 'content-type': 'application/json' }` with `headers: await authHeaders()`.

`renderAdminTools` is defined in Task 6; until then, add a placeholder that Task 6 replaces:

```js
function renderAdminTools() {}
```

- [ ] **Step 4: Verify in the real editor**

Run: `CLERK_PUBLISHABLE_KEY=<dev key> CLERK_FRONTEND_API_URL=<dev fapi> npm run dev`

Confirm, in order:
- `/admin` shows Clerk's sign-in form, not the old email/password fields
- Publish is disabled while signed out, with its "Sign in to publish" title
- Signing in shows "Signed in as …" and enables Publish
- Clerk's user button opens account management, and Security offers a password change
- "Forgot password?" on the sign-in form sends an email
- Signing out disables Publish again

- [ ] **Step 5: Commit**

```bash
git add src/admin/index.html src/admin/editor.js
git commit -m "Sign in to the editor through Clerk"
```

---

### Task 5: Remove the old authentication

**Files:**
- Delete: `api/login.js`, `lib/password.mjs`, `tools/hash-password.mjs`, `tools/password.test.mjs`
- Modify: `lib/session.mjs` (reduce to `authorNameFromSub`)
- Modify: `tools/session.test.mjs`
- Modify: `.env.example:16-26`

**Interfaces:**
- Consumes: nothing. Every caller was rewired in Tasks 3 and 4.
- Produces: `lib/session.mjs` exporting only `authorNameFromSub`.

- [ ] **Step 1: Prove nothing still imports the deleted code**

Run:
```bash
grep -rn "password.mjs\|verifyPassword\|hashPassword\|signSession\|verifySession\|readCookie\|SESSION_TTL_SECONDS\|AUTH_USERS\|AUTH_SECRET" --include="*.js" --include="*.mjs" . | grep -v node_modules
```
Expected: matches only in the files this task deletes or edits. Any other match is a caller Task 3 or 4 missed — fix that first.

- [ ] **Step 2: Delete and reduce**

```bash
git rm api/login.js lib/password.mjs tools/hash-password.mjs tools/password.test.mjs
```

In `lib/session.mjs`, delete `SESSION_TTL_SECONDS`, `signSession`, `verifySession`, `readCookie`, the `createHmac`/`timingSafeEqual` import, the `b64url` helper, and the `sign` helper. Keep `authorNameFromSub` and its comment, and rewrite the file header:

```js
/* Derives the git author name for a signed-in author.
 *
 * What remains of a module that used to sign and verify this project's own
 * session cookies. Clerk now owns sessions (lib/clerk-jwt.mjs verifies its
 * tokens), and the file's original header predicted exactly this: "Swapping
 * to GitHub OAuth or a managed provider replaces this file and api/login.js
 * and touches nothing else." It did.
 */
```

In `tools/session.test.mjs`, delete every test for the removed exports, keeping only the `authorNameFromSub` tests and fixing the import.

In `.env.example`, delete the `AUTH_SECRET` and `AUTH_USERS` blocks and add:

```
# Clerk owns authors and admins. CLERK_PUBLISHABLE_KEY and
# CLERK_FRONTEND_API_URL are public and are baked into /admin at BUILD time,
# so changing either needs a redeploy, not just an env var edit.
CLERK_PUBLISHABLE_KEY=
CLERK_FRONTEND_API_URL=
CLERK_SECRET_KEY=
CLERK_PEM_PUBLIC_KEY=
# Comma-separated origins allowed in a token's azp claim. A token minted for
# another origin is refused, so this must list the real site origin.
CLERK_AUTHORIZED_PARTIES=
# Where an invitation link lands. Must be an allowed redirect in the Clerk
# Dashboard, or Clerk refuses the invitation.
CLERK_INVITE_REDIRECT_URL=
```

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: PASS, with no reference to a deleted module

- [ ] **Step 4: Commit**

```bash
git add -u && git add .env.example
git commit -m "Remove the AUTH_USERS password authentication"
```

---

### Task 6: Invite an author

**Files:**
- Create: `api/invite.js`
- Create: `tools/invite.test.mjs`
- Modify: `src/admin/editor.js` (replace the `renderAdminTools` placeholder)
- Modify: `src/admin/index.html` (an admin section)

**Interfaces:**
- Consumes: `verifyClerkToken`, `isAdmin` from Task 1; `authHeaders()` from Task 4.
- Produces: `POST /api/invite` with `{ email }`; 204 on success, 400 bad email, 401 unauthenticated, 403 not admin, 429 rate limited, 502 Clerk unreachable, 503 unconfigured.

- [ ] **Step 1: Write the failing test**

Create `tools/invite.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import handler from '../api/invite.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });

const ENV = {
  CLERK_PEM_PUBLIC_KEY: PEM,
  CLERK_SECRET_KEY: 'sk_test_x',
  CLERK_AUTHORIZED_PARTIES: 'https://nycfintechwomen.com',
  CLERK_INVITE_REDIRECT_URL: 'https://nycfintechwomen.com/admin/'
};

function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  return Promise.resolve().then(fn).finally(() => { process.env = saved; });
}

function bearer(role) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const payload = {
    sub: 'user_admin', email: 'admin@example.com',
    azp: 'https://nycfintechwomen.com', exp: now + 60, nbf: now - 5
  };
  if (role) payload.public_metadata = { role };
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}`;
  const sig = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `Bearer ${input}.${sig}`;
}

function makeResponse() {
  return {
    statusCode: null, headers: {}, body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
}

const req = (authorization, body) => ({ method: 'POST', headers: { authorization }, body });

/* Mirrors tools/publish-handler.test.mjs. Handlers in this project take
   (request, response) and nothing else -- no injected fetch -- so a stub
   replaces globalThis.fetch for the duration of one test and is always
   restored, including on failure. */
function stubFetch(replies) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : null
    });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    if (next.networkError) throw new Error('network down');
    return {
      ok: next.status < 400,
      status: next.status,
      headers: { get: () => next.retryAfter || null },
      json: async () => next.body || {}
    };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

async function withFetch(replies, fn) {
  const stub = stubFetch(replies);
  try { return await fn(stub); } finally { stub.restore(); }
}

const OK = { status: 200, body: { id: 'inv_1' } };

test('an author cannot invite', async () => {
  await withEnv(ENV, () => withFetch([], async (stub) => {
    const response = makeResponse();
    await handler(req(bearer(), { email: 'new@example.com' }), response);
    assert.equal(response.statusCode, 403);
    assert.equal(stub.calls.length, 0, 'a non-admin must never reach Clerk');
  }));
});

test('an admin invites and the request reaches Clerk correctly', async () => {
  await withEnv(ENV, () => withFetch([OK], async (stub) => {
    const response = makeResponse();
    await handler(req(bearer('admin'), { email: ' New@Example.com ' }), response);
    assert.equal(response.statusCode, 204);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'https://api.clerk.com/v1/invitations');
    assert.match(stub.calls[0].headers.Authorization, /^Bearer sk_test_x$/);
    assert.equal(stub.calls[0].body.email_address, 'new@example.com', 'trimmed and lowercased');
    assert.equal(stub.calls[0].body.redirect_url, ENV.CLERK_INVITE_REDIRECT_URL);
  }));
});

test('a malformed email is refused before Clerk is called', async () => {
  for (const email of ['', '   ', 'nope', 'a@', '@b.com']) {
    await withEnv(ENV, () => withFetch([], async (stub) => {
      const response = makeResponse();
      await handler(req(bearer('admin'), { email }), response);
      assert.equal(response.statusCode, 400, `${JSON.stringify(email)} must be refused`);
      assert.equal(stub.calls.length, 0, 'a bad address must not spend one of the 100 hourly invitations');
    }));
  }
});

test('an already-invited address reports plainly', async () => {
  await withEnv(ENV, () => withFetch([{ status: 422, body: { errors: [{ code: 'duplicate_record' }] } }], async () => {
    const response = makeResponse();
    await handler(req(bearer('admin'), { email: 'dupe@example.com' }), response);
    assert.equal(response.statusCode, 409);
    assert.match(response.body.message, /already/i);
  }));
});

test("Clerk's 100-per-hour invitation limit surfaces as retryable", async () => {
  await withEnv(ENV, () => withFetch([{ status: 429, body: {}, retryAfter: '900' }], async () => {
    const response = makeResponse();
    await handler(req(bearer('admin'), { email: 'x@example.com' }), response);
    assert.equal(response.statusCode, 429);
    assert.match(response.body.message, /try again/i);
  }));
});

/* Review Focus 5: Clerk being down is not Clerk being unconfigured.
   Reporting a 500 as "not set up" is the mistake publishing-setup.md
   documents for GitHub's 403s, where a branch protection rule reads as a bad
   credential and sends the operator to the wrong place entirely. */
test('Clerk being unreachable is a temporary failure, not a misconfiguration', async () => {
  for (const reply of [{ networkError: true }, { status: 500, body: {} }]) {
    await withEnv(ENV, () => withFetch([reply], async () => {
      const response = makeResponse();
      await handler(req(bearer('admin'), { email: 'x@example.com' }), response);
      assert.equal(response.statusCode, 502);
      assert.match(response.body.message, /try again/i);
      assert.doesNotMatch(response.body.message, /not set up/i);
    }));
  }
});

test('a missing CLERK_SECRET_KEY is a configuration fault', async () => {
  await withEnv({ ...ENV, CLERK_SECRET_KEY: '' }, () => withFetch([], async (stub) => {
    const response = makeResponse();
    await handler(req(bearer('admin'), { email: 'x@example.com' }), response);
    assert.equal(response.statusCode, 503);
    assert.equal(stub.calls.length, 0);
  }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/invite.test.mjs`
Expected: FAIL — `Cannot find module '../api/invite.js'`

- [ ] **Step 3: Write minimal implementation**

Create `api/invite.js`:

```js
/* POST /api/invite — an admin invites an author by email.
 *
 * Clerk sends the email and owns the invitation token, its expiry and its
 * single use. This endpoint exists so a client-side admin can onboard an
 * author without a Clerk account of their own, which is the whole reason the
 * invite lives here rather than in Clerk's dashboard.
 *
 * Env:
 *   CLERK_PEM_PUBLIC_KEY       — verifies the caller's session token
 *   CLERK_SECRET_KEY           — authenticates to Clerk's Backend API
 *   CLERK_AUTHORIZED_PARTIES   — comma-separated allowed azp origins
 *   CLERK_INVITE_REDIRECT_URL  — where the invite link lands
 */
import { verifyClerkToken, isAdmin } from '../lib/clerk-jwt.mjs';

const INVITATIONS_URL = 'https://api.clerk.com/v1/invitations';
const TIMEOUT_MS = 8000;

/* Deliberately not a full RFC 5322 grammar: Clerk validates properly, and the
   only job here is to refuse the obviously-wrong before spending one of the
   100 invitations an instance gets per hour. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const publicKey = process.env.CLERK_PEM_PUBLIC_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;
  const redirectUrl = process.env.CLERK_INVITE_REDIRECT_URL;
  const authorizedParties = String(process.env.CLERK_AUTHORIZED_PARTIES || '')
    .split(',').map((value) => value.trim()).filter(Boolean);

  if (!publicKey || !secretKey) {
    console.error('Inviting is not configured: CLERK_PEM_PUBLIC_KEY and CLERK_SECRET_KEY are both required');
    return response.status(503).json({ message: 'Inviting is not set up on this site yet.' });
  }

  let session;
  try {
    session = verifyClerkToken(String(request.headers.authorization || '').replace(/^Bearer\s+/i, ''), {
      publicKey, authorizedParties
    });
  } catch (error) {
    if (error.code === 'config') {
      console.error(`Inviting is not configured: ${error.message}`);
      return response.status(503).json({ message: 'Inviting is not set up on this site yet.' });
    }
    return response.status(401).json({ message: error.message });
  }

  if (!isAdmin(session)) {
    return response.status(403).json({ message: 'Only an admin can invite an author.' });
  }

  const body = typeof request.body === 'object' && request.body ? request.body : {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL.test(email)) {
    return response.status(400).json({ message: 'That does not look like an email address.' });
  }

  const payload = { email_address: email };
  if (redirectUrl) payload.redirect_url = redirectUrl;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let clerkResponse;
  try {
    clerkResponse = await fetch(INVITATIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch {
    // Clerk unreachable. NOT a misconfiguration: saying so would send
    // whoever maintains this to the environment variables, which are fine.
    return response.status(502).json({ message: 'Could not reach the sign-in service. Try again in a minute.' });
  } finally {
    clearTimeout(timer);
  }

  if (clerkResponse.ok) return response.status(204).end();

  if (clerkResponse.status === 422) {
    return response.status(409).json({ message: 'That person has already been invited, or already has an account.' });
  }
  if (clerkResponse.status === 429) {
    return response.status(429).json({ message: 'Too many invitations in the last hour. Try again later.' });
  }
  console.error(`Clerk rejected an invitation with ${clerkResponse.status}`);
  return response.status(502).json({ message: 'Could not reach the sign-in service. Try again in a minute.' });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/invite.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Add the admin UI**

In `src/admin/index.html`, after the `#signin` section, add:

```html
    <section id="admin-tools" class="sec" hidden>
      <h2>Authors</h2>
      <label for="invite-email">Invite an author</label>
      <input id="invite-email" type="email" autocomplete="off">
      <button id="btn-invite" type="button">Send invitation</button>
      <p id="invite-status" role="status"></p>
      <div id="author-list"></div>
    </section>
```

In `src/admin/editor.js`, replace the `renderAdminTools` placeholder from Task 4:

```js
function renderAdminTools(isAdmin) {
  $('admin-tools').hidden = !isAdmin;
}

async function sendInvite() {
  var input = $('invite-email');
  var status = $('invite-status');
  var email = input.value.trim();
  if (!email) { status.textContent = 'Enter an email address first.'; return; }
  status.textContent = 'Sending…';
  try {
    var response = await fetch('/api/invite', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ email: email })
    });
    if (response.status === 204) {
      status.textContent = 'Invitation sent to ' + email + '.';
      input.value = '';
      return;
    }
    var data = await response.json().catch(function () { return {}; });
    status.textContent = data.message || 'Could not send that invitation.';
  } catch (error) {
    status.textContent = 'Could not reach the site to send that invitation.';
  }
}
```

Register the listener next to the others: `$('btn-invite').addEventListener('click', sendInvite);`

- [ ] **Step 6: Commit**

```bash
git add api/invite.js tools/invite.test.mjs src/admin/index.html src/admin/editor.js
git commit -m "Let an admin invite an author from the editor"
```

---

### Task 7: List, remove, and promote authors

**Files:**
- Create: `api/authors.js`
- Create: `tools/authors.test.mjs`
- Modify: `src/admin/editor.js` (render the list)

**Interfaces:**
- Consumes: `verifyClerkToken`, `isAdmin`; `authHeaders()`.
- Produces: `GET /api/authors` → `{ authors: [{ id, email, role }] }`; `POST /api/authors` with `{ action: 'remove' | 'promote' | 'demote', id }` → 204.

- [ ] **Step 1: Write the failing test**

Create `tools/authors.test.mjs`. Copy the `withEnv`, `bearer`, `makeResponse`, `stubFetch`, and `withFetch` helpers from `tools/invite.test.mjs` verbatim, changing only the import to `../api/authors.js` — this project does not share test helpers between files, and each test file standing alone is the existing convention. Then:

```js
const USERS = [
  { id: 'user_admin', email_addresses: [{ email_address: 'admin@example.com' }], public_metadata: { role: 'admin' } },
  { id: 'user_jane', email_addresses: [{ email_address: 'jane@example.com' }], public_metadata: {} }
];
const listReply = { status: 200, body: USERS };
const getReq = (authorization) => ({ method: 'GET', headers: { authorization } });
const postReq = (authorization, body) => ({ method: 'POST', headers: { authorization }, body });

test('an author cannot list', async () => {
  await withEnv(ENV, () => withFetch([], async (stub) => {
    const response = makeResponse();
    await handler(getReq(bearer()), response);
    assert.equal(response.statusCode, 403);
    assert.equal(stub.calls.length, 0);
  }));
});

test('an admin sees every author with their role', async () => {
  await withEnv(ENV, () => withFetch([listReply], async () => {
    const response = makeResponse();
    await handler(getReq(bearer('admin')), response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.authors, [
      { id: 'user_admin', email: 'admin@example.com', role: 'admin' },
      { id: 'user_jane', email: 'jane@example.com', role: 'author' }
    ]);
  }));
});

test('promoting an author calls the dedicated metadata endpoint', async () => {
  await withEnv(ENV, () => withFetch([listReply, { status: 200, body: {} }], async (stub) => {
    const response = makeResponse();
    await handler(postReq(bearer('admin'), { action: 'promote', id: 'user_jane' }), response);
    assert.equal(response.statusCode, 204);
    const patch = stub.calls.find((call) => call.method === 'PATCH');
    assert.ok(patch, 'a PATCH must be sent');
    /* Not /v1/users/{id}: as of Clerk API version 2026-05-12 that endpoint
       ignores public_metadata while still returning 200, so the role would
       silently never be set. */
    assert.equal(patch.url, 'https://api.clerk.com/v1/users/user_jane/metadata');
    assert.deepEqual(patch.body, { public_metadata: { role: 'admin' } });
  }));
});

/* The one invariant. Stated as "at least one admin must remain" rather than
   "an admin may not remove themselves", because the handoff case REQUIRES
   self-removal: promote a client admin, then step out. A self-removal guard
   would have blocked exactly that. */
test('the last admin cannot be removed or demoted', async () => {
  for (const action of ['remove', 'demote']) {
    await withEnv(ENV, () => withFetch([listReply], async (stub) => {
      const response = makeResponse();
      await handler(postReq(bearer('admin'), { action, id: 'user_admin' }), response);
      assert.equal(response.statusCode, 409, `${action} of the last admin must be refused`);
      assert.match(response.body.message, /last admin/i);
      assert.ok(!stub.calls.some((call) => ['DELETE', 'PATCH'].includes(call.method)),
        'nothing may be written when the invariant would break');
    }));
  }
});

test('an admin may remove themselves once another admin exists', async () => {
  const twoAdmins = {
    status: 200,
    body: [USERS[0], { ...USERS[1], public_metadata: { role: 'admin' } }]
  };
  await withEnv(ENV, () => withFetch([twoAdmins, { status: 200, body: {} }], async (stub) => {
    const response = makeResponse();
    await handler(postReq(bearer('admin'), { action: 'remove', id: 'user_admin' }), response);
    assert.equal(response.statusCode, 204);
    const del = stub.calls.find((call) => call.method === 'DELETE');
    assert.equal(del.url, 'https://api.clerk.com/v1/users/user_admin');
  }));
});

test('an unknown action is refused before anything is read or written', async () => {
  await withEnv(ENV, () => withFetch([], async (stub) => {
    const response = makeResponse();
    await handler(postReq(bearer('admin'), { action: 'drop-table', id: 'user_jane' }), response);
    assert.equal(response.statusCode, 400);
    assert.equal(stub.calls.length, 0);
  }));
});

test('an unknown author is a 404', async () => {
  await withEnv(ENV, () => withFetch([listReply], async () => {
    const response = makeResponse();
    await handler(postReq(bearer('admin'), { action: 'remove', id: 'user_nobody' }), response);
    assert.equal(response.statusCode, 404);
  }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/authors.test.mjs`
Expected: FAIL — `Cannot find module '../api/authors.js'`

- [ ] **Step 3: Write minimal implementation**

Create `api/authors.js`:

```js
/* GET /api/authors  — list every author and their role.
 * POST /api/authors — remove an author, or change whether they are an admin.
 *
 * Both are admin-only. This exists so a client-side admin can manage authors
 * without a Clerk account of their own: the client has declined to hold
 * either a GitHub or a Clerk login, and /admin is the only place they sign
 * in. Sending them to Clerk's dashboard for the one urgent operation --
 * revoking someone who has left -- would defeat that.
 *
 * Env: see api/invite.js. The same four variables, read the same way.
 */
import { verifyClerkToken, isAdmin } from '../lib/clerk-jwt.mjs';

const USERS_URL = 'https://api.clerk.com/v1/users';
const TIMEOUT_MS = 8000;
const ACTIONS = new Set(['remove', 'promote', 'demote']);

function upstream() {
  return Object.assign(new Error('clerk rejected the request'), { code: 'upstream' });
}

async function callClerk(url, secretKey, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const reply = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    if (!reply.ok) throw upstream();
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

async function listAuthors(secretKey) {
  const reply = await callClerk(`${USERS_URL}?limit=100`, secretKey);
  const users = await reply.json();
  return users.map((user) => ({
    id: user.id,
    email: user.email_addresses && user.email_addresses[0]
      ? user.email_addresses[0].email_address
      : '',
    role: user.public_metadata && user.public_metadata.role === 'admin' ? 'admin' : 'author'
  }));
}

export default async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.setHeader('Allow', 'GET, POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const publicKey = process.env.CLERK_PEM_PUBLIC_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;
  const authorizedParties = String(process.env.CLERK_AUTHORIZED_PARTIES || '')
    .split(',').map((value) => value.trim()).filter(Boolean);

  if (!publicKey || !secretKey) {
    console.error('Author management is not configured: CLERK_PEM_PUBLIC_KEY and CLERK_SECRET_KEY are both required');
    return response.status(503).json({ message: 'Author management is not set up on this site yet.' });
  }

  let session;
  try {
    session = verifyClerkToken(String(request.headers.authorization || '').replace(/^Bearer\s+/i, ''), {
      publicKey, authorizedParties
    });
  } catch (error) {
    if (error.code === 'config') {
      console.error(`Author management is not configured: ${error.message}`);
      return response.status(503).json({ message: 'Author management is not set up on this site yet.' });
    }
    return response.status(401).json({ message: error.message });
  }

  if (!isAdmin(session)) {
    return response.status(403).json({ message: 'Only an admin can manage authors.' });
  }

  try {
    if (request.method === 'GET') {
      return response.status(200).json({ authors: await listAuthors(secretKey) });
    }

    const body = typeof request.body === 'object' && request.body ? request.body : {};
    const action = String(body.action || '');
    const id = String(body.id || '');
    // Refused before any read: an unrecognised action is a bug in the caller,
    // and spending a Clerk round trip to find that out teaches nobody
    // anything.
    if (!ACTIONS.has(action) || !id) {
      return response.status(400).json({ message: 'That is not something that can be done to an author.' });
    }

    /* Read before every write, never cached. The invariant is about the state
       at the moment of the change: two admins stepping down at the same time
       must not both be told it is safe. */
    const authors = await listAuthors(secretKey);
    const target = authors.find((author) => author.id === id);
    if (!target) return response.status(404).json({ message: 'No such author.' });

    const admins = authors.filter((author) => author.role === 'admin');
    const losesAnAdmin = target.role === 'admin' && (action === 'remove' || action === 'demote');
    if (losesAnAdmin && admins.length <= 1) {
      return response.status(409).json({
        message: 'That is the last admin. Promote someone else first, or nobody could invite an author again.'
      });
    }

    if (action === 'remove') {
      await callClerk(`${USERS_URL}/${encodeURIComponent(id)}`, secretKey, { method: 'DELETE' });
    } else {
      /* The dedicated metadata endpoint, which deep-merges. A null value
         removes the key outright, which is how a demotion leaves no trace of
         a role rather than an empty string that some future check might read
         as truthy. */
      await callClerk(`${USERS_URL}/${encodeURIComponent(id)}/metadata`, secretKey, {
        method: 'PATCH',
        body: JSON.stringify({ public_metadata: { role: action === 'promote' ? 'admin' : null } })
      });
    }

    return response.status(204).end();
  } catch (error) {
    // Clerk unreachable or refusing. NOT a misconfiguration: the environment
    // variables are fine and saying otherwise sends the next person to the
    // wrong place.
    console.error(`Author management could not reach Clerk: ${error.message}`);
    return response.status(502).json({ message: 'Could not reach the sign-in service. Try again in a minute.' });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/authors.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Render the list in the editor**

In `src/admin/editor.js`, replace the `renderAdminTools` written in Task 6 so it loads the list whenever an admin signs in, and add the two functions below it:

```js
function renderAdminTools(isAdmin) {
  $('admin-tools').hidden = !isAdmin;
  if (isAdmin) loadAuthors();
}

async function loadAuthors() {
  var holder = $('author-list');
  holder.textContent = 'Loading…';
  try {
    var response = await fetch('/api/authors', { headers: await authHeaders() });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) { holder.textContent = data.message || 'Could not load the author list.'; return; }
    holder.innerHTML = '';
    data.authors.forEach(function (author) {
      var row = document.createElement('p');
      row.textContent = author.email + ' (' + author.role + ') ';
      ['remove', author.role === 'admin' ? 'demote' : 'promote'].forEach(function (action) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = action;
        button.addEventListener('click', function () { actOnAuthor(action, author.id, author.email); });
        row.appendChild(button);
      });
      holder.appendChild(row);
    });
  } catch (error) {
    holder.textContent = 'Could not reach the site to load the author list.';
  }
}

async function actOnAuthor(action, id, email) {
  var status = $('invite-status');
  status.textContent = 'Working…';
  try {
    var response = await fetch('/api/authors', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ action: action, id: id })
    });
    if (response.status === 204) {
      status.textContent = action === 'remove' ? ('Removed ' + email + '.') : ('Updated ' + email + '.');
      loadAuthors();
      return;
    }
    var data = await response.json().catch(function () { return {}; });
    status.textContent = data.message || 'That did not work.';
  } catch (error) {
    status.textContent = 'Could not reach the site.';
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add api/authors.js tools/authors.test.mjs src/admin/editor.js
git commit -m "List, remove and promote authors from the editor"
```

---

### Task 8: Rewrite the setup documentation

**Files:**
- Modify: `docs/publishing-setup.md` — section 2 entirely, plus the end-to-end checklist

**Interfaces:**
- Consumes: the finished behavior of Tasks 1-7.
- Produces: nothing code depends on.

- [ ] **Step 1: Replace section 2**

Delete the whole "Create the first author" section — the `AUTH_SECRET` generation, the `tools/hash-password.mjs` invocation, the `AUTH_USERS` JSON, and the lowercase-email warning, all of which now describe deleted code. Replace it with a Clerk section covering, in this order:

1. Creating the application **inside a Lintel Works Clerk organization**, not a personal account, with the reason: the same argument this document already makes for the GitHub App — an App owned by an organization "keeps working regardless of who is or isn't on the team."
2. **Restrictions → Sign-up mode: Restricted**, flagged as the single most important setting, with the consequence stated plainly: without it, anyone who finds `/admin` can create an account and publish to the live site.
3. Email + password on, every social provider off.
4. **Customizing the session token to include `{{user.primary_email_address}}` and `{{user.public_metadata}}`**, with the consequence: without the email claim every commit is authored by a `user_…` id rather than a person, and without the metadata claim no admin gate can work. Both fail quietly.
5. The four environment variables, noting that `CLERK_PUBLISHABLE_KEY` and `CLERK_FRONTEND_API_URL` are read at **build** time, so changing them needs a redeploy.
6. Bootstrapping the first admin, since no admin exists to grant the first one:

```bash
curl -X PATCH "https://api.clerk.com/v1/users/<your user id>/metadata" \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"public_metadata": {"role": "admin"}}'
```

Note that `PATCH /v1/users/<id>` — without `/metadata` — silently ignores `public_metadata` as of Clerk's `2026-05-12` API version while still returning 200.

- [ ] **Step 2: Update the end-to-end checklist**

Step 1 of the existing checklist tells the author to enter an email and password in the editor's own form. Rewrite it for Clerk's sign-in component, and keep the existing warning that switching post type reloads the page — that behavior is unchanged and still resets the signed-in state in the UI.

Add to the checklist:
- An invited author completes the invite link and can publish.
- "Forgot password?" delivers an email and the new password works.
- A removed author's publish attempt returns 401.
- The last admin cannot be removed.

Add to **Known issues** or a new **Cutover** section the preview-deployment hazard: publishing from a preview deployment commits to the real repository and triggers a production deploy, because `GITHUB_OWNER` and `GITHUB_REPO` carry no notion of environment. Set `GITHUB_BRANCH` to a throwaway branch on any preview used for testing.

- [ ] **Step 3: Verify every documented command**

Read the finished document and confirm every file path, environment variable, and endpoint it names exists in the tree after Tasks 1-7. Specifically confirm it no longer mentions `tools/hash-password.mjs`, `AUTH_USERS`, `AUTH_SECRET`, or `/api/login`.

Run: `grep -nE "hash-password|AUTH_USERS|AUTH_SECRET|api/login" docs/publishing-setup.md`
Expected: no matches

- [ ] **Step 4: Commit**

```bash
git add docs/publishing-setup.md
git commit -m "Document the Clerk publishing setup"
```

---

## Final verification

- [ ] Run `npm test` — the whole suite passes
- [ ] Run `npm run verify` — the snapshot harness reports no unintended page changes
- [ ] Run `CLERK_PUBLISHABLE_KEY=<dev> CLERK_FRONTEND_API_URL=<dev fapi> npm run build` — the build succeeds and `_site/admin/clerk-config.js` exists
- [ ] Run `grep -rn "AUTH_USERS\|AUTH_SECRET\|verifyPassword\|signSession" --include="*.js" --include="*.mjs" . | grep -v node_modules` — no matches outside `docs/`
- [ ] Confirm `_site/lib/` contains only the four browser modules and **not** `clerk-jwt.mjs`
