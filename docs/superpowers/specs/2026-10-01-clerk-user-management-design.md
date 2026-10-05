# Clerk user management — design

Date: 2026-10-01
Status: approved for planning

## Problem

Authors are defined by `AUTH_USERS`, a Vercel environment variable holding a
JSON map of email to scrypt hash. Adding an author means generating a
password, running `tools/hash-password.mjs`, editing the variable, and
redeploying. Three consequences:

1. **Nobody can change their own password.** The password is whatever was
   generated for them, forever. There is no change-password flow and no
   forgot-password flow, because a Vercel environment variable cannot be
   written at runtime — a function can read `AUTH_USERS` but cannot modify it.
2. **Onboarding requires a developer.** Every new author is a manual hashing
   step plus a redeploy.
3. **Whoever runs the hashing tool learns the plaintext password.** This
   became the blocking objection when the client asked for authors to use
   their own credentials.

The client wants: an admin invites someone by email, that person receives a
link, sets their own password, and can change it later.

## Goals

- An admin invites an author by email from inside `/admin`.
- An invited author sets their own password and can change it afterwards.
- An author who has forgotten their password recovers without help.
- An admin removes an author, revoking access immediately.
- An admin promotes another author to admin.
- No author or admin needs a GitHub account or a Clerk account. `/admin` is
  the only place any of them ever signs in.

## Non-goals

- Social login. Email and password only, so that the identity recorded on a
  commit is unambiguous.
- Self-service sign-up. Accounts exist only by invitation.
- Moving posts, images, or publishing. The GitHub App commit path is
  untouched.
- Multi-tenancy, teams, or per-post permissions. Every author can publish and
  unpublish everything.

## Constraints

- **Zero npm runtime dependencies.** `package.json` has three
  devDependencies and nothing else; `lib/mailer.mjs` documents the rule
  explicitly ("this adds no dependency to a project that has none"). Clerk is
  consumed as CDN script tags in the browser and `fetch` calls on the server,
  so the rule holds.
- **The repository is public** (`women-in-fintech-nyc`). No user record, hash,
  or token may be committed.
- **`/admin` is statically rendered by Eleventy.** Anything the browser needs
  is baked in at build time, not read at runtime.
- **A maintenance contract covers ongoing administration.** Sean Craig is an
  admin indefinitely; a named client contact is also an admin so that author
  onboarding does not require him.

## Architecture

Clerk owns identity. There is no database and no user records in the
repository.

### Deleted

- `AUTH_USERS`, `AUTH_SECRET` (environment variables)
- `lib/password.mjs`
- `tools/hash-password.mjs`
- `api/login.js`
- the HMAC signing and verification half of `lib/session.mjs`

`lib/session.mjs` anticipated this in its own header: "Swapping to GitHub
OAuth or a managed provider replaces this file and api/login.js and touches
nothing else."

**The token arrives in an `Authorization: Bearer` header, not a cookie.** The
browser already holds a session through Clerk and calls `getToken()` per
request, so there is no reason to read `__session` ourselves. The consequence
is that `signSession`, `verifySession`, `SESSION_TTL_SECONDS`, and
`readCookie` all become unreachable — `lib/session.mjs` reduces to
`authorNameFromSub` alone, and `tools/session.test.mjs` shrinks to match.
Whether that single function stays in `session.mjs` or moves is a planning
decision, not a design one.

**`eleventy.config.js` has a guard that must be updated.** It prevents
`lib/*.mjs` from being copied into the published static site, and
`tools/eleventy-config.test.mjs` asserts the list by name — currently
including `lib/session.mjs` and `lib/password.mjs`. Deleting those two files
without updating that list leaves a test asserting the absence of files that
no longer exist, and more importantly `lib/clerk-jwt.mjs` must be **added** to
the list. A verifier leaked into the public site would be a far worse
oversight than the ones the guard was written to catch.

### Added

| File | Responsibility |
|---|---|
| `lib/clerk-jwt.mjs` | Verify an RS256 session token against `CLERK_PEM_PUBLIC_KEY`. Validate `exp`, `nbf`, and `azp`. Pure, no network, no dependency. |
| `api/invite.js` | Admin-only. `POST https://api.clerk.com/v1/invitations`. |
| `api/authors.js` | Admin-only. List (`GET /v1/users`), remove (`DELETE /v1/users/{id}`), and set role (`PATCH /v1/users/{id}/metadata`). |
| `src/admin/` changes | Two CDN script tags; `mountSignIn` when signed out; `mountUserButton` plus admin controls when signed in. |

