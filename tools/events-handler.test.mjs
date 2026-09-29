import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeManualEvents } from '../lib/manual-events.mjs';

/* api/events.js merges the Luma calendar with src/_data/manual-events.json.
   The two halves are unit-tested in tools/manual-events.test.mjs; what this
   covers is the wiring -- that manual events reach the response at all, that
   they survive a Luma outage (the reason they are merged on the server rather
   than in the page), and that the "Luma changed shape" alarm is still
   measured on Luma's own events rather than being silenced by them.
 *
 * This is the only test file that touches src/_data/manual-events.json, and
 * node:test runs the tests within a file one at a time, so the fixture below
 * is never visible to anything else. lib/manual-events.mjs reads that file on
 * each call rather than importing it, which is what makes this possible: an
 * imported JSON module is cached for the life of the process, so the first
 * read would win for ever and the handler could not be tested at all. */

const DATA = new URL('../src/_data/manual-events.json', import.meta.url);
const ORIGINAL = fs.readFileSync(DATA, 'utf8');

/* Last resort. The finally in withManual() is what runs in practice; this
   covers the file being left modified by a crash inside that window. */
process.on('exit', () => {
  try {
    if (fs.readFileSync(DATA, 'utf8') !== ORIGINAL) fs.writeFileSync(DATA, ORIGINAL);
  } catch { /* nothing useful to do while exiting */ }
});

/* Far enough out that they never expire, and listed out of order so the
   merge has something real to sort. */
const FIXTURE = [
  { name: 'Manual later', startAt: '2030-08-01T18:00:00Z', url: 'https://example.com/b', city: 'sf' },
  { name: 'Manual sooner', startAt: '2030-06-01T18:00:00Z', url: 'https://example.com/a', city: 'nyc' }
];

async function withManual(entries, fn) {
  fs.writeFileSync(DATA, JSON.stringify(entries, null, 2) + '\n');
  try {
    return await fn();
  } finally {
    fs.writeFileSync(DATA, ORIGINAL);
  }
}

function res() {
  const r = { code: null, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  return r;
}

const lumaEntry = (id, startAt) => ({
  id,
  name: 'Luma ' + id,
  start_at: startAt,
  url: id,
  timezone: 'America/New_York'
});

/* A fresh module instance per call so process.env changes take effect, the
   way tools/form-handler.test.mjs does it. */
let n = 0;
async function run({ key = 'test-key', fetchImpl, method = 'GET' } = {}) {
  n += 1;
  if (key) process.env.LUMA_API_KEY = key;
  else delete process.env.LUMA_API_KEY;

  globalThis.fetch = fetchImpl || (async () => ({
    ok: true, status: 200, json: async () => ({ entries: [] })
  }));

  const url = new URL('../api/events.js', import.meta.url).href + '?i=' + n;
  const { default: handler } = await import(url);
  const r = res();
  await handler({ method }, r);
  return r;
}

const ok = (entries) => async () => ({ ok: true, status: 200, json: async () => ({ entries }) });
const down = async () => ({ ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) });
const timeout = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
const brokenShape = ok([{ id: 'x', name: 'No date', url: 'x' }]);

test('every entry in the committed file is usable', () => {
  /* The file ships empty, but once events are added a typo in one of them
     should fail here rather than quietly vanish from the calendar. */
  for (const event of normalizeManualEvents(JSON.parse(ORIGINAL))) {
    assert.ok(event.name, 'an event in the committed file has no name');
    assert.match(event.url, /^https:\/\//);
    assert.match(event.id, /^manual-/);
  }
});

test('manual events are merged into the Luma list in date order', async () => {
  await withManual(FIXTURE, async () => {
    const r = await run({ fetchImpl: ok([lumaEntry('luma1', '2030-07-01T18:00:00Z')]) });
    assert.equal(r.code, 200);
    assert.deepEqual(r.body.events.map((e) => e.name), ['Manual sooner', 'Luma luma1', 'Manual later']);
  });
});

test('a manual event carries the city chip it was given', async () => {
  /* The chapter pages filter this same payload by city, which is the whole
     reason the merge happens on the server. */
  await withManual(FIXTURE, async () => {
    const r = await run({ fetchImpl: ok([]) });
    assert.deepEqual(r.body.events.map((e) => e.city).sort(), ['nyc', 'sf']);
  });
});

test('manual events still ship when Luma is not configured at all', async () => {
  await withManual(FIXTURE, async () => {
    const r = await run({ key: '', fetchImpl: ok([]) });
    assert.equal(r.code, 200);
    assert.equal(r.body.source, 'manual');
    assert.equal(r.body.events.length, 2);
  });
});

test('manual events survive every way Luma can fail', async () => {
  /* src/luma-events.js keeps its built-in cards on any non-200, and those
     cards are invented placeholders -- so a real committed event must never
     be traded for them, whichever way the upstream breaks. */
  await withManual(FIXTURE, async () => {
    for (const [what, fetchImpl] of [['outage', down], ['timeout', timeout], ['shape change', brokenShape]]) {
      const r = await run({ fetchImpl });
      assert.equal(r.code, 200, `expected manual events to ship on a Luma ${what}`);
      assert.equal(r.body.degraded, true, `expected degraded:true on a Luma ${what}`);
      assert.equal(r.body.events.length, 2);
    }
  });
});

test('with nothing to fall back on, a failure is reported honestly', async () => {
  const cases = [
    [down, 502, 'upstream_error'],
    [timeout, 504, 'upstream_timeout'],
    [brokenShape, 502, 'unrecognized_response']
  ];
  for (const [fetchImpl, code, error] of cases) {
    const r = await run({ fetchImpl });
    assert.equal(r.code, code);
    assert.equal(r.body.error, error);
  }
});

test('with no key and nothing to serve, the page is told the integration is off', async () => {
  const r = await run({ key: '', fetchImpl: ok([]) });
  assert.equal(r.code, 503);
  assert.equal(r.body.error, 'not_configured');
});

test('a failure is never cached at the edge', async () => {
  /* The CDN would otherwise serve the failure for five minutes, and keep
     serving it stale for thirty more, long after Luma had recovered. */
  for (const fetchImpl of [down, timeout, brokenShape]) {
    const r = await run({ fetchImpl });
    assert.ok(r.code >= 500, `expected a failure status, got ${r.code}`);
    assert.equal(r.headers['cache-control'], undefined, `a ${r.code} must not be cached`);
  }
});

test('a successful response is cached at the edge', async () => {
  const r = await run({ fetchImpl: ok([lumaEntry('a', '2030-07-01T18:00:00Z')]) });
  assert.match(r.headers['cache-control'] || '', /s-maxage=300/);
});

test('an empty calendar is an empty calendar, not an error', async () => {
  const r = await run({ fetchImpl: ok([]) });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.events, []);
});

test('only GET is allowed', async () => {
  const r = await run({ method: 'POST', fetchImpl: ok([]) });
  assert.equal(r.code, 405);
});

test('the committed manual events file was left exactly as it was found', () => {
  assert.equal(fs.readFileSync(DATA, 'utf8'), ORIGINAL);
});
