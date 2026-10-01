# Publishing setup

This is the one-time setup for authenticated publishing from `/admin`: a
signed-in author publishes and unpublishes posts directly from the deployed
editor, and each action becomes one commit on `main`. Nobody needs a git
checkout to run a site update after this is done.

Three things have to exist before publishing works: a GitHub App installed on
this repository, a Clerk application with at least one admin, and Vercel
environment variables for both. None of them can be created from this document — a person
with access to the NYC Fintech Women GitHub organization, the Clerk
application and this Vercel project has to do it.

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

## 2. Set up Clerk

Clerk owns identity: who an author is, their password, the invitation email,
and the password-reset email. The editor loads Clerk in the browser from
script tags generated at build time, and the serverless functions verify
Clerk's RS256 session tokens against a PEM public key held in an environment
variable, using only Node's `crypto` (`lib/clerk-jwt.mjs`). `/admin` is the
only place anyone signs in. From there an admin invites authors, lists them,
removes them and promotes them to admin (`api/invite.js`, `api/authors.js`),
so a client-side admin needs neither a GitHub account nor a Clerk account.
That is the reason those endpoints exist.

### Create the application

**Create it inside an organization, not a personal account.** This is the same
argument as the GitHub App above: an application owned by an organization
keeps working regardless of who is or isn't on the team, while one owned by a
person stops being manageable the day that person leaves. For this site the
Clerk application currently sits under the maintaining agency's account,
because the client has declined to hold one. Moving it later is possible but
not free: it means creating the application elsewhere, which issues new keys,
so every Clerk variable below has to be replaced and the site redeployed, and
authors have to be invited again.

Then, in the Clerk Dashboard, in this order:

1. **Restrictions → Sign-up mode: Restricted.** This is the single most
   important setting in this document. Clerk's default lets anyone create an
   account. If it is left that way, anyone who finds `/admin` can sign up and
   publish to the live site, and nothing in this project's code will stop
   them, because a valid Clerk token is exactly what the code checks for.
   Restricted mode makes an invitation the only way in.
2. **User & authentication:** enable email address and password. Disable every
   social provider. Authors are invited by email; a "Sign in with Google"
   button would offer a way in the invitation model does not account for.
3. **Sessions → Customize session token.** Add both claims to the token's
   JSON:

   ```json
   {
     "email": "{{user.primary_email_address}}",
     "public_metadata": "{{user.public_metadata}}"
   }
   ```

   Clerk's default token contains neither. Without the email claim,
   publishing refuses every request with "Publishing is not set up on this
   site yet" (the Vercel function log says why), because the commit needs an
   author and the token is the only place the server learns one. Without the metadata claim the server cannot see anyone's role, and
   the admin gate fails in a way that points nowhere near the cause (see
   Troubleshooting below, which lists this first for that reason).
4. **API keys:** note the publishable key, the secret key, the Frontend API
   URL, and the PEM public key (the JWKS/PEM section of the same page).

### Environment variables

Set these in Vercel under **Settings → Environment Variables**, alongside the
GitHub ones above.

| Variable | Value | Read when |
|---|---|---|
| `CLERK_PUBLISHABLE_KEY` | The publishable key (`pk_...`) | Build |
| `CLERK_FRONTEND_API_URL` | The Frontend API URL, e.g. `https://<name>.clerk.accounts.dev` | Build |
| `CLERK_SECRET_KEY` | The secret key (`sk_...`) | Request |
| `CLERK_PEM_PUBLIC_KEY` | The PEM public key | Request |
| `CLERK_AUTHORIZED_PARTIES` | Comma-separated origins the site is served from, e.g. `https://nycfintechwomen.com` | Request |
| `CLERK_INVITE_REDIRECT_URL` | Where an invitation link lands, normally `https://<production-url>/admin/` | Request |

**`CLERK_PUBLISHABLE_KEY` and `CLERK_FRONTEND_API_URL` are baked into `/admin`
at build time.** Changing either needs a redeploy. Editing the variable and
doing nothing else leaves the old value in the deployed page, which is unlike
every other variable in this document. The build now fails outright if either
is missing, so every environment that builds this site (Vercel production,
every preview, and any CI) must have both set before this branch merges, or
the next deploy fails.

**`CLERK_AUTHORIZED_PARTIES` is not optional.** An empty or missing value is
treated as a configuration fault and throws, on purpose, so that an unset
variable can never silently switch off the check that a token was minted for
this site's origin. The symptom is publishing refusing with "Publishing is not set up on this
site yet", with the real reason only in the Vercel function log. List the real origin, including the
scheme and any `www.` form the site is served from.

`CLERK_SECRET_KEY` and `CLERK_PEM_PUBLIC_KEY` are server-side only. Neither
ever belongs in a file the build copies to `/admin`, and `.env.example` marks
them accordingly. The secret key can invite, list, remove and promote users,
and the PEM key is what lets the functions trust a token.

