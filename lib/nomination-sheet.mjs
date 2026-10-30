/* Appends a public form submission to its tab of the review spreadsheet.
 *
 * Why a sheet at all: a submission arrives as an email, which is right for one
 * and wrong for fifty. The judging panel compares nominations across six
 * categories, and an inbox cannot be sorted, filtered or scored. The sheet is
 * the shape that work actually takes.
 *
 * The email is still sent and still carries every answer, so a failure here is
 * logged and swallowed rather than failing the submission: telling someone her
 * submission failed, when it did not, makes her send it twice.
 *
 * That the email is a SECOND copy and not a reliable one was proved between 23
 * and 30 October 2026, when every notification to info@nycfintechwomen.com was
 * accepted by Brevo and then rejected by Google for failing authentication.
 * Nominations came through intact because of this file. Membership signups did
 * not have a tab, and twelve submissions were lost outright -- Brevo retains no
 * message body, so the undelivered email was the only copy and it was gone.
 * Membership was given a tab the same week, for that reason.
 *
 * Why an Apps Script web app rather than a Google service account: the script
 * is deployed from inside the spreadsheet in a few clicks and needs no Cloud
 * project, no service account and no private key held by this site. The cost
 * is that its URL is public, so the shared secret below is the real guard --
 * see docs/iff-nominations.gs, which is the script itself, kept in this
 * repository so it is versioned next to the code that calls it.
 *
 * Env:
 *   IFF_SHEET_WEBHOOK_URL - the deployed /exec URL of that script
 *   IFF_SHEET_SECRET      - must equal SECRET inside the script
 *
 * With either unset, nominations email as normal and no row is written,
 * reported by resolveSheet() returning null.
 */

/* One budget for the whole call. It runs AFTER the notification email has been
   sent, so it has to finish well inside the function's own duration limit (set
   for api/form.js in vercel.json). Overrunning would have the platform kill
   the invocation and return a 5xx the handler never sees -- telling a
   nominator her nomination failed when it had already been emailed, which is
   the exact outcome the swallow above exists to prevent.

   It must also be comfortably LONGER than the script's own LOCK_WAIT_MS
   (5s) plus its write. If this budget could expire while the script still
   held the lock, a row could be written successfully just after the caller
   gave up -- and the operator, reading the failure log, would re-enter by
   hand a nomination that is already in the sheet. */
const BUDGET_MS = 20000;

/* The column order, and the header row that describes it. These are one
   declaration on purpose: a column added to one and not the other would
   silently shift every later answer into the wrong column, and nothing would
   fail -- the panel would simply read the wrong things under the right
   headings.

   The header travels WITH every request. The script compares it to row 1 and
   refuses the write if they disagree, so a column inserted or reordered by
   hand in the live sheet is caught there rather than corrupting rows here.

   The three long-form questions keep the wording from the sheet's own
   "Questions" tab so the panel recognises them. */
const NOMINATION_COLUMNS = [
  ['Submitted', (f, at) => at],
  ['Nominator First Name', (f) => f.nominatorFirstName],
  ['Nominator Last Name', (f) => f.nominatorLastName],
  ['Nominator Email', (f) => f.nominatorEmail],
  ['Nominee First Name', (f) => f.nomineeFirstName],
  ['Nominee Last Name', (f) => f.nomineeLastName],
  ['Nominee Email', (f) => f.nomineeEmail],
  ['Category', (f) => f.category],
  ['Nominee Title', (f) => f.nomineeTitle],
  ['Nominee Company', (f) => f.nomineeCompany],
  ['Nominee LinkedIn', (f) => f.linkedin],
  ['Describe the Nominee in one sentence', (f) => f.oneLine],
  ["What is the nominee's professional impact to FinTech", (f) => f.impact],
  ['How is the Nominee supportive of women', (f) => f.supportsWomen],
  ['Nominator asked to subscribe', (f) => f.subscribe]
];

/* Membership signups, added after a week in which every notification email to
   info@nycfintechwomen.com was accepted by Brevo and then rejected by Google.
   Nominations lost nothing because of the tab above; membership had no second
   copy, and twelve people's answers were gone for good -- Brevo does not
   retain message bodies, so the undelivered email was the only record and it
   no longer existed. This is that second copy.

   `support` is a list, which rowFor joins; every other answer is a string. */
