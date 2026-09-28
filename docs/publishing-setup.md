# Publishing setup

This is the one-time setup for authenticated publishing from `/admin`: a
signed-in author publishes and unpublishes posts directly from the deployed
editor, and each action becomes one commit on `main`. Nobody needs a git
checkout to run a site update after this is done.

Three things have to exist before publishing works: a GitHub App installed on
this repository, at least one author account, and five environment variables
set in Vercel. None of them can be created from this document — a person with
access to the NYC Fintech Women GitHub organization and this Vercel project
has to do it.

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
5. Create the app. On its settings page, note the **App ID** — it identifies
   the app but is not itself a secret used by this project.
6. Generate a private key (**Generate a private key** button). This downloads
   a `.pem` file. This project's server code does not consume the private key
   directly (see the caveat below) — keep it somewhere safe regardless, since
   it's how you mint new installation tokens.
7. Install the app: from the app's settings page, **Install App**, choose the
   organization, and select **Only select repositories** → this repository
   only. Do not grant it access to any other repository.
8. After installing, note the **installation ID** — visible in the URL of the
   installation's settings page
   (`github.com/organizations/<org>/settings/installations/<installation id>`).

### Getting a token into `GITHUB_TOKEN`

`api/publish.js` and `api/unpublish.js` send `GITHUB_TOKEN` straight to the
GitHub API as a bearer token (see `lib/github.mjs`) — there is no code in this
project that mints or refreshes a token from the App's private key. What
`GITHUB_TOKEN` must hold is a **GitHub App installation access token** for the
installation from step 8.

**This token expires one hour after it is issued — this is GitHub's platform
behavior, not a choice made here.** There is no refresh logic in this
codebase, so publishing will start failing with "The site's GitHub access is
not working" roughly an hour after `GITHUB_TOKEN` is set, until it is
regenerated. This is recorded under **Known issues** below; treat it as
something to solve (a scheduled job that mints a fresh token and updates the
Vercel env var, or a small serverless function that exchanges the private key
for a token on demand) before relying on this for day-to-day publishing.

To mint a token by hand for now: sign a JWT with the private key from step 6
and the App ID from step 5, then call
`POST /app/installations/<installation id>/access_tokens` with that JWT as
the bearer token. GitHub's own guide for this exact flow is
["Authenticating as a GitHub App installation"](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).
Paste the resulting token into `GITHUB_TOKEN` in Vercel.

### Vercel environment variables (Production)

In the Vercel dashboard, under this project's **Settings → Environment
Variables**, add these for the **Production** environment:

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | The installation access token from above |
| `GITHUB_OWNER` | The GitHub organization or user that owns this repository |
| `GITHUB_REPO` | This repository's name |

`GITHUB_BRANCH` is optional and defaults to `main` (`api/publish.js`,
`api/unpublish.js`) — only set it if publishing should target a different
branch.

Redeploy after setting them; Vercel Functions only read environment variables
present at build/deploy time.

## 2. Create the first author

Publishing has no self-service sign-up. An author account is one line in the
`AUTH_USERS` environment variable, added by whoever manages the Vercel
project.

**Passwords must be generated, never chosen.** There is no rate limiting on
`/api/login` (see `api/login.js`) — nothing here slows down or blocks repeated
guesses. The only thing standing between an attacker and a login is the
password's own entropy. A chosen password, however "random" it feels, is
guessable in ways a human can't judge; a machine-generated one isn't.

```bash
# 1. AUTH_SECRET — generate once, shared by every author. Rotating it signs
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
line from step 3:

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

1. **Sign in.** Open `/admin`, enter the author's email and generated
   password. Expected: the sign-in status line reads "Signed in as
   `<email>`."
2. **Publish a news post with a cover image.** Pick type "Jobs & Happenings,"
   fill in a title and at least one block, attach a cover image, click
   Publish. Expected: a success message naming a URL of the form
   `/post-<slug>.html`.
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
7. **Publish a post titled `...`.**  In the editor, set the title to exactly
   three dots and attempt to publish. Expected: `400` with an author-readable
   message (not a raw error or stack trace), and no new commit on `main`.

## Known issues

- **PNG "keep original" cover images publish broken.** If an author checks
  "keep original" on a PNG cover image, the post's front matter records
  `images/<prefix><slug>.png`, but `api/publish.js` always writes the
  uploaded image to `src/images/<prefix><slug>.jpg` regardless of the
  original format — the editor's publish path (`coverAsBase64` in
  `src/admin/editor.js`) always re-encodes to JPEG. The published post ends
  up pointing at a `.png` file that was never written, so its cover image is
  broken. This is a known bug, not yet fixed as of this document. Workaround
  until fixed: don't check "keep original" when publishing (as opposed to
  downloading) a PNG cover.
- **`GITHUB_TOKEN` expires after one hour.** See "Getting a token into
  `GITHUB_TOKEN`" above — this project has no code that refreshes an
  installation token, so publishing will start failing roughly an hour after
  the token is set, with the message "The site's GitHub access is not
  working," until someone mints a fresh token and updates the Vercel env var.
