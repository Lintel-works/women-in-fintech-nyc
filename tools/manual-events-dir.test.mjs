import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadManualEvents } from '../lib/manual-events.mjs';

/* One file per event, because one shared array loses events: two authors each
   append to the array they read, the second commit lands on a moved branch,
   and commitWithRetry replays the same stale content -- dropping the first
   author's event with no error anywhere. Two paths cannot collide that way.
   See the spec's "Why one file per event".

   The guarantee this file exists to hold: one bad file costs that one event,
   never the calendar. */

const NOW = new Date('2026-06-01T12:00:00Z');
const future = '2026-07-01T18:00:00Z';

function quiet(fn) {
  const warn = console.warn;
  const error = console.error;
  const messages = [];
  console.warn = (...args) => messages.push(args.join(' '));
  console.error = (...args) => messages.push(args.join(' '));
  try {
    return { result: fn(), messages };
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

function dirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-events-'));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name),
      typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  /* A trailing slash: the reader resolves each filename against this with
     new URL(), which drops the last segment without one. */
  return pathToFileURL(dir + path.sep);
}

const event = (name) => ({ name, startAt: future, url: 'https://example.com/rsvp' });

test('every json file in the directory becomes an event', () => {
  const dir = dirWith({
    'a-mixer.json': event('A Mixer'),
    'b-panel.json': event('B Panel')
  });
  const events = loadManualEvents(NOW, dir);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.name).sort(), ['A Mixer', 'B Panel']);
});

test('a missing directory is no manual events, not an error', () => {
  const { result } = quiet(() =>
    loadManualEvents(NOW, pathToFileURL(path.join(os.tmpdir(), 'not-here-at-all') + path.sep)));
  assert.deepEqual(result, []);
});

test('an unparseable file is skipped by name and the rest still ship', () => {
  const dir = dirWith({
    'good.json': event('Good One'),
    'broken.json': '{ not json at all'
  });
  const { result, messages } = quiet(() => loadManualEvents(NOW, dir));
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Good One');
  assert.ok(messages.some((m) => m.includes('broken.json')),
    'the warning must name the file, not a position');
});

/* Review Focus 4: valid JSON that is not an event. */
test('a file holding something that is not an object is skipped by name', () => {
  const dir = dirWith({
    'good.json': event('Good One'),
    'null.json': 'null',
    'array.json': '[{"name":"Hand-written array"}]',
    'number.json': '42'
  });
  const { result, messages } = quiet(() => loadManualEvents(NOW, dir));
  assert.equal(result.length, 1);
  for (const name of ['null.json', 'array.json', 'number.json']) {
    assert.ok(messages.some((m) => m.includes(name)), `${name} should be named`);
  }
});

test('non-json files are ignored, not read', () => {
  const dir = dirWith({
    'good.json': event('Good One'),
    '.gitkeep': '',
    'README.md': '# not an event'
  });
  const { result } = quiet(() => loadManualEvents(NOW, dir));
  assert.equal(result.length, 1);
});

test('files are read in sorted order, so ids are reproducible', () => {
  /* Two events sharing a name fall back to position for their id. Sorted
     filenames make that position the same on every read; readdir order is not
     guaranteed to be. */
  const dir = dirWith({
    'z-second.json': event('Chapter Mixer'),
    'a-first.json': event('Chapter Mixer')
  });
  const first = loadManualEvents(NOW, dir).map((e) => e.id);
  const second = loadManualEvents(NOW, dir).map((e) => e.id);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, 2, 'ids must be distinct');
});

test('an expired event in a file is dropped without a warning', () => {
  const dir = dirWith({
    'past.json': { name: 'Last Year', startAt: '2020-01-01T00:00:00Z', url: 'https://example.com/x' },
    'future.json': event('Next Month')
  });
  const { result, messages } = quiet(() => loadManualEvents(NOW, dir));
  assert.equal(result.length, 1);
  assert.equal(messages.length, 0, 'an event being over is not a mistake');
});

test('MANUAL_EVENTS_DIR being set is warned about on every load', () => {
  const dir = dirWith({}).pathname;
  const previous = process.env.MANUAL_EVENTS_DIR;
  process.env.MANUAL_EVENTS_DIR = dir;
  try {
    const { messages } = quiet(() => loadManualEvents(NOW));
    assert.ok(messages.some((m) => m.includes('MANUAL_EVENTS_DIR is set')), messages.join('\n'));
  } finally {
    if (previous === undefined) delete process.env.MANUAL_EVENTS_DIR;
    else process.env.MANUAL_EVENTS_DIR = previous;
  }
});