### Changed

`api/publish.js` and `api/unpublish.js` each change in one place: instead of
verifying the `wif_session` cookie, they call the verifier and read the email
claim. Commit attribution at `api/publish.js:174` is unaffected — it only
ever needed an email address.

### Why verification needs no JWKS fetch

Clerk publishes the instance's RS256 public key as PEM in its dashboard. That
goes into `CLERK_PEM_PUBLIC_KEY` and is verified with
`crypto.createVerify('RSA-SHA256')` from Node's standard library. No JWKS
endpoint, no cache, no cache invalidation, no dependency. Rotating the key is
an environment variable change plus a redeploy.

## Permissions

Role lives in Clerk's `publicMetadata.role`: either `admin`, or absent
meaning author. Only the Backend API can write `publicMetadata`, so an author
cannot promote themselves. `user_metadata` is deliberately not used — it is
writable by the user it belongs to, which would make self-promotion trivial.

| Capability | Author | Admin |
|---|---|---|
| Publish / unpublish | yes | yes |
| Change own password | yes | yes |
| Invite an author | no | yes |
| List authors | no | yes |
| Remove an author | no | yes |
| Promote an author to admin | no | yes |

### The one invariant

> Any removal or demotion is permitted as long as at least one admin remains.

Stated this way deliberately. An earlier draft forbade an admin from removing
or demoting *themselves*, which would have blocked the handoff case: Sean
promoting a client admin and then stepping out. The invariant permits that
and still prevents the last admin from orphaning the site.

## Flows

### 1. Invite an author

Admin, signed in, submits an email. The browser calls
`Clerk.session.getToken()` and sends it to `api/invite.js`, which verifies
the token, checks `publicMetadata.role === 'admin'`, and posts to
`https://api.clerk.com/v1/invitations` with `redirect_url` pointing at
`/admin`. Clerk sends the email itself — no Brevo or Resend involvement.

The invitee clicks through to Clerk's hosted sign-up, pre-bound to that email
address, chooses a password, and returns to `/admin` signed in. Because
sign-up mode is Restricted, the invitation is the only way an account can
come into existence.

`POST /v1/invitations` is rate limited to 100 requests per hour per
instance. A 429 carries `Retry-After` and must be surfaced as a retryable
condition, not a failure.

### 2. Forgot password

No code. `mountSignIn` includes "Forgot password?", and Clerk owns the email,
the token, its expiry, and its single use.

### 3. Change password

No code. `mountUserButton` opens Clerk's account UI, which includes a
password change under Security.

### 4. Remove or promote an author

`/admin` lists authors from `GET /v1/users`, each row offering remove and a
role toggle, both admin-gated and both subject to the invariant above.

Building this rather than sending an admin to Clerk's dashboard is what lets
a client-side admin operate without a Clerk account — which the client has
said they do not want.

## Configuration

### Environment variables

| Variable | Scope | Notes |
|---|---|---|
| `CLERK_SECRET_KEY` | Server | Never reaches the browser. |
| `CLERK_PEM_PUBLIC_KEY` | Server | Public key, kept server-side because nothing in the browser needs it. |
| `CLERK_PUBLISHABLE_KEY` | Build + public | Baked into `/admin`. Public by design. |
| `CLERK_FRONTEND_API_URL` | Build + public | CDN host for the two script tags. |

The last two are needed at build time because Eleventy renders `/admin`
statically. A small Eleventy data file reads them from `process.env`. This
differs from every other variable in the project: changing them requires a
redeploy, not just an environment variable edit.

### Clerk Dashboard settings

These are not in code and must be in `publishing-setup.md`:

1. **Sign-up mode: Restricted.** Without it, anyone who finds `/admin` can
   create an account and publish to the live site. The single most important
   setting in the design.
2. **Email + password enabled, social login disabled.**
3. **Session token customized to include `public_metadata`,** so the role
   claim is present for `api/invite.js` and `api/authors.js` to check.

### Clerk API version

As of Clerk's `2026-05-12` API version, `PATCH /v1/users/{user_id}` no longer
accepts `public_metadata` in its body; metadata must go through the dedicated
`PATCH /v1/users/{user_id}/metadata` endpoint, which deep-merges. The design
uses the dedicated endpoint. Worth recording because the older, more widely
documented shape now fails silently with respect to the role field, which
would present as "promotion didn't work" with a 200 response.

