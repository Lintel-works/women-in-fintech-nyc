import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparePublish } from '../lib/publish.mjs';

test('a valid post prepares to file text at a computed path', () => {
  const result = preparePublish({
    type: 'post', mode: 'create',
    fields: { title: 'October Recap', gradient: 'g3' },
    blocks: [{ type: 'paragraph', text: 'A paragraph.' }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, 'src/posts/october-recap.html');
  assert.match(result.text, /^---\n/);
  assert.match(result.text, /type: post/);
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
