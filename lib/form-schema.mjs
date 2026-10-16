/* Validates a public form submission and renders it as the plain-text body of
 * a notification email.
 *
 * Why this is a separate, pure module: it does no I/O, so every rule below is
 * testable under node --test without a server or a provider, the same way
 * lib/publish-validate.mjs is. api/form.js asks it one question -- is this
 * submission acceptable, and what should the email say -- and knows nothing
 * about how it was validated.
 *
 * Why plain text and never HTML: a submission is untrusted input from the open
 * internet. Rendering it as HTML would mean escaping correctly in every field
 * forever; rendering it as text removes the whole injection category instead of
 * defending against it.
 */

/* Per-kind field definitions. `required` fields refuse an empty submission;
   `max` is a hard cap, not a hint -- anything longer is rejected rather than
   truncated, because silently sending half of someone's answer is worse than
   telling them it was too long. */
const TEXT = 'text';
const LIST = 'list';

export const FORM_KINDS = {
  'co-founder': {
    subject: 'Co-founder matching',
    fields: [
      { key: 'name', label: 'Name', type: TEXT, required: true, max: 120 },
      { key: 'email', label: 'Email', type: TEXT, required: true, max: 200, email: true },
      { key: 'role', label: 'Current role', type: TEXT, required: true, max: 160 },
      { key: 'chapter', label: 'Home chapter', type: TEXT, max: 60 },
      { key: 'vision', label: 'What they want to build', type: TEXT, required: true, max: 2000 },
      { key: 'skills', label: 'What they bring', type: LIST, max: 12, itemMax: 60 },
      { key: 'looking', label: 'Looking for in a partner', type: TEXT, required: true, max: 2000 },
      { key: 'stage', label: 'Stage', type: TEXT, max: 60 },
      { key: 'commitment', label: 'Commitment', type: TEXT, max: 60 }
    ]
  },
  membership: {
    subject: 'Membership',
    /* Two name fields rather than one, so the subject is built from both.
       The co-founder form has a single `name` and relies on the default. */
    subjectFields: ['firstName', 'lastName'],
    /* The submitter is the person being subscribed here, unlike `nomination`
       below where the two are different people. */
    subscriber: { email: 'email', firstName: 'firstName', lastName: 'lastName' },
    fields: [
      { key: 'firstName', label: 'First name', type: TEXT, required: true, max: 120 },
      { key: 'lastName', label: 'Last name', type: TEXT, required: true, max: 120 },
      { key: 'email', label: 'Email', type: TEXT, required: true, max: 200, email: true },
      { key: 'jobTitle', label: 'Job title', type: TEXT, max: 160 },
      { key: 'experience', label: 'Years of experience', type: TEXT, max: 60 },
      { key: 'company', label: 'Company', type: TEXT, max: 160 },
      { key: 'companyType', label: 'Company type', type: TEXT, max: 60 },
      { key: 'status', label: 'Professional status', type: TEXT, max: 80 },
      { key: 'role', label: 'Professional role', type: TEXT, max: 80 },
      { key: 'city', label: 'City events wanted', type: TEXT, max: 80 },
      { key: 'madeHire', label: 'Made a hire through NYCFW', type: TEXT, max: 120 },
      { key: 'foundJob', label: 'Found a job through NYCFW', type: TEXT, max: 120 },
      { key: 'heardFrom', label: 'How they heard about NYCFW', type: TEXT, max: 60 },
      { key: 'support', label: 'How we can support them', type: LIST, required: true, max: 12, itemMax: 60 },
      { key: 'speaking', label: 'Speaking interest and bio', type: TEXT, max: 2000 },
      { key: 'testimonial', label: 'Testimonial', type: TEXT, max: 2000 },
      { key: 'subscribe', label: 'Subscribed to communications', type: TEXT, max: 10 },
      { key: 'comments', label: 'Comments', type: TEXT, max: 2000 }
    ]
  },
  /* Inspiring FinTech Females nominations. The fields follow the "IFF 2026"
     sheet, with one deliberate addition: the sheet described only the nominee,
     and a form with no nominator would make `replyTo` the address of the woman
     being nominated -- so hitting Reply on a nomination would email her, before
     anyone had decided anything. The nominator is captured and is who the reply
     goes to.

     The nominee's own email is optional. Someone can reasonably know a woman's
     work well enough to nominate her without holding her private address, and
     refusing the nomination over it loses the nomination. */
  nomination: {
    subject: 'IFF nomination',
    subjectFields: ['nomineeFirstName', 'nomineeLastName'],
    /* Who the notification replies to, and who may be subscribed: the
       nominator, never the nominee. She has not filled anything in. */
    replyToField: 'nominatorEmail',
    subscriber: { email: 'nominatorEmail', firstName: 'nominatorFirstName', lastName: 'nominatorLastName' },
    fields: [
      { key: 'nominatorFirstName', label: 'Nominator first name', type: TEXT, required: true, max: 120 },
      { key: 'nominatorLastName', label: 'Nominator last name', type: TEXT, required: true, max: 120 },
      { key: 'nominatorEmail', label: 'Nominator email', type: TEXT, required: true, max: 200, email: true },
      { key: 'nomineeFirstName', label: 'Nominee first name', type: TEXT, required: true, max: 120 },
      { key: 'nomineeLastName', label: 'Nominee last name', type: TEXT, required: true, max: 120 },
      { key: 'nomineeEmail', label: 'Nominee email', type: TEXT, max: 200, email: true },
      { key: 'category', label: 'Category', type: TEXT, required: true, max: 60 },
      { key: 'nomineeTitle', label: 'Nominee title', type: TEXT, max: 160 },
      { key: 'nomineeCompany', label: 'Nominee company', type: TEXT, max: 160 },
      { key: 'impact', label: "Nominee's professional impact to fintech", type: TEXT, required: true, max: 2000 },
      { key: 'supportsWomen', label: 'How the nominee is supportive of women', type: TEXT, required: true, max: 2000 },
      { key: 'oneLine', label: 'The nominee in one sentence', type: TEXT, required: true, max: 300 },
      { key: 'linkedin', label: 'Nominee LinkedIn', type: TEXT, max: 300 },
      { key: 'subscribe', label: 'Nominator subscribed to communications', type: TEXT, max: 10 }
    ]
  }
};

