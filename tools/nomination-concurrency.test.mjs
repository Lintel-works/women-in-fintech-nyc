/* Concurrent nominations through the real handler.
 *
 * Why this suite exists separately from tools/nomination-sheet.test.mjs: that
 * one tests the recorder's logic one call at a time. This one runs many
 * submissions through api/form.js AT ONCE, against a SINGLE module instance,
 * because that is the shape production actually has -- Fluid Compute reuses a
 * warm instance across concurrent requests, so anything held at module scope
 * is shared between two strangers' nominations.
 *
 * What this suite CANNOT test: the Apps Script LockService lock, which is what
 * actually serialises two writes landing on the same row. That lives in
 * Google's runtime, reachable only by deploying. These tests prove the site
 * sends N independent, correctly-paired writes; they do not prove the sheet
 * interleaves them safely. Only a real concurrent run against the deployed
 * /exec URL shows that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetRecorder, HEADER_ROW } from '../lib/nomination-sheet.mjs';

const SHEET_URL = 'https://script.google.com/macros/s/AKfakeDeploymentId/exec';
const SECRET = 'f'.repeat(64);

const ENV = {
  FORM_FROM_EMAIL: 'site@nycfintechwomen.com',
  FORM_TO_EMAIL: 'team@nycfintechwomen.com',
  BREVO_API_KEY: 'test-key',
  BREVO_NOMINATION_LIST_ID: '4',
  IFF_SHEET_WEBHOOK_URL: SHEET_URL,
  IFF_SHEET_SECRET: SECRET
};

/* Every field distinct per submitter, so a row that mixes two people is
   visible rather than plausible. */
const nomination = (i) => ({
  kind: 'nomination',
  nominatorFirstName: `Nominator${i}`,
  nominatorLastName: `Surname${i}`,
  nominatorEmail: `nominator${i}@example.com`,
  nomineeFirstName: `Nominee${i}`,
  nomineeLastName: `Nominee-Surname${i}`,
  category: 'Leaders',
  oneLine: `One line for ${i}`,
  impact: `Impact of ${i}`,
  supportsWomen: `Supports women ${i}`,
  subscribe: 'Yes',
  elapsedMs: 9000
});

function res() {
  const r = { code: null, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  return r;
}

/* Routes the three upstreams the handler talks to, records every body, and
   counts how many requests were in flight at once -- without that count a
   "concurrency" test that happened to run serially would pass and prove
   nothing. The random yield shuffles completion order so a submission can
   finish out of the order it started. */
function harness({ sheet = () => ({ ok: true, row: 2 }) } = {}) {
  const calls = { email: [], contacts: [], sheet: [] };
  let inFlight = 0;
  calls.peakInFlight = 0;

  globalThis.fetch = async (url, options) => {
    inFlight += 1;
    calls.peakInFlight = Math.max(calls.peakInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 8));
      const body = JSON.parse(options.body);
      const target = String(url);

      if (target === SHEET_URL) {
        calls.sheet.push(body);
        const answer = sheet(body, calls.sheet.length);
        return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) };
      }
      if (target.endsWith('/v3/contacts')) {
        calls.contacts.push(body);
        return { ok: true, status: 201, json: async () => ({}), text: async () => '' };
      }
      calls.email.push(body);
      return { ok: true, status: 201, json: async () => ({ messageId: 'x' }), text: async () => '' };
    } finally {
      inFlight -= 1;
    }
  };
  return calls;
}

/* One instance, many requests -- see the header comment. */
Object.assign(process.env, ENV);
const handler = (await import('../api/form.js')).default;

async function fireAll(count) {
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const r = res();
      await handler({ method: 'POST', body: nomination(i), headers: {} }, r);
      return r;
    })
  );
}

/* console.error is the operator's worklist for a swallowed failure. Capturing
   it keeps the test output readable AND lets the failure cases assert that the
   line was actually written -- a silent swallow would be the real bug. */
