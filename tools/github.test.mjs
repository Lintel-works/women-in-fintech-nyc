import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitFiles, pathExists, commitWithRetry } from '../lib/github.mjs';

/* A scripted fetch: each call shifts the next canned response and records the
   request, so the test asserts the exact Git Data API sequence. */
function scriptedFetch(responses) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return {
      ok: next.status < 400,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body)
    };
  };
  impl.calls = calls;
  return impl;
}

test('a commit walks ref, commit, blob, tree, commit, ref', async () => {
  const fetchImpl = scriptedFetch([
    { status: 200, body: { object: { sha: 'HEADSHA' } } },          // get ref
    { status: 200, body: { tree: { sha: 'BASETREE' } } },           // get commit
    { status: 201, body: { sha: 'BLOB1' } },                        // create blob
    { status: 201, body: { sha: 'NEWTREE' } },                      // create tree
    { status: 201, body: { sha: 'NEWCOMMIT' } },                    // create commit
    { status: 200, body: { object: { sha: 'NEWCOMMIT' } } }         // update ref
  ]);

  const result = await commitFiles({
    token: 't', owner: 'o', repo: 'r', branch: 'main',
    message: 'Publish a post',
    author: { name: 'Jane', email: 'jane@example.com' },
    files: [{ path: 'src/posts/x.html', content: 'hello', encoding: 'utf-8' }],
    fetchImpl
  });

  assert.equal(result.sha, 'NEWCOMMIT');
  assert.equal(fetchImpl.calls.length, 6);
  assert.match(fetchImpl.calls[0].url, /git\/ref\/heads\/main$/);
  assert.equal(fetchImpl.calls[3].body.base_tree, 'BASETREE');
  assert.equal(fetchImpl.calls[4].body.parents[0], 'HEADSHA');
});

test('a deletion sends a null sha and creates no blob', async () => {
  const fetchImpl = scriptedFetch([
    { status: 200, body: { object: { sha: 'HEADSHA' } } },
    { status: 200, body: { tree: { sha: 'BASETREE' } } },
    { status: 201, body: { sha: 'NEWTREE' } },
    { status: 201, body: { sha: 'NEWCOMMIT' } },
    { status: 200, body: { object: { sha: 'NEWCOMMIT' } } }
  ]);
  await commitFiles({
    token: 't', owner: 'o', repo: 'r', branch: 'main', message: 'Unpublish',
    author: { name: 'Jane', email: 'jane@example.com' },
    files: [{ path: 'src/posts/x.html', delete: true }],
    fetchImpl
  });
  const treeCall = fetchImpl.calls.find((c) => c.url.endsWith('/git/trees'));
  assert.equal(treeCall.body.tree[0].sha, null);
  assert.ok(!fetchImpl.calls.some((c) => c.url.endsWith('/git/blobs')), 'a blob was created for a deletion');
});

test('a moved branch surfaces as stale_head', async () => {
  const fetchImpl = scriptedFetch([{ status: 409, body: { message: 'conflict' } }]);
  await assert.rejects(
    () => commitFiles({
      token: 't', owner: 'o', repo: 'r', branch: 'main', message: 'x',
      author: { name: 'J', email: 'j@example.com' }, files: [], fetchImpl
    }),
    (error) => error.code === 'stale_head'
  );
});

test('a rejected credential surfaces as auth', async () => {
  const fetchImpl = scriptedFetch([{ status: 401, body: { message: 'bad' } }]);
  await assert.rejects(
    () => commitFiles({
      token: 't', owner: 'o', repo: 'r', branch: 'main', message: 'x',
      author: { name: 'J', email: 'j@example.com' }, files: [], fetchImpl
    }),
    (error) => error.code === 'auth'
  );
});

test('the token never appears in a thrown message', async () => {
  const fetchImpl = scriptedFetch([{ status: 500, body: { message: 'boom' } }]);
  await assert.rejects(
    () => commitFiles({
      token: 'super-secret-token', owner: 'o', repo: 'r', branch: 'main', message: 'x',
      author: { name: 'J', email: 'j@example.com' }, files: [], fetchImpl
    }),
    (error) => !String(error.message).includes('super-secret-token')
  );
});

test('pathExists is false on 404 and true on 200', async () => {
  assert.equal(await pathExists({
    token: 't', owner: 'o', repo: 'r', branch: 'main', path: 'src/posts/x.html',
    fetchImpl: scriptedFetch([{ status: 404, body: {} }])
  }), false);
  assert.equal(await pathExists({
    token: 't', owner: 'o', repo: 'r', branch: 'main', path: 'src/posts/x.html',
    fetchImpl: scriptedFetch([{ status: 200, body: { sha: 'abc' } }])
  }), true);
});

test('a stale head is retried once and then succeeds', async () => {
  const ok = [
    { status: 200, body: { object: { sha: 'HEAD2' } } },
    { status: 200, body: { tree: { sha: 'TREE2' } } },
    { status: 201, body: { sha: 'BLOB' } },
    { status: 201, body: { sha: 'TREE3' } },
    { status: 201, body: { sha: 'COMMIT2' } },
    { status: 200, body: { object: { sha: 'COMMIT2' } } }
  ];
  const fetchImpl = scriptedFetch([{ status: 409, body: {} }, ...ok]);
  const result = await commitWithRetry({
    token: 't', owner: 'o', repo: 'r', branch: 'main', message: 'x',
    author: { name: 'J', email: 'j@example.com' },
    files: [{ path: 'src/posts/x.html', content: 'hi', encoding: 'utf-8' }],
    fetchImpl
  });
  assert.equal(result.sha, 'COMMIT2');
});

test('a second stale head gives up rather than looping', async () => {
  const fetchImpl = scriptedFetch([{ status: 409, body: {} }, { status: 409, body: {} }]);
  await assert.rejects(
    () => commitWithRetry({
      token: 't', owner: 'o', repo: 'r', branch: 'main', message: 'x',
      author: { name: 'J', email: 'j@example.com' }, files: [], fetchImpl
    }),
    (error) => error.code === 'stale_head'
  );
});
