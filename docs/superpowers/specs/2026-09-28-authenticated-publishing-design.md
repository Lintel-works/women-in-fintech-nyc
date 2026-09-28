# Phase 7 — authenticated publishing

Status: design approved in conversation, spec awaiting review.

## Why

Phases 5 and 6 made posts into data, gave the file format a `type`, and built a
second type end to end. An author can now compose a post in the deployed editor
at `/admin` and get back a file. They cannot publish it.

Today the hand-off is a download: the editor produces `<slug>.html`, and
somebody with a git checkout puts it in `src/posts/`, commits, and pushes. That
somebody is a developer. The Phase 5 spec is explicit that after handoff there
is no developer, which makes the current workflow a temporary state with a known
end date rather than a workflow.

This phase closes it. A signed-in author presses Publish and the post is live,
with no review step, no approval queue, and nobody to commit on their behalf.

## Operating assumption

Unchanged from Phases 5 and 6, and it still outranks convenience wherever they
conflict:

**After handoff there is no developer.** The site is run by the people who write
for it. Nobody will read a build log, debug a failed deploy, or run a command.

This phase adds a second, sharper clause. Publishing is a *write path into the
live site*, so the assumption now governs security as well as usability:

- **A component that can rot is a liability.** A vendor free tier that changes,
  an API that deprecates, a token that expires — each needs a developer to
  respond, and there will not be one. Prefer what does not rot.
- **A failure must be visible to the person who caused it**, at the moment they
  cause it. Anything discovered later is discovered by nobody.
- **Recovery must not require a checkout.** If the only fix for a bad post is
  `git revert`, the phase has not removed the developer, it has only moved them.

## What success looks like

1. An author signs in at `/admin` with credentials they hold, and stays signed
   in across a session.
2. They compose a post of either type — `fff` or `post` — press Publish, and
   see a confirmation naming the URL the post will appear at.
3. Within about a minute the page is live, linked from its listing page and, for
   `fff`, from the homepage.
4. They can unpublish a post they published, without help.
5. A post that would fail the build is refused *before* it is committed, with a
   message written for an author.
6. No credential capable of writing to the repository ever reaches the browser.
7. The seven existing FFF pages and every other published page are unchanged by
   this phase's code.

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Auth mechanism | Self-contained: `scrypt` hashes in a Vercel env var, HMAC-signed session cookie | Free permanently, no vendor to rot, no new dependency. See Risks. |
| Auth provider | None (deliberately) | A managed provider is the component most likely to need a developer after handoff |
| Number of logins | Deferred; design is indifferent | Named accounts and one shared login both satisfy the seam. See "The auth seam". |
| Commit mechanism | GitHub Git Data API (blobs → tree → commit → ref) | Commits the post file and its cover image in ONE commit, so one publish is one deploy |
| Repo credential | GitHub App owned by the organization | An installation token has no expiry to manage and does not belong to a person who may leave |
| Serialization | Server-side, from structured data | The browser must never name a path or supply finished file bytes. See "Why the server serializes". |
| Image handling | Resized client-side before upload | Vercel caps function request bodies at 4.5 MB; a phone photo can exceed that unaided |
| Build-failure defence | Render the post server-side before committing | Converts a silent failed build into an error the author sees |
| Rate limiting | None; generated passwords instead | A stateless function cannot rate-limit without storage. See Risks. |

## Architecture

Three new server-side pieces, one new shared module, and an editor that mostly
stays as it is.

```
Browser (/admin)                 Vercel Functions            GitHub            Vercel
─────────────────                ─────────────────           ──────            ──────
sign-in form      ──POST──────▶  /api/login
                                   verify scrypt hash
                  ◀──Set-Cookie── sign session

editor (existing) ──POST──────▶  /api/publish
                                   1. verify cookie
                                   2. validate + render
                                   3. blobs          ──────▶ POST git/blobs
                                   4. tree           ──────▶ POST git/trees
                                   5. commit + ref   ──────▶ POST git/commits
                  ◀──200 + URL──                             PATCH git/refs
                                                             │
                                                             └─webhook─▶ rebuild → live
```

### `lib/session.mjs` — the auth seam

Pure functions, no I/O, importable by both the functions and the tests:

- `signSession(payload, secret)` — HMAC-SHA256 over a compact payload
  (`{ sub, iat, exp }`), returned as a cookie-safe string.
