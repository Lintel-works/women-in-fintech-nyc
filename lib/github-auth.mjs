/* Mints a GitHub App installation token, fresh, once per request.
 *
 * Ruling 25: an installation token expires ONE HOUR after it is issued --
 * this is GitHub's platform behaviour, not a choice made here. The original
 * design put a token straight into GITHUB_TOKEN and used it forever, which
 * means publishing would work for about an hour after setup and then fail
 * permanently, with the message "The site's GitHub access is not working"
 * and no developer around to mint a new one. What is durable is the App's
 * PRIVATE KEY, not a token minted from it -- so this module signs a
 * short-lived JWT with that key and exchanges it for a fresh installation
 * token on every call. No new dependency: Node's crypto signs RS256 natively
 * (createSign('RSA-SHA256')), the same way lib/session.mjs already builds a
 * JWT-shaped token with HMAC.
 */
import { createSign } from 'node:crypto';

const API = 'https://api.github.com';

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const b64url = (value) => Buffer.from(value).toString('base64url');

/* A Vercel env var carries a PEM's real line breaks as literal backslash-n
   sequences (pasting a multi-line secret into a single-line field does
   this), while a key set some other way (a local .env, a shell export) may
   already have real newlines. Only rewrite the escaped form, or a key that
   is already correct would be corrupted by turning a real backslash inside
   it (there are none in a PEM, but the rule should still not assume) into
   two characters that look like one. */
export function normalisePrivateKey(raw) {
  const value = String(raw || '');
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

/* iat is backdated 60 seconds for clock skew between this process and
   GitHub's, a standard JWT precaution; exp is kept well under GitHub's
   10-minute ceiling for an App JWT (not to be confused with the separate
   one-hour ceiling on the installation token this JWT is exchanged for). */
export function signAppJwt({ appId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 60, exp: now + 540, iss: String(appId) };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  let signature;
  try {
    signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url');
  } catch (error) {
    // Distinct from a GitHub-rejected credential: this never reached the
    // network. A malformed or truncated PEM (the literal-\n trap above, a
    // partial paste into the Vercel dashboard) fails right here, and an
    // operator chasing "GitHub rejected the credential" would be chasing
    // the wrong problem.
    throw fail("The site's GitHub key could not be read — contact the site owner.", 'key');
  }
  return `${signingInput}.${signature}`;
}

/* Exchanges the signed JWT for an installation access token. This is the
   only network call in this module; everything above it is pure. */
export async function mintInstallationToken({ appId, privateKey, installationId, fetchImpl = fetch }) {
  const jwt = signAppJwt({ appId, privateKey: normalisePrivateKey(privateKey) });
  const response = await fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${jwt}`,
      'user-agent': 'nyc-fintech-women-admin'
    }
  });
  if (response.status === 401 || response.status === 403) {
    throw fail('GitHub rejected the credential', 'auth');
  }
  if (!response.ok) {
    throw fail(`GitHub returned ${response.status} minting an installation token`, 'github');
  }
  const json = await response.json();
  if (typeof json?.token !== 'string') {
    throw fail('GitHub returned an unexpected response shape', 'github');
  }
  return json.token;
}

/* The one place either publishing endpoint gets a usable token, minted once
   per request and threaded through from there -- never minted per GitHub API
   call, and never cached between requests (see the module comment for why).
   GITHUB_TOKEN, when set, bypasses minting entirely and is used as the
   bearer token verbatim: a deliberate test-only override (see the tests,
   and local `vercel dev` runs where an App may not be worth setting up) that
   ALSO reintroduces the one-hour bomb if left set in production, so every
   use of it warns loudly rather than silently doing the thing Ruling 25
   exists to prevent. Returns null when neither a token nor the three App
   variables are configured, so the caller can 503 with "not set up" rather
   than attempting a mint that was never going to work. */
export async function resolveGithubToken(env = process.env, fetchImpl = fetch) {
  if (env.GITHUB_TOKEN) {
    console.warn(
      'GITHUB_TOKEN is set and is being used directly instead of minting a GitHub App ' +
      'installation token. This token expires (GitHub App installation tokens expire one ' +
      'hour after issue) -- unset GITHUB_TOKEN in production so a fresh one is minted on ' +
      'every request instead.'
    );
    return env.GITHUB_TOKEN;
  }
  const appId = env.GITHUB_APP_ID;
  const installationId = env.GITHUB_INSTALLATION_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !installationId || !privateKey) return null;
  return mintInstallationToken({ appId, privateKey, installationId, fetchImpl });
}