`CLERK_INVITE_REDIRECT_URL` must also be listed as an allowed redirect URL in
the Clerk Dashboard, or Clerk refuses the invitation. It is optional in the
code, but without it an invited author lands on Clerk's default page rather
than the editor.

### Bootstrap the first admin

No admin exists to grant the first one, so it is done once, directly against
Clerk. Create your own user (Clerk Dashboard → Users → Create user), copy its
user id (`user_...`), and run:

```bash
curl -X PATCH "https://api.clerk.com/v1/users/<your user id>/metadata" \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"public_metadata": {"role": "admin"}}'
```

**Use `/metadata` exactly.** As of Clerk API version `2026-05-12`, the plain
`PATCH /v1/users/<id>` silently ignores `public_metadata` while still
returning 200. Using it looks like success and changes nothing, and the
person then spends an hour wondering why the admin panel never appears.
After this, sign in at `/admin`; later admins are promoted from the panel.

Local development: `cp .env.example .env` and fill in the same variables
there (gitignored, never commit it) to run the build and `vercel dev` locally.

## 3. Cutover

Do these in order. The order matters because the build now depends on Clerk
variables that did not exist before this change.

1. Create the Clerk application and apply every setting in section 2.
2. Set all six `CLERK_*` variables in **every** Vercel environment that
   builds the site: production, and each preview. Setting them in production
   only makes every preview build fail.
3. Remove the old password-system variables from Vercel (the author-list and
   cookie-signing ones from the previous setup). Nothing reads them any more;
   leaving them is harmless but misleading.
4. Merge the branch and let Vercel deploy.
5. Bootstrap the first admin (above), sign in at `/admin`, and invite
   yourself an author address to confirm the invite email arrives.
6. Work through the checklist in section 4, and the unverified items in
   section 5, before telling anyone the editor is ready.

**Publishing from a preview deployment commits to the real repository and
triggers a production deploy.** `GITHUB_OWNER` and `GITHUB_REPO` carry no
notion of environment, so a preview that publishes is writing to the same
repository and branch as production. On any preview used for testing, set
`GITHUB_BRANCH` to a throwaway branch (`api/publish.js` supports it and
defaults to `main`), or the first test post goes live on the site.

## 4. End-to-end checklist

Run this against the **deployed** production site, with a real Clerk
application and a real GitHub App set up as above. This cannot be done from
inside this document or by an agent without those credentials — someone who
can sign in as an admin and has access to the deployed site has to walk
through it.

1. **Choose the post type, then sign in.** Open `/admin`, and pick "Jobs &
   Happenings" or "Fintech Female Fridays" from the type selector at the top
   FIRST. Switching type reloads the page (`src/admin/editor.js`'s type
   selector navigates to `?type=...`), which resets the in-memory
   "signed in" state along with everything else on the page — sign in
   afterwards, not before, or the Publish button will look disabled even
   though sign-in just succeeded. Sign in with Clerk's form in the Account
   section. Expected: the sign-in status line reads "Signed in as
   `<email>`", and Publish is enabled.
2. **Publish a news post with a cover image.** With "Jobs & Happenings"
   already selected, fill in a title and at least one block, attach a cover
   image, click Publish. Expected: a success message naming a URL of the
   form `/post-<slug>.html`.
3. **Confirm one commit, both files.** On GitHub, check the latest commit on
   `main`. Expected: exactly one new commit, authored by the signed-in
   author's email, containing both `src/posts/<slug>.html` and
   `src/images/post-<slug>.jpg`. If publishing instead says it is "not set up"
   yet, check the Vercel function log: a missing email claim in the session
   token is one of the causes.
4. **Wait for the deploy, then confirm the post is live.** Once Vercel's
   deploy for that commit finishes: the new URL loads and shows the post; a
   card for it appears on `/happenings.html`; the cover image loads (not a
   broken image icon).
5. **Unpublish it.** Back in the editor with that same post open, type the
   slug to confirm, click Unpublish. Expected: a success message. After the
   next deploy finishes, the post's URL 404s (or serves the previous
   deployment's cached copy briefly, then 404s), and its card is gone from
   `/happenings.html`.
6. **Invite an author and have them publish.** As an admin, enter a real
   address in "Invite an author". Expected: the invitation email arrives,
   its link lands on `/admin`, the invitee can set a password and sign in,
   and they can publish a post (then unpublish it).
7. **Forgot password.** Sign out, choose "Forgot password?" on the sign-in
   form. Expected: an email arrives, and the new password it lets you set
   works to sign in.
8. **Remove an author.** As an admin, remove the invited author from the
   panel. Expected: their next publish attempt returns `401` (a token
   already issued can stay valid for up to about a minute, so retry once if
   the first attempt still succeeds).