- `verifySession(cookie, secret)` — returns the payload or `null`. Timing-safe
  comparison via `crypto.timingSafeEqual`. Rejects expired sessions.

This module is the seam the whole auth decision sits behind. `/api/publish` asks
it exactly one question — *who is this caller?* — and knows nothing about how
they proved it. Replacing the mechanism later (GitHub OAuth, a managed provider)
replaces this file and `/api/login`, and touches nothing else.

`AUTH_SECRET` and `AUTH_USERS` are read from the environment, never bundled.

### `api/login.js`

POST only. Accepts `{ email, password }`. Verifies against `AUTH_USERS`, a JSON
map of email to `scrypt` hash held in a Vercel environment variable. On success
sets the session cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, with
`Max-Age` of 12 hours — long enough to write a post without re-authenticating,
short enough that a session left open on a shared machine expires the same day.

It follows the discipline `api/events.js` established: one method, no request
input forwarded anywhere, and a response that is an explicit allowlist — success
or failure, never a hint about which half was wrong.

### `api/publish.js`

POST only, and the only code in the project that can write to the repository.
Steps, in order, refusing at the first failure:

1. **Verify the session.** No valid cookie, no further work.
2. **Validate the payload.** `type` must be a registered key in
   `lib/post-types.mjs`. Required fields per that type must be present. Block
   types must be ones `lib/render-blocks.mjs` knows.
3. **Compute the path.** Always `src/posts/<slug>.html`, slug derived
   server-side from the type's `slugSource` field. The client never supplies it.
4. **Render the post.** Run it through `lib/render-blocks.mjs`. A throw here
   means the build would have failed; refuse and return the reason.
5. **Serialize.** `lib/post-file.mjs`, the same module the importer and the
   tests use.
6. **Write one commit.** Blob for the image (base64) and blob for the post file
   (utf-8); a tree over the current head's tree via `base_tree`; a commit naming
   that head as parent; then update `refs/heads/main`.
7. **Return** the permalink the post will publish at.

### Why the server serializes

The browser sends structured data — type, fields, blocks, image bytes — not a
finished file and not a path.

If the browser supplied file text and a destination, anything that compromised
the editor page could write arbitrary content anywhere in the repository:
`eleventy.config.js`, `api/events.js`, a CI workflow. Computing the path
server-side from a validated type and a slugified title reduces the write
surface to exactly one directory, whatever the client sends.

The editor keeps its own copy of the validation, because an author should learn
about a blank title before they press Publish. That copy is a courtesy. The
server's copy is the one that is load-bearing.

### Create versus update

The payload carries an explicit `mode`. The editor already distinguishes opening
an existing post from starting a new one, so this is a field it can set
honestly.

- `create` — refused if the computed path already exists.
- `update` — refused if it does not.

This is Phase 6's duplicate-slug build failure moved earlier, from build time to
publish time, where an author can still see it.

### Unpublish

A commit that deletes `src/posts/<slug>.html`, via the same tree mechanism with
a null sha for that path. Same session check, same path discipline. It exists
because with no review step the first bad post is a matter of time, and the
alternative recovery is a developer with a checkout.

### Images

Resized in the browser before upload: canvas re-encode, long edge capped, JPEG
quality about 0.82. The editor already performs canvas `toBlob` work for the
renamed-image feature, so this extends an existing path rather than adding one.

This is not an optimization. Vercel limits a function's request body to 4.5 MB,
and an unmodified phone photo can exceed that by itself, so without the resize
the flow does not work at all.

The image rides in the same commit as its post, under the path the type's cover
convention dictates.

### Concurrent publishes

The commit names its parent, so if `main` moved between reading the head and
updating the ref, the update fails rather than clobbering. Retry once against
the new head; if it still conflicts, tell the author someone else just published
and to try again. Rare with a handful of authors, but it must not corrupt.

## Error handling

Every message is written for an author with no terminal and no repository. The
existing editor sets the standard — *"Add a post title — this post type has no
default title."*