function captureErrors() {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  return { lines, restore: () => { console.error = original; } };
}

const COUNT = 20;

test('twenty simultaneous nominations genuinely overlap', async () => {
  const calls = harness();
  await fireAll(COUNT);
  assert.ok(
    calls.peakInFlight > 1,
    `requests ran one at a time (peak ${calls.peakInFlight}); this suite would prove nothing`
  );
});

test('every simultaneous nomination is acknowledged', async () => {
  harness();
  const results = await fireAll(COUNT);
  for (const r of results) {
    assert.equal(r.code, 200);
    assert.deepEqual(r.body, { ok: true });
  }
});

test('each nomination writes exactly one row, and none is lost', async () => {
  const calls = harness();
  await fireAll(COUNT);
  assert.equal(calls.sheet.length, COUNT);
  const emails = calls.sheet.map((b) => b.row[3]);
  assert.equal(new Set(emails).size, COUNT, 'two writes carried the same nominator');
});

/* The failure this guards against is not a lost row but a plausible one: a row
   holding one woman's name against another woman's nominator. */
test('no row mixes two submitters under load', async () => {
  const calls = harness();
  await fireAll(COUNT);
  for (const body of calls.sheet) {
    const row = body.row;
    const i = row[3].match(/^nominator(\d+)@example\.com$/)[1];
    assert.equal(row[1], `Nominator${i}`, 'nominator first name belongs to another row');
    assert.equal(row[2], `Surname${i}`);
    assert.equal(row[4], `Nominee${i}`, 'nominee belongs to another row');
    assert.equal(row[5], `Nominee-Surname${i}`);
    assert.equal(row[11], `One line for ${i}`);
    assert.equal(row[12], `Impact of ${i}`);
    assert.equal(row[13], `Supports women ${i}`);
  }
});

test('each nomination sends exactly one email, naming its own nominee', async () => {
  const calls = harness();
  await fireAll(COUNT);
  assert.equal(calls.email.length, COUNT);
  const subjects = calls.email.map((b) => b.subject);
  assert.equal(new Set(subjects).size, COUNT, 'two submissions shared a subject');
  for (let i = 0; i < COUNT; i += 1) {
    assert.ok(
      subjects.includes(`IFF nomination — Nominee${i} Nominee-Surname${i}`),
      `no email for nominee ${i}`
    );
  }
});

test('each ticked box subscribes exactly its own nominator', async () => {
  const calls = harness();
  await fireAll(COUNT);
  assert.equal(calls.contacts.length, COUNT);
  const emails = calls.contacts.map((b) => b.email);
  assert.equal(new Set(emails).size, COUNT);
  for (const body of calls.contacts) {
    const i = body.email.match(/^nominator(\d+)@/)[1];
    assert.deepEqual(body.listIds, [4]);
    assert.equal(body.attributes.FIRSTNAME, `Nominator${i}`, 'subscribed under another person\'s name');
  }
});

test('the header and the secret travel with every concurrent write', async () => {
  const calls = harness();
  await fireAll(COUNT);
  for (const body of calls.sheet) {
    assert.deepEqual(body.header, HEADER_ROW);
    assert.equal(body.secret, SECRET);
    assert.equal(body.row.length, HEADER_ROW.length);
  }
});

/* The central invariant, under load: the email has already gone, so a sheet
   failure must never become a 5xx that makes a nominator submit again. */
test('every submitter is still acknowledged when every sheet write fails', async () => {
  const calls = harness({ sheet: () => ({ ok: false, error: 'script_error', message: 'boom' }) });
  const captured = captureErrors();
  try {
    const results = await fireAll(COUNT);
    for (const r of results) assert.equal(r.code, 200, 'a sheet failure reached the submitter');
    assert.equal(calls.email.length, COUNT, 'the email did not go');
    assert.equal(captured.lines.length, COUNT, 'a failure was swallowed without a log line');
  } finally {
    captured.restore();
  }
});