const MEMBERSHIP_COLUMNS = [
  ['Submitted', (f, at) => at],
  ['First Name', (f) => f.firstName],
  ['Last Name', (f) => f.lastName],
  ['Email', (f) => f.email],
  ['Job Title', (f) => f.jobTitle],
  ['Years of Experience', (f) => f.experience],
  ['Company', (f) => f.company],
  ['Company Type', (f) => f.companyType],
  ['Professional Status', (f) => f.status],
  ['Professional Role', (f) => f.role],
  ['City Events Wanted', (f) => f.city],
  ['Made a Hire Through NYCFW', (f) => f.madeHire],
  ['Found a Job Through NYCFW', (f) => f.foundJob],
  ['How They Heard About NYCFW', (f) => f.heardFrom],
  ['How We Can Support Them', (f) => f.support],
  ['Speaking Interest and Bio', (f) => f.speaking],
  ['Testimonial', (f) => f.testimonial],
  ['Comments', (f) => f.comments],
  ['Asked to subscribe', (f) => f.subscribe]
];

/* Which form writes which tab. A kind absent here writes nothing, so adding a
   form to the site cannot quietly start writing into someone's spreadsheet.

   Both tabs live in the same spreadsheet ("IFF 2026"), which is why one
   deployment and one secret serve both. */
const SHEETS = {
  nomination: { tab: 'IFF Nominations List', columns: NOMINATION_COLUMNS },
  membership: { tab: 'Membership Signups', columns: MEMBERSHIP_COLUMNS }
};

/* hasOwn, not SHEETS[name]: a plain object inherits from Object.prototype, so
   a kind of "toString" or "constructor" would otherwise find an inherited
   function, read as a configured sheet, and throw a TypeError with no `code`
   when its .columns came back undefined -- the one error shape api/form.js
   says it cannot act on. An unknown kind has to be null, whatever it is
   called. */
export function sheetFor(kind) {
  const name = String(kind || '').trim();
  return Object.hasOwn(SHEETS, name) ? SHEETS[name] : null;
}

/* Kept as the nomination header for the callers and tests that predate
   membership, so adding a second form did not change what either means. */
export const COLUMNS = NOMINATION_COLUMNS;
export const HEADER_ROW = NOMINATION_COLUMNS.map(([label]) => label);

export function headerFor(kind) {
  const spec = sheetFor(kind);
  return spec ? spec.columns.map(([label]) => label) : null;
}

/* A cell is always a string. An absent optional answer becomes '' rather than
   undefined, which JSON.stringify turns into null and the script would then
   write as the text "null".

   A list answer is joined rather than stringified: String(['a','b']) gives
   "a,b" with no space, and [] gives "", which reads as an unanswered question
   rather than an empty one. */
export function rowFor(fields, at, kind = 'nomination') {
  const spec = sheetFor(kind);
  if (!spec) throw fail(`No sheet is configured for ${JSON.stringify(kind)}`, 'config');
  return spec.columns.map(([, read]) => {
    const value = read(fields || {}, at);
    if (Array.isArray(value)) return value.join(', ');
    return value == null ? '' : String(value);
  });
}

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/* The script's own vocabulary, mapped to codes an operator can act on. Apps
   Script cannot set a status code -- ContentService always answers 200 -- so
   every outcome arrives in the body and a caller that trusted the status would
   read every failure as a success and lose rows silently. */
const ERRORS = {
  forbidden: ['The sheet script rejected the secret', 'auth'],
  header_mismatch: ['The sheet\'s columns are not the ones being sent; a row would land in the wrong ones', 'header'],
  no_such_tab: ['The script cannot find its tab in the spreadsheet', 'not_found'],
  tab_not_allowed: ['The sheet script refuses to write that tab; add it to TABS in the script and redeploy', 'config'],
  no_access: ['The script cannot open the spreadsheet; check SHEET_ID and that the deploying account has edit access', 'config'],
  busy: ['The sheet was locked by another write', 'busy'],
  bad_json: ['The script could not read the request', 'upstream'],
  bad_shape: ['The script rejected the row shape', 'upstream'],
  empty_request: ['The script received an empty request', 'upstream'],
  post_only: ['IFF_SHEET_WEBHOOK_URL is not a deployed web app URL', 'config'],
  misconfigured: ['The sheet script still has its placeholder secret; set SECRET and redeploy it', 'config'],
  script_error: ['The sheet script threw', 'upstream']
};

/* The script says more than which case it hit -- script_error carries the
   exception text, header_mismatch says which column disagreed and what it
   found. Dropping that detail leaves an operator with a category and nothing
   to act on, which is what this logging exists to avoid. */
