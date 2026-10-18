import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSheet, sheetRecorder, rowFor, COLUMNS, HEADER_ROW } from '../lib/nomination-sheet.mjs';

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

/* Adding a form to the site must not quietly start writing into a spreadsheet. */
test('only nominations are ever recorded', () => {
  for (const kind of ['membership', 'co-founder', 'whatever', '', null, undefined]) {
    assert.equal(resolveSheet(kind, ENV), null, String(kind));
  }
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
test('every cell is written as text, with the format set before the values', () => {
  const write = /function writeTextRow[\s\S]*?\n}/.exec(GS);
  assert.ok(write, 'writeTextRow must exist');
  const body = write[0];
  assert.match(body, /setNumberFormat\('@'\)/, 'the range must be forced to plain text');
  assert.ok(
    body.indexOf("setNumberFormat('@')") < body.indexOf('setValues'),
    'the format must be set BEFORE the values, or the formula is already evaluated'
  );
  assert.ok(!/appendRow/.test(GS), 'appendRow bypasses the text format');
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
