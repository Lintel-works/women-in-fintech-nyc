/* POST /api/form — receives a public form submission and emails it.
 *
 * Why this exists: the co-founder matching form validated, told the visitor
 * "Request received.", and discarded the data. Every submission since launch
 * was lost, with the person believing they had applied. Nothing about this
 * endpoint matters more than never doing that again -- which is why a failure
 * here returns a non-2xx and the page shows it, rather than thanking them.
 *
 * It follows the discipline api/events.js established: one
 * method, request input never forwarded upstream unvalidated, no credential in
 * any response or log line.
 *
 * One endpoint serves every form, discriminated by `kind`. Two near-identical
 * handlers would drift -- the same split that put two slugify implementations
 * in this codebase and corrupted a published post.
 *
 * Env: see lib/mailer.mjs.
 */
import { validateSubmission } from '../lib/form-schema.mjs';
import { resolveProvider } from '../lib/mailer.mjs';

/* A bot fills every field it can see. A real person never sees this one, so a
   value in it is a bot -- answered with the normal success body and no send,
   because telling a bot it was caught teaches it to stop filling the trap. */
const HONEYPOT = 'website';

/* Client-supplied and therefore forgeable; it costs a scripted submitter one
   line to defeat. It is here because it is free and stops the unsophisticated
   majority, not because it is a control. */
const MIN_FILL_MS = 3000;

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const body = typeof request.body === 'object' && request.body ? request.body : {};

  if (String(body[HONEYPOT] || '').trim()) {
    return response.status(200).json({ ok: true });
  }

  /* Only a genuine number counts. Coercing with Number() would turn null into
     0 -- an absent or null field would then read as an instant submission and
     a real person would be silently dropped, which is the exact failure this
     endpoint exists to end. Missing telemetry fails OPEN. */
  const elapsed = typeof body.elapsedMs === 'number' && Number.isFinite(body.elapsedMs)
    ? body.elapsedMs
    : null;
  if (elapsed !== null && elapsed >= 0 && elapsed < MIN_FILL_MS) {
    return response.status(200).json({ ok: true });
  }

  const valid = validateSubmission(body.kind, body);
  if (!valid.ok) {
    return response.status(400).json({ message: valid.message });
  }

  const provider = resolveProvider();
  if (!provider) {
    /* Distinct from a send failure on purpose. An operator reading the log
       needs to know nothing is configured, not chase a provider outage. */
    console.error('Form submissions are not configured: no provider and/or no from/to address');
    return response.status(503).json({
      message: 'This form is not set up to send yet. Please email us instead.'
    });
  }

  try {
    await provider.send({ subject: valid.subject, text: valid.text, replyTo: valid.replyTo });
    return response.status(200).json({ ok: true });
  } catch (error) {
    /* The submitter's address and the kind, never the free text: this line is
       the last copy of a submission that failed to send, and it goes to a log
       the whole team can read. The body would put someone's private answers
       there. */
    console.error(
      'Form submission failed to send',
      JSON.stringify({ kind: valid.kind, from: valid.replyTo, at: new Date().toISOString(), code: error.code })
    );
    const status = error.code === 'auth' ? 503 : error.code === 'timeout' ? 504 : 502;
    return response.status(status).json({
      message: 'We could not send that just now. Please try again, or email us directly.'
    });
  }
}