test('a lock contention answer is survived and logged, not returned', async () => {
  harness({ sheet: (body, n) => (n % 3 === 0 ? { ok: false, error: 'busy' } : { ok: true, row: n + 1 }) });
  const captured = captureErrors();
  try {
    const results = await fireAll(COUNT);
    for (const r of results) assert.equal(r.code, 200);
    const busy = captured.lines.filter((l) => l.includes('"code":"busy"'));
    assert.equal(busy.length, Math.floor(COUNT / 3));
    for (const line of busy) {
      assert.ok(line.includes('re-enter it by hand'), 'the log is not actionable');
    }
  } finally {
    captured.restore();
  }
});

test('one failing write does not disturb the other nineteen', async () => {
  const calls = harness({
    sheet: (body, n) => (n === 7 ? { ok: false, error: 'no_access' } : { ok: true, row: n + 1 })
  });
  const captured = captureErrors();
  try {
    const results = await fireAll(COUNT);
    for (const r of results) assert.equal(r.code, 200);
    assert.equal(calls.sheet.length, COUNT, 'a write was skipped after the failure');
    assert.equal(captured.lines.length, 1, 'the failure spread beyond its own request');
  } finally {
    captured.restore();
  }
});

/* The free text is the one thing that must never reach a log the whole team
   reads, and a burst is exactly when logging gets sloppy. */
test('no log line carries a nominee answer, however many fail', async () => {
  harness({ sheet: () => ({ ok: false, error: 'script_error', message: 'boom' }) });
  const captured = captureErrors();
  try {
    await fireAll(COUNT);
    const all = captured.lines.join('\n');
    for (let i = 0; i < COUNT; i += 1) {
      assert.ok(!all.includes(`Impact of ${i}`), 'an answer reached the log');
      assert.ok(!all.includes(`Nominee${i}`), 'a nominee name reached the log');
    }
    assert.ok(!all.includes(SECRET), 'the secret reached the log');
    assert.ok(!all.includes(SHEET_URL), 'the webhook URL reached the log');
  } finally {
    captured.restore();
  }
});

/* Directly on the recorder, away from the handler: fifty parallel appends on
   ONE recorder instance. If it ever gained a module- or closure-level buffer
   this is what would catch it. */
test('fifty parallel appends on one recorder stay independent', async () => {
  const seen = [];
  const recorder = sheetRecorder(ENV, async (url, options) => {
    const body = JSON.parse(options.body);
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
    seen.push(body.row);
    return { ok: true, status: 200, json: async () => ({ ok: true, row: seen.length + 1 }) };
  });

  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      recorder.append({ ...nomination(i), subscribe: 'Yes' }, `2026-10-18T00:00:${String(i).padStart(2, '0')}Z`)
    )
  );

  assert.equal(seen.length, 50);
  assert.equal(new Set(seen.map((r) => r[3])).size, 50);
  for (const row of seen) {
    const i = row[3].match(/^nominator(\d+)@/)[1];
    assert.equal(row[4], `Nominee${i}`);
    assert.equal(row[0], `2026-10-18T00:00:${String(i).padStart(2, '0')}Z`, 'the timestamp came from another append');
  }
});

/* A sheet that stops answering under load must abort on its own budget rather
   than hold the function open until the platform kills it -- that kill is a
   5xx the handler never sees, and the nominator is told she failed. */
test('a hung sheet aborts instead of hanging the submission', async () => {
  const recorder = sheetRecorder(ENV, (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    })
  );

  const started = Date.now();
  await assert.rejects(
    () => recorder.append(nomination(1), '2026-10-18T00:00:00Z', AbortSignal.timeout(80)),
    (error) => {
      assert.equal(error.code, 'timeout');
      assert.ok(!error.message.includes(SHEET_URL), 'the timeout message quoted the webhook URL');
      return true;
    }
  );
  assert.ok(Date.now() - started < 2000, 'the abort did not take effect');
});
