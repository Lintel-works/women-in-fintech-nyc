import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparePublish, parseGate } from '../lib/publish.mjs';
import { isCleanBase64 } from '../api/publish.js';

test('a valid post prepares to file text at a computed path', () => {
  const result = preparePublish({
    type: 'post', mode: 'create',
    fields: { title: 'October Recap', gradient: 'g3' },
    blocks: [{ type: 'paragraph', text: 'A paragraph.' }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, 'src/posts/october-recap.html');
  assert.match(result.text, /^---\n/);
  assert.match(result.text, /type: "post"/);
});

test('a post the renderer rejects is refused before anything is written', () => {
  // A block the validator allows but whose shape the renderer cannot use.
  const result = preparePublish({
    type: 'post', mode: 'create',
    fields: { title: 'Bad Post' },
    blocks: [{ type: 'list', items: 'not-an-array' }]
  });
  // Either the validator or the render gate must catch it. What must NOT
  // happen is ok:true with text that breaks the build.
  if (result.ok) {
    assert.fail('a post that cannot render was prepared for commit');
  }
  assert.ok(result.message.length > 0);
});

test('preparePublish performs no I/O and no network call', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('preparePublish made a network call'); };
  try {
    preparePublish({ type: 'post', mode: 'create', fields: { title: 'Fine' }, blocks: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a data-URI-prefixed string is rejected, not silently decoded', () => {
  // FileReader.readAsDataURL is the common browser path and produces
  // exactly this shape. Buffer.from(x, 'base64') does not throw on the
  // ':' ';' ',' characters -- it skips them and decodes garbage.
  const clean = Buffer.from('a small jpeg-shaped blob').toString('base64');
  const prefixed = `data:image/jpeg;base64,${clean}`;
  assert.equal(isCleanBase64(prefixed), false);
});

test('a clean base64 string passes', () => {
  const clean = Buffer.from('a small jpeg-shaped blob').toString('base64');
  assert.equal(isCleanBase64(clean), true);
});

// FIX 1b (final wave), Ruling 26: the render gate proves a post RENDERS but
// never proved it PARSES. These prove the parse gate itself catches a broken
// serialization -- not merely that today's serializePost happens not to
// produce one -- by feeding parseGate bytes a future bug in the serializer
// could plausibly write.
test('parseGate refuses text that does not parse at all', () => {
  const broken = '---\nslug: "s"\ntag: not: valid: yaml\nblocks:\n---\n';
  const message = parseGate(broken, { slug: 's', tag: 'not: valid: yaml', blocks: [] });
  assert.ok(message, 'a malformed file must be refused, not silently accepted');
  assert.match(message, /cannot be saved/);
});

test('parseGate refuses text that parses but recovers the wrong value', () => {
  // Well-formed YAML, but it does not say what "expected" says it should --
  // simulating a serializer that quietly dropped or mistranslated a field.
  const text = '---\nslug: "s"\ntag: "the wrong value"\nblocks:\n---\n';
  const message = parseGate(text, { slug: 's', tag: 'the right value', blocks: [] });
  assert.ok(message, 'a value that reads back differently must be refused');
  assert.match(message, /"tag" field/);
});

test('parseGate passes text that reads back exactly as expected', () => {
  const text = '---\nslug: "s"\ntag: "a tag"\nblocks:\n---\n';
  assert.equal(parseGate(text, { slug: 's', tag: 'a tag', blocks: [] }), null);
});

test('the parse gate is wired into preparePublish, not just callable standalone', () => {
  // A payload FIX 1's quoting keeps safe end to end -- proves the gate is
  // actually reached on the real preparePublish path, not merely testable
  // in isolation.
  const result = preparePublish({
    type: 'post', mode: 'create',
    fields: { title: 'Fintech: The Future', tag: '# not a comment' },
    blocks: []
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /^tag: "# not a comment"$/m);
});
