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
 * Env: see lib/mailer.mjs for sending, lib/brevo-contacts.mjs for the
 * mailing-list subscription a membership signup can ask for.
 */
import { validateSubmission } from '../lib/form-schema.mjs';
import { resolveProvider } from '../lib/mailer.mjs';
import { resolveSubscriber } from '../lib/brevo-contacts.mjs';
import { resolveSheet } from '../lib/nomination-sheet.mjs';

/* A bot fills every field it can see. A real person never sees this one, so a
   value in it is a bot -- answered with the normal success body and no send,
   because telling a bot it was caught teaches it to stop filling the trap. */
const HONEYPOT = 'website';

/* Client-supplied and therefore forgeable; it costs a scripted submitter one
   line to defeat. It is here because it is free and stops the unsophisticated
   majority, not because it is a control. */
const MIN_FILL_MS = 3000;

/* Puts the submitter on the mailing list when they asked to be on it.
 *
 * Never throws and never changes the response. The notification email has
 * already been sent by the time this runs, so the submission is not lost
 * whatever happens here -- and failing the request would make the person
 * resubmit, sending the team a second copy of answers they already have.
 *
 * Every outcome short of success is logged with the address, because the log
 * is then the only record of someone who believes they subscribed and did
 * not, and an operator needs to be able to add them by hand. The free text
 * never goes here; only the address and the kind, matching the convention in
 * the catch block below.
 */
async function subscribeIfAsked(valid) {
  /* Who to subscribe is decided by lib/form-schema.mjs, not here. On a
     nomination the submitter and the person described are two different
     people, and only the submitter consented to anything. */
  const person = valid.subscriber;
  if (!person) return;

  const at = new Date().toISOString();
  const subscriber = resolveSubscriber(valid.kind);
  if (!subscriber) {
    console.error(
      'Subscribe requested but no contact list is configured; add this person by hand',
      JSON.stringify({ kind: valid.kind, email: person.email, at })
    );
    return;
  }

  try {
    const result = await subscriber.subscribe(person);
    if (!result.attributed) {
      /* On the list, but under no name: the account's name attributes are not
         the ones lib/brevo-contacts.mjs sends. Worth fixing once, and not
         worth failing anyone's submission over. */
      console.warn(
        'Subscribed without name attributes; check the list\'s attribute names',
        JSON.stringify({ email: person.email, at })
      );
    }
  } catch (error) {
    console.error(
      'Subscribe failed; add this person to the list by hand',
      JSON.stringify({ kind: valid.kind, email: person.email, at, code: error.code })
    );
  }
}

/* Writes the submission to its review spreadsheet, where one is configured.
 *
 * Never throws, for the same reason subscribeIfAsked does not: the email has
 * already gone and carries every answer, so the sheet is a second copy. A
 * missing row can be restored from the inbox; a nominator told her nomination
 * failed, when it had not, cannot be, and she would simply submit again.
 *
 * The failure is logged with enough to find the email it belongs to and
 * re-enter it by hand. The answers themselves never go to the log.
 */
async function recordIfConfigured(valid) {
  const at = new Date().toISOString();
  try {
    /* Inside the try, not before it: this is the one line here that could
       throw without being caught, and an escape would reach the handler's
       catch and answer 502 for a submission already emailed. */
    const sheet = resolveSheet(valid.kind);
    if (!sheet) return;

    /* The RESOLVED consent, not the raw field: this endpoint is public, so a
       direct POST could carry subscribe: 'true', which validateSubmission
       correctly declines to treat as consent.

       It records what was ASKED, which is all this can honestly know -- the
       subscription may still have failed or been unconfigured, and
       subscribeIfAsked swallows both. The column is named "Nominator asked to
       subscribe" for that reason: a column promising they are on a list would
       be a false record for whoever later mails from it. */
    await sheet.append({ ...valid.fields, subscribe: valid.subscriber ? 'Yes' : 'No' }, at);
  } catch (error) {
    /* The message as well as the code: every message this path raises is
       deliberately sanitised, and an error from outside that set -- a socket
       failure, a response that was not JSON -- carries no code at all,
       leaving an operator with nothing to act on. */
    /* Guarded: a thrown null, string or undefined would make `error.code`
       throw a TypeError INSIDE this catch, which would escape, reach the
       handler's catch and answer 502 for a nomination already emailed --
       precisely the outcome this function exists to prevent. */
    console.error(
      'Submission was emailed but not written to the sheet; re-enter it by hand',
      JSON.stringify({
        kind: valid.kind, from: valid.replyTo, at,
        code: error && error.code, message: error && error.message
      })
    );
  }
}

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
    /* Deliberately inside the try and deliberately incapable of throwing: a
       list failure must not reach the catch below, which would tell someone
       their submission failed after the notification had already been sent. */
    await subscribeIfAsked(valid);
    await recordIfConfigured(valid);
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