### Session token lifetime

Clerk session tokens expire after 60 seconds by default. `getToken()` must be
called immediately before each request and never cached at sign-in. A cached
token produces publishes that succeed right after login and fail with a 401 a
minute later — indistinguishable, to an author, from a broken credential.
This is a requirement with a test, not a note.

## Error handling

Errors carry a `code` the handler branches on, the convention `lib/github.mjs`
and `lib/mailer.mjs` already use.

| Code | Cause | Author-facing result |
|---|---|---|
| `config` | `CLERK_PEM_PUBLIC_KEY` or `CLERK_SECRET_KEY` missing | Operator message, logged |
| `expired` | Token past `exp` — routine, not a fault | "Your session expired — sign in again"; the editor refreshes the token and retries |
| `invalid` | Bad signature, `nbf` in the future, wrong `azp` | Generic 401 |
| `forbidden` | Valid token, not an admin | 403 |

`expired` must never collapse into `invalid`. `publishing-setup.md` already
documents the cost of that kind of conflation: every GitHub 403 reports as
"contact the site owner," including the branch-protection case that has
nothing to do with credentials, which sends an operator chasing the wrong
problem. An expired token is the expected state 60 seconds after sign-in.

## Testing

Under the existing `node --test tools/*.test.mjs`. No test touches the
network; `fetch` is injected, the seam `lib/mailer.mjs` established.

- `tools/clerk-jwt.test.mjs` — generates an RS256 keypair in-test and signs
  its own tokens. Asserts: valid token passes; expired yields `expired`;
  tampered signature yields `invalid`; foreign `azp` rejected; `nbf` in the
  future rejected; missing configuration yields `config`.
- `tools/invite.test.mjs` — author token gets 403; admin token produces the
  expected request body; a 429 surfaces as retryable.
- `tools/authors.test.mjs` — the invariant: removing or demoting the last
  admin is refused; self-removal succeeds when another admin exists.
- `tools/publish-handler.test.mjs`, `tools/unpublish.test.mjs` — updated to
  mint test tokens instead of HMAC sessions.

## Cutover

1. Create the Clerk application. Set Restricted sign-up mode, email+password
   only, and the `public_metadata` session claim.
2. Set the Clerk environment variables on a **preview** environment.
3. On the preview, set `GITHUB_BRANCH` to a throwaway branch. **Publishing
   from a preview deployment otherwise commits to the real repository and
   triggers a production deploy**, because `GITHUB_OWNER` and `GITHUB_REPO`
   carry no notion of environment. `api/publish.js` already supports
   `GITHUB_BRANCH` and defaults to `main`.
4. Invite yourself. Set `publicMetadata.role = 'admin'` with one `curl` —
   the bootstrap, since no admin exists to grant the first one.
5. Run the end-to-end checklist against the preview.
6. Production: add the Clerk variables, remove `AUTH_SECRET` and
   `AUTH_USERS`, deploy.
7. Invite the named client admin and promote them.
8. Have them invite a test author, proving the chain works without a
   developer.

Rollback is a Vercel instant rollback plus re-adding `AUTH_SECRET` and
`AUTH_USERS`, which is why step 6 removes them rather than erasing them from
Vercel's history first.

## Ownership

The Clerk application is created under the Lintel Works Clerk account, since
Sean Craig administers it under a maintenance contract and the client has
declined to hold Clerk or GitHub accounts.

This is a deliberate departure from the reasoning
`publishing-setup.md` applies to the GitHub App — that an App owned by an
organization "keeps working regardless of who is or isn't on the team." That
argument still holds, and the consequence of not following it here is that
the login system depends on an account the client does not control. The
mitigation is contractual rather than architectural, and a transfer path
should be named in the maintenance agreement: Clerk applications can be moved
between accounts, at the cost of re-keying the four environment variables and
a redeploy.

## Open questions

1. **`GITHUB_OWNER` is currently wrong in the documented setup.** `gh`
   reports the repository as `Lintel-works/women-in-fintech-nyc`, while the
   local git remote still points at `swhc1066` and silently follows a
   redirect. If the repository's final home is a NYC Fintech Women
   organization, the transfer should happen before the GitHub App is
   installed, since the App is installed per-account.
2. **Which named client contact becomes the second admin?** Required for
   cutover step 7.
3. **Does the client want Clerk's free tier branding on the sign-in form,**
   or is the paid tier in scope for the maintenance contract?