9. **The last admin cannot be removed or demoted.** As the only admin,
   try to remove and to demote yourself. Expected: both are refused with a
   message, and your role is unchanged.
10. **Call `/api/publish` with no credentials.**
    ```bash
    curl -i -X POST https://<production-url>/api/publish \
      -H 'content-type: application/json' -d '{}'
    ```
    Expected: `401`, and no new commit appears on `main`.
11. **Call `/api/publish` with a valid session but an invalid payload.** A
    blank title cannot reach the server at all — the editor refuses it
    client-side before a request is ever sent, so that is not a usable test
    of the server's own validation. Instead, sign in through the editor,
    open the browser console on `/admin`, and run
    `await Clerk.session.getToken()` to print a session token, then send a
    payload the client itself would never construct. The token lasts about
    a minute, so run the command promptly:
    ```bash
    curl -i -X POST https://<production-url>/api/publish \
      -H 'content-type: application/json' \
      -H 'authorization: Bearer <paste the token>' \
      -d '{"type":"not-a-real-type","mode":"create","fields":{},"blocks":[]}'
    ```
    Expected: `400` with an author-readable message naming the valid post
    types (not a raw error or stack trace), and no new commit on `main`.

## 5. Verification not yet performed

**The editor's browser behaviour has never been run against a live Clerk
instance.** No instance existed while this was built, and the project has no
DOM test harness, so the sign-in code in `src/admin/editor.js` is verified by
reading and by the server-side tests only. The site owner has to do the
following at cutover. Run `CLERK_PUBLISHABLE_KEY=<dev key>
CLERK_FRONTEND_API_URL=<dev frontend API url> npm run dev`, then, in order:

- [ ] `/admin` shows Clerk's sign-in form, not email and password fields of
      the site's own.
- [ ] Publish is disabled while signed out, with its "Sign in to publish"
      title.
- [ ] Signing in shows "Signed in as ..." and enables Publish.
- [ ] Clerk's user button opens account management, and Security offers a
      password change.
- [ ] "Forgot password?" on the sign-in form sends an email.
- [ ] Signing out disables Publish again.
- [ ] Wait more than 60 seconds after signing in, then publish. It must still
      succeed, because tokens last 60 seconds and the editor fetches a fresh
      one per request.
- [ ] Block the Clerk host in the browser. The editor must show "Could not
      load the sign-in form" rather than a blank panel.

The Clerk script URLs (`@clerk/ui@1`, `@clerk/clerk-js@6`) and the editor's
use of `window.__internal_ClerkUICtor` are likewise unconfirmed against a live
instance.

## 6. Troubleshooting

- **An admin sees the admin panel but gets 403 on every action.** The session
  token template is missing `public_metadata`. The browser reads the role from
  Clerk's own user object, so the panel appears; the server reads it from the
  token, finds none, and refuses. Add `"public_metadata":
  "{{user.public_metadata}}"` under Sessions → Customize session token (step 3
  of section 2). Check this first: the symptom, an admin who is refused
  everything, points at permissions, and a person will waste time re-granting
  a role that was never the problem.
- **Someone promoted to admin does not see the admin tools.** The panel is
  decided when they sign in, and their session token carries the old role
  until it refreshes. Ask them to sign out and back in.
- **The sign-in form renders blank after a Clerk update.** The editor starts
  Clerk with `window.__internal_ClerkUICtor`, taken from Clerk's published
  JavaScript quickstart. It is an internal API that Clerk does not promise to
  keep stable, so a Clerk release can break it with no change on this side.
  Check it first, in the browser console, and compare against Clerk's current
  quickstart.
- **Publishing, inviting or listing says it is "not set up".** The function
  log names the cause: a missing email claim, an empty
  `CLERK_AUTHORIZED_PARTIES`, or an unusable key. It is also what a revoked or rotated `CLERK_SECRET_KEY` reports, on purpose: it is a
  fault only the site owner can fix, not a transient failure worth retrying.
  Check that the key in Vercel is the current one, then redeploy.
- **An admin sees a message that the site may have no admin and to contact
  the site owner.** The last admin cannot be removed or demoted, but Clerk
  has no compare-and-set, so two admins acting at the same moment can still
  leave none; the code narrows that race and cannot close it. Restore one by
  running the bootstrap `curl` from section 2 against any trusted user's id.

## Known issues

- **Cover images publish only as JPG or PNG.** "Keep original" in the editor
  is refused, in the editor, with a clear message for any other format
  (webp, avif, gif) — `api/publish.js` only ever writes a `.jpg` or a `.png`,
  so publishing one of those would either be silently rewritten or refused by
  the server with no context. Uncheck "keep original" to publish a webp/avif/
  gif cover as a resized JPG instead, or convert it to a JPG or PNG first.