function detail(body) {
  const parts = [];
  if (body.message) parts.push(String(body.message));
  if (body.tab) parts.push(`tab ${JSON.stringify(String(body.tab))}`);
  if (body.column) {
    parts.push(`column ${body.column}: expected ${JSON.stringify(String(body.expected))}, found ${JSON.stringify(String(body.found))}`);
  }
  return parts.length ? ` (${parts.join('; ')})` : '';
}

export function sheetRecorder(env, fetchImpl = fetch, kind = 'nomination') {
  const url = String(env.IFF_SHEET_WEBHOOK_URL || '').trim();
  const secret = String(env.IFF_SHEET_SECRET || '').trim();
  const spec = sheetFor(kind);
  if (!spec) throw fail(`No sheet is configured for ${JSON.stringify(kind)}`, 'config');
  const header = spec.columns.map(([label]) => label);

  return {
    name: 'apps-script',
    kind,
    tab: spec.tab,
    async append(fields, at = new Date().toISOString(), signal = AbortSignal.timeout(BUDGET_MS)) {
      /* The shared secret is about to be posted to this URL, so check where
         it is going first. A value typo'd to http:// would send it in
         cleartext, and a wrong host would simply be given it. */
      let parsed;
      try {
        parsed = new URL(url);
      } catch (error) {
        throw fail('IFF_SHEET_WEBHOOK_URL is not a URL', 'config');
      }
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'script.google.com') {
        throw fail('IFF_SHEET_WEBHOOK_URL must be an https script.google.com address', 'config');
      }

      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          /* text/plain, not application/json, on purpose: anything else makes
             this a CORS preflight, and Apps Script answers the preflight in a
             way that drops the body. The script parses e.postData.contents
             itself, so the declared type does not matter to it. */
          headers: { 'content-type': 'text/plain;charset=utf-8' },
          /* The tab travels with the request so one deployment serves both
             forms. A script deployed BEFORE this change ignores it and writes
             to the nominations tab -- but it also compares the header it was
             sent against row 1 there, finds the membership columns disagree,
             and refuses with header_mismatch. So forgetting to redeploy costs
             a membership row, never a corrupted nominations tab. */
          body: JSON.stringify({ secret, tab: spec.tab, header, row: rowFor(fields, at, kind) }),
          signal,
          /* Apps Script answers a 302 to a googleusercontent.com host that
             carries the actual body. Node follows it by default; naming it
             here so a later change does not quietly turn every write into an
             unparseable redirect. */
          redirect: 'follow'
        });
      } catch (error) {
        if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
          throw fail('The sheet script did not answer in time', 'timeout');
        }
        /* Never rethrown raw. A malformed URL makes undici throw a message
           quoting it, and the webhook URL is -- with the secret -- one of the
           two things standing between a stranger and this spreadsheet. It
           must not reach a log the whole team reads. The original is kept on
           `cause` for a debugger, not for the log line. */
        const wrapped = fail('Could not reach the sheet script', 'network');
        wrapped.cause = error;
        throw wrapped;
      }

      /* A non-2xx from Apps Script is the deployment, not the data: most often
         the URL is wrong, or the deployment is not set to "Anyone". */
      if (!response.ok) {
        throw fail(`The sheet script returned ${response.status}`, 'upstream');
      }

      let body;
      try {
        body = await response.json();
      } catch (error) {
        /* Google serves an HTML sign-in page when the deployment's access is
           not "Anyone" -- a 200 that is not JSON, and the likeliest setup
           mistake after the secret. */
        throw fail('The sheet script answered with a page, not JSON — check the deployment is set to "Anyone"', 'config');
      }

      if (!body || body.ok !== true) {
        const [message, code] = ERRORS[body && body.error] || [
          `The sheet script refused the row (${body && body.error})`, 'upstream'
        ];
        throw fail(message + detail(body || {}), code);
      }
      return { row: body.row };
    }
  };
}

/* Returns null when recording is not configured for this form, so the caller
   can say so in one log line rather than treat it as an outage. */
export function resolveSheet(kind, env = process.env, fetchImpl = fetch) {
  const name = String(kind || '').trim();
  if (!sheetFor(name)) return null;
  if (!String(env.IFF_SHEET_WEBHOOK_URL || '').trim()) return null;
  if (!String(env.IFF_SHEET_SECRET || '').trim()) return null;
  return sheetRecorder(env, fetchImpl, name);
}
