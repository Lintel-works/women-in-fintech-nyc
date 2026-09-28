/* Sends a form submission as a notification email.
 *
 * Why a seam rather than one provider: Brevo is the intended destination but
 * its credentials were not available when the co-founder form needed to stop
 * discarding submissions. Whichever key is configured is the one that sends;
 * swapping later is an environment variable, not a deploy.
 *
 * Both providers are a single fetch of a JSON body, so this adds no dependency
 * to a project that has none. Errors carry a `code` the handler branches on,
 * matching the convention lib/github.mjs established.
 *
 * Env:
 *   FORM_PROVIDER    - optional, 'brevo' | 'resend'. Inferred when unset.
 *   BREVO_API_KEY    - Brevo transactional key
 *   RESEND_API_KEY   - Resend key
 *   FORM_FROM_EMAIL  - sender. MUST be on a domain verified with the provider,
 *                      or every send is rejected. This is the likeliest reason
 *                      a first deploy fails.
 *   FORM_TO_EMAIL    - where submissions land
 *   FORM_BCC_EMAIL   - optional second copy, costs nothing and is a cheap
 *                      backstop if the primary mailbox filters something
 */

const TIMEOUT_MS = 8000;
const FROM_NAME = 'NYC Fintech Women site';

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/* The submitter's address is the REPLY-TO, never the FROM. Sending as the
   submitter fails DMARC for their domain and lands the whole notification in
   spam -- and it is the mistake this shape exists to prevent. */
function envelope(env) {
  const from = String(env.FORM_FROM_EMAIL || '').trim();
  const to = String(env.FORM_TO_EMAIL || '').trim();
  const bcc = String(env.FORM_BCC_EMAIL || '').trim();
  if (!from || !to) return null;
  return { from, to, bcc: bcc || null };
}

async function post(url, headers, body, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) {
      throw fail('The email provider rejected the credential', 'auth');
    }
    if (!response.ok) {
      /* Never the response body: a provider can echo the key back in an error,
         and this line goes to a log the whole team can read. */
      throw fail(`The email provider returned ${response.status}`, 'upstream');
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw fail('The email provider did not answer in time', 'timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function brevoProvider(env, fetchImpl) {
  const key = String(env.BREVO_API_KEY || '').trim();
  const box = envelope(env);
  return {
    name: 'brevo',
    async send({ subject, text, replyTo }) {
      const body = {
        sender: { email: box.from, name: FROM_NAME },
        to: [{ email: box.to }],
        subject,
        textContent: text
      };
      if (box.bcc) body.bcc = [{ email: box.bcc }];
      if (replyTo) body.replyTo = { email: replyTo };
      await post('https://api.brevo.com/v3/smtp/email', { 'api-key': key }, body, fetchImpl);
    }
  };
}

export function resendProvider(env, fetchImpl) {
  const key = String(env.RESEND_API_KEY || '').trim();
  const box = envelope(env);
  return {
    name: 'resend',
    async send({ subject, text, replyTo }) {
      const body = {
        from: `${FROM_NAME} <${box.from}>`,
        to: [box.to],
        subject,
        text
      };
      if (box.bcc) body.bcc = [box.bcc];
      if (replyTo) body.reply_to = replyTo;
      await post('https://api.resend.com/emails', { authorization: `Bearer ${key}` }, body, fetchImpl);
    }
  };
}

/* Returns null when nothing is configured, so the handler can answer 503 with
   "not set up yet" rather than pretending to send. */
export function resolveProvider(env = process.env, fetchImpl = fetch) {
  if (!envelope(env)) return null;
  const named = String(env.FORM_PROVIDER || '').trim().toLowerCase();
  const hasBrevo = !!String(env.BREVO_API_KEY || '').trim();
  const hasResend = !!String(env.RESEND_API_KEY || '').trim();

  if (named === 'brevo') return hasBrevo ? brevoProvider(env, fetchImpl) : null;
  if (named === 'resend') return hasResend ? resendProvider(env, fetchImpl) : null;
  /* Brevo wins an ambiguous configuration because it is the intended
     destination; Resend is the interim. If both keys are set, the interim
     should not quietly keep serving. */
  if (hasBrevo) return brevoProvider(env, fetchImpl);
  if (hasResend) return resendProvider(env, fetchImpl);
  return null;
}