| Condition | Response |
|---|---|
| Wrong email or password | "That email and password do not match." Never which half failed. |
| Session expired | Return to sign-in with "Your session expired — sign in again." The draft is preserved. |
| Missing required field | Named plainly, per field, before the request is sent. |
| Unknown block or type | Refused server-side, naming what was not recognised. |
| Post fails to render | Refused before committing, with the renderer's reason. Nothing is written. |
| `create` onto an existing path | "A post already exists at that address. Change the title, or open the existing post to edit it." |
| GitHub credential expired or revoked | "The site's GitHub access is not working — contact `<break-glass contact>`." Logged server-side with detail. The contact is a build-time constant, resolved by the open question below; it is not shipped as a literal placeholder. |
| Concurrent publish conflict | "Someone else just published. Try again." |
| Vercel build fails after a successful commit | The previous deployment keeps serving. See Risks. |

## Testing

- `lib/session.mjs` under `node --test`, with no server: round-trip, tampered
  signature, truncated cookie, wrong secret, expired `exp`, and a timing-safe
  comparison that does not early-return.
- Payload validation tested directly as a pure function: unknown type, missing
  required field, unknown block type, a slug that sanitizes to empty, a `create`
  colliding with an existing path.
- Path computation tested against traversal attempts (`../`, absolute paths, a
  title that slugifies to `..`) to prove the write stays in `src/posts/`.
- The render-before-commit gate tested with a post that the renderer rejects,
  asserting no GitHub call is made.
- The GitHub write exercised against a scratch repository rather than mocked,
  because a mock of the Git Data API would assert our assumptions about it
  rather than its behaviour.
- The existing 98 tests must stay green, and the published pages byte-identical.

## Verification

1. `npm test` green, including the new suites.
2. A post published from the deployed editor appears at its permalink, on its
   listing page, and — for `fff` — on the homepage.
3. That post's commit in `main` contains both the post file and the image, and
   its message names the signed-in account. (Per-person attribution depends on
   the deferred logins decision; the commit records whatever identity the
   session carries.)
4. Unpublishing it removes the page and the card.
5. `/api/publish` called without a valid cookie returns 401 and writes nothing.
6. A post crafted to fail the renderer is refused, and no commit appears.
7. The seven FFF pages remain byte-identical, checked build-to-build.

## Out of scope

- **A review or approval queue.** Explicitly rejected: the author publishes and
  is done.
- **Editing published posts from a list.** The editor opens a file the author
  has; browsing published posts to pick one is a later convenience.
- **Roles or permissions.** Every author can publish anything. With a handful
  of trusted staff, tiers are complexity without a beneficiary.
- **Password self-service reset.** See the open question.
- **Media library.** One cover image per post, as today.
- **Moving posts out of git.** Posts stay files; this phase changes the
  transport, not the format.

## Risks

**We own the authentication code.** No vendor means no vendor patching our
mistakes, and no developer here to patch them either. Mitigated by keeping the
surface small — one endpoint, one cookie, standard primitives from Node's
`crypto` — and by testing the seam hard. Accepted because the blast radius is
defacing a community site, not payments or personal data, and because the most
sensitive credential in the project (the Luma key) already lives server-side and
is unaffected.

**No rate limiting on sign-in.** A stateless function cannot rate-limit without
storage this project does not have and will not pay for. Rather than ship a weak
version, the design sidesteps it: passwords are *generated, not chosen* — long
random strings kept in a password manager — and `scrypt` is deliberately slow.
Online guessing against a 20-character random secret is not viable. This is a
mitigation, not a rate limiter, and is recorded as such.

**A failed build after a successful commit.** The render-before-commit gate
makes this unlikely, but it cannot be impossible — a commit could still break
the build for a reason the renderer does not see. The previous deployment keeps
serving, so the site does not go down; the failure mode is a post that does not
appear. Residual, and the reason the gate exists.

**GitHub App setup happens once, while a developer exists.** If it is ever
uninstalled or its permissions change, publishing stops and recovery needs
somebody with GitHub organization access. Unavoidable: something always sits
behind the last credential.

## Open question

**Who is the break-glass person?**

This phase removes the developer from *publishing*. It cannot remove them from
*account recovery*. If an author forgets their password, the fix is editing a
Vercel environment variable, which needs dashboard access. If the GitHub App
needs reinstalling, that needs organization access.

Somebody must hold those. The question is who, and whether they know they do.
It should be answered while the people involved are still in the room, not
discovered eighteen months later.

This does not block implementation. It blocks handoff.
