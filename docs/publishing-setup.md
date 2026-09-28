# Publishing setup

This is the one-time setup for authenticated publishing from `/admin`: a
signed-in author publishes and unpublishes posts directly from the deployed
editor, and each action becomes one commit on `main`. Nobody needs a git
checkout to run a site update after this is done.

Three things have to exist before publishing works: a GitHub App installed on
this repository, at least one author account, and Vercel environment
variables for both. None of them can be created from this document — a person
with access to the NYC Fintech Women GitHub organization and this Vercel
project has to do it.

**This project must also already be a Vercel project connected to this GitHub
repository, with automatic deploys enabled on `main`.** Everything below
assumes a push to `main` triggers a Vercel build and deploy on its own —
that connection is set up once, outside this document, in the Vercel
dashboard (Project → Settings → Git). Without it, a publish still commits
successfully, but the site never updates and "Live in about a minute" (the
editor's own success message) never becomes true.

## 1. Create the GitHub App

**Why an App, and not a personal access token.** A PAT is issued to a person.
It expires (or the person who issued it leaves, is offboarded, or rotates
their credentials for unrelated reasons), and publishing dies with it. This
project is built on the assumption that no developer exists after handoff —
nobody is watching for a PAT to expire or a former team member's token to stop
working. A GitHub App is owned by the organization, not a person. It keeps
working regardless of who is or isn't on the team, and the only thing that
can break it is someone deliberately uninstalling it or revoking its key —
both explicit organizational actions, not incidental ones.

Steps:

1. In the GitHub organization's settings (not a personal account's settings),
   go to **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Give it a name (e.g. "NYC Fintech Women Publisher") and a homepage URL
   (the site's production URL is fine). Disable webhooks — nothing here
   listens for one.
3. Under **Permissions → Repository permissions**, set **Contents: Read and
   write** and leave every other permission at "No access." This app should
   not be able to read issues, manage Actions, or touch anything but the
   repository's file contents.
4. Under **Where can this GitHub App be installed?**, choose "Only on this
   account."
5. Create the app. On its settings page, note the **App ID** — this becomes
   `GITHUB_APP_ID` below.
6. Generate a private key (**Generate a private key** button). This downloads
   a `.pem` file. Keep it somewhere safe — this is what becomes
   `GITHUB_APP_PRIVATE_KEY`, and it is the one credential that makes
   publishing work at all. Anyone with this file can commit to this
   repository as the App.
7. Install the app: from the app's settings page, **Install App**, choose the
   organization, and select **Only select repositories** → this repository
   only. Do not grant it access to any other repository.
8. After installing, note the **installation ID** — visible in the URL of the
   installation's settings page
   (`github.com/organizations/<org>/settings/installations/<installation id>`).
   This becomes `GITHUB_INSTALLATION_ID` below.

**Branch protection on `main` will break publishing, and the error it
produces does not say so.** If `main` has a branch protection rule that
blocks direct pushes (required reviews, required status checks, etc.), the
App's commit is rejected by GitHub with a 403, and `lib/github.mjs` reports
every 403 the same way it reports a genuinely bad credential: "The site's
GitHub access is not working — contact the site owner." If publishing was
working and then suddenly isn't, and nothing about the App or its key
changed, check whether a branch protection rule was added or tightened on
`main` before assuming the credential itself is the problem.

### How the token actually works — nothing to paste, nothing that expires

Earlier drafts of this setup had you mint a GitHub App installation token by
hand and paste it into a `GITHUB_TOKEN` environment variable. **That approach
does not work for unattended, long-term use: an installation token expires
one hour after it is issued (GitHub's own platform behaviour, not a choice
made here), and there is nobody around to notice or refresh it.** Publishing
would work for about an hour after setup and then fail permanently.

This project does not do that. `/api/publish` and `/api/unpublish`
(`lib/github-auth.mjs`) mint a **fresh** installation token from the App's
private key on every single request, using it once and discarding it. What
you configure is the durable credential — the App ID, the private key, and
the installation ID — never a token itself. Nothing here ever goes stale.

**A note on pasting the private key into Vercel:** a `.pem` file is
multi-line, and pasting it into a single Vercel environment variable field
sometimes turns its real line breaks into literal `\n` two-character
sequences instead of preserving them. `lib/github-auth.mjs` normalises either
form automatically, so paste the key however Vercel's field gives it back to
you — you do not need to manually re-insert line breaks.

### Vercel environment variables (Production)

In the Vercel dashboard, under this project's **Settings → Environment
Variables**, add these for the **Production** environment:

| Variable | Value |
|---|---|
| `GITHUB_APP_ID` | The App ID from step 5 |
| `GITHUB_APP_PRIVATE_KEY` | The full contents of the `.pem` file from step 6 |
| `GITHUB_INSTALLATION_ID` | The installation ID from step 8 |
| `GITHUB_OWNER` | The GitHub organization or user that owns this repository |
| `GITHUB_REPO` | This repository's name |

`GITHUB_BRANCH` is optional and defaults to `main` (`api/publish.js`,
`api/unpublish.js`) — only set it if publishing should target a different
branch.

**Do not set `GITHUB_TOKEN` in Production.** It exists only as a test-only
override (used by this project's own test suite, and useful for local
`vercel dev` experimentation) that bypasses minting entirely and uses
whatever value it holds as the bearer token verbatim. If it is set, publishing
uses it — and reintroduces the exact one-hour expiry problem the App-based
design above exists to avoid. `lib/github-auth.mjs` logs a warning every time
it is used, specifically so this cannot fail silently, but the warning only
reaches a Vercel function log nobody is reading. Simplest fix: don't set it.

Redeploy after setting the variables above; Vercel Functions only read
environment variables present at build/deploy time.

## 2. Create the first author

Publishing has no self-service sign-up. An author account is one line in the
`AUTH_USERS` environment variable, added by whoever manages the Vercel
project.

**Passwords must be generated, never chosen.** There is no separate rate
limiting on `/api/login` (see `api/login.js`) — a bad guess costs nothing in
terms of a lockout or a delay imposed by this project's own code. What does
slow a guess down is `lib/password.mjs`'s use of scrypt, which is
deliberately slow by design; that is a real, intentional defence, just not a
rate limiter. It only works if the password itself is hard to guess in the
first place — a machine-generated password has that property, a chosen one
(however "random" it feels to the person choosing it) usually doesn't.

```bash
# 1. AUTH_SECRET — generate once, shared by every author. Must be at least
#    32 characters (api/login.js refuses a shorter one outright, treating it
#    as "not configured" rather than accepting a weak one). Rotating it signs
#    everyone out at once; that's the intended way to force a re-login.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. A generated password for the new author. Send this to them directly
#    (not by a channel that gets logged in plaintext) and never store it
#    yourself once it's hashed.
node -e "console.log(require('crypto').randomBytes(16).toString('base64url'))"

# 3. Hash that password for AUTH_USERS. This prints "<salt>:<hash>".
node tools/hash-password.mjs 'the password printed in step 2'
```

`AUTH_USERS` is a JSON object mapping the author's email to the `<salt>:<hash>`
line from step 3. **The email key must be lowercase** — `api/login.js`
lowercases whatever the sign-in form submits before looking it up, so an
uppercase (or mixed-case) key here can never match and that author's correct
password will always be refused:

```json
{"jane@example.com": "a1b2c3...:d4e5f6..."}
```

Add more authors by adding more entries; remove one by deleting their entry.
Set both `AUTH_SECRET` and `AUTH_USERS` in Vercel under **Production**
alongside the GitHub variables above, then redeploy.

Local development: `cp .env.example .env` and fill in the same variables
there (gitignored, never commit it) if you need to run `/api/login` and
`/api/publish` against a local `vercel dev` server.

## 3. End-to-end checklist

Run this against the **deployed** production site, with a real sign-in and a
real GitHub App installed as above. This cannot be done from inside this
document or by an agent without those credentials — someone with the author
password and access to the deployed site has to walk through it.

1. **Choose the post type, then sign in.** Open `/admin`, and pick "Jobs &
   Happenings" or "Fintech Female Fridays" from the type selector at the top
   FIRST. Switching type reloads the page (`src/admin/editor.js`'s type
   selector navigates to `?type=...`), which resets the in-memory
   "signed in" state along with everything else on the page — sign in
   afterwards, not before, or the Publish button will look disabled even
   though sign-in just succeeded. Enter the author's email and generated
   password. Expected: the sign-in status line reads "Signed in as
   `<email>`."
2. **Publish a news post with a cover image.** With "Jobs & Happenings"
   already selected, fill in a title and at least one block, attach a cover
   image, click Publish. Expected: a success message naming a URL of the
   form `/post-<slug>.html`.
3. **Confirm one commit, both files.** On GitHub, check the latest commit on
   `main`. Expected: exactly one new commit, authored by the signed-in
   author's email, containing both `src/posts/<slug>.html` and
   `src/images/post-<slug>.jpg`.
4. **Wait for the deploy, then confirm the post is live.** Once Vercel's
   deploy for that commit finishes: the new URL loads and shows the post; a
   card for it appears on `/happenings.html`; the cover image loads (not a
   broken image icon).
5. **Unpublish it.** Back in the editor with that same post open, type the
   slug to confirm, click Unpublish. Expected: a success message. After the
   next deploy finishes, the post's URL 404s (or serves the previous
   deployment's cached copy briefly, then 404s), and its card is gone from
   `/happenings.html`.
6. **Call `/api/publish` with no cookie.**
   ```bash
   curl -i -X POST https://<production-url>/api/publish \
     -H 'content-type: application/json' -d '{}'
   ```
   Expected: `401`, and no new commit appears on `main`.
7. **Call `/api/publish` with a valid session but an invalid payload.** A
   blank title cannot reach the server at all — the editor refuses it
   client-side before a request is ever sent, so that is not a usable test of
   the server's own validation. Instead, sign in through the editor (step 1),
   open your browser's dev tools → Application/Storage → Cookies, copy the
   value of `wif_session`, and send a payload the client itself would never
   construct:
   ```bash
   curl -i -X POST https://<production-url>/api/publish \
     -H 'content-type: application/json' \
     -H 'cookie: wif_session=<paste the value>' \
     -d '{"type":"not-a-real-type","mode":"create","fields":{},"blocks":[]}'
   ```
   Expected: `400` with an author-readable message naming the valid post
   types (not a raw error or stack trace), and no new commit on `main`.

## Known issues

- **Cover images publish only as JPG or PNG.** "Keep original" in the editor
  is refused, in the editor, with a clear message for any other format
  (webp, avif, gif) — `api/publish.js` only ever writes a `.jpg` or a `.png`,
  so publishing one of those would either be silently rewritten or refused by
  the server with no context. Uncheck "keep original" to publish a webp/avif/
  gif cover as a resized JPG instead, or convert it to a JPG or PNG first.