/* Deliberately not the permissive RFC grammar. This is the same shape the
   co-founder page already validates against client-side, so the server does
   not reject something the form just told the author was fine. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* A newline in a value that reaches the Subject header is header injection.
   Body values keep their newlines -- a multi-line answer is the point of a
   textarea -- so this is applied only where it matters. */
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();

/* Built from char codes rather than written literally. A source file holding a
   raw U+2028 is itself a line terminator to a JS parser, so writing the class
   inline silently breaks this file -- which is exactly how it broke once. */
const CONTROL_CHARS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F' +
  String.fromCharCode(0x2028, 0x2029) + ']',
  'g'
);

function cleanText(value) {
  // Strip control characters except tab and newline, which are legitimate in a
  // textarea. U+2028/U+2029 go too: they are line terminators to a JS parser
  // but not to a text reader, and they have already caused one bug here.
  return String(value == null ? '' : value)
    .replace(CONTROL_CHARS, '')
    .trim();
}

/* Which field(s) name the submitter, for the Subject line. Defaults to `name`
   so the co-founder form is untouched. */
function subjectName(spec, fields) {
  return (spec.subjectFields || ['name']).map((k) => fields[k]).filter(Boolean).join(' ');
}

/* The person a form may subscribe, or null. Null covers three cases that the
   caller should treat identically: the form has no subscribe concept at all
   (co-founder), the box was not ticked, or the address is missing. Only the
   exact string "Yes" counts -- anything else is read as "not consented",
   because a mailing list is not somewhere to put someone on a guess. */
function subscriberOf(spec, fields) {
  if (!spec.subscriber || fields.subscribe !== 'Yes') return null;
  const email = fields[spec.subscriber.email];
  if (!email) return null;
  return {
    email,
    firstName: fields[spec.subscriber.firstName],
    lastName: fields[spec.subscriber.lastName]
  };
}

export function validateSubmission(kind, body) {
  const fail = (message) => ({ ok: false, message });
  const spec = FORM_KINDS[String(kind || '').trim()];
  if (!spec) return fail('That form is not one this site knows about.');
  if (!body || typeof body !== 'object') return fail('Nothing was sent.');

  const fields = {};
  for (const field of spec.fields) {
    const raw = body[field.key];

    if (field.type === LIST) {
      const list = Array.isArray(raw) ? raw : [];
      if (list.length > field.max) {
        return fail(`Choose no more than ${field.max} options for ${field.label.toLowerCase()}.`);
      }
      const items = list.map(cleanText).filter(Boolean);
      if (items.some((item) => item.length > field.itemMax)) {
        return fail(`One of your ${field.label.toLowerCase()} choices is too long.`);
      }
      if (field.required && !items.length) {
        return fail(`Choose at least one option for ${field.label.toLowerCase()}.`);
      }
      if (items.length) fields[field.key] = items;
      continue;
    }

    const value = cleanText(raw);
    if (!value) {
      if (field.required) return fail(`Add your ${field.label.toLowerCase()} — it is required.`);
      continue;
    }
    if (value.length > field.max) {
      return fail(`Your ${field.label.toLowerCase()} is too long — keep it under ${field.max} characters.`);
    }
    if (field.email && !EMAIL.test(value)) {
      return fail('That email address does not look right.');
    }
    fields[field.key] = value;
  }

  /* Unknown keys are DROPPED, not rejected. A field added to the page before
     it is added here should not 400 every submission in the meantime -- it
     should just not reach the email until someone wires it up. */
  return {
    ok: true,
    kind: String(kind).trim(),
    fields,
    subject: oneLine(`${spec.subject} — ${subjectName(spec, fields)}`).slice(0, 180),
    replyTo: fields[spec.replyToField || 'email'],
    /* Who, if anyone, this submission may put on a mailing list -- resolved
       here rather than in api/form.js so the handler never has to know that a
       nomination's submitter and its subject are two different people. Absent
       when the form has no subscribe field or the box was not ticked, which is
       what the handler checks. */
    subscriber: subscriberOf(spec, fields),
    text: renderText(kind, fields)
  };
}

export function renderText(kind, fields) {
  const spec = FORM_KINDS[String(kind || '').trim()];
  if (!spec) return '';
  const lines = [];
  for (const field of spec.fields) {
    const value = fields[field.key];
    if (value === undefined) continue;
    lines.push(field.label + ':');
    lines.push(Array.isArray(value) ? value.join(', ') : value);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}
