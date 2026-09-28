/* Writes one commit containing any number of files, via the Git Data API.
 *
 * Why not the simpler Contents API: it writes one file per call, so a post
 * plus its cover image would be two commits and two deploys. Building a tree
 * lets the post and the image land together, which is what an author means by
 * "publish".
 *
 * fetchImpl is injectable so the sequence can be tested without a network.
 * The real GitHub write is exercised against a scratch repository in Task 10.
 */
const API = 'https://api.github.com';

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function call(fetchImpl, token, path, options = {}) {
  const response = await fetchImpl(`${API}${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'nyc-fintech-women-admin',
      ...(options.headers || {})
    }
  });
  if (response.status === 401 || response.status === 403) {
    throw fail('GitHub rejected the credential', 'auth');
  }
  if (response.status === 409 || response.status === 422) {
    throw fail('The branch moved before this commit could be written', 'stale_head');
  }
  if (!response.ok) {
    throw fail(`GitHub returned ${response.status}`, 'github');
  }
  return response.json();
}

export async function commitFiles({ token, owner, repo, branch, message, author, files, fetchImpl = fetch }) {
  const base = `/repos/${owner}/${repo}`;
  const head = await call(fetchImpl, token, `${base}/git/ref/heads/${branch}`);
  if (typeof head?.object?.sha !== 'string') {
    throw fail('GitHub returned an unexpected response shape', 'github');
  }
  const headSha = head.object.sha;
  const headCommit = await call(fetchImpl, token, `${base}/git/commits/${headSha}`);
  if (typeof headCommit?.tree?.sha !== 'string') {
    throw fail('GitHub returned an unexpected response shape', 'github');
  }
  const baseTree = headCommit.tree.sha;

  const tree = [];
  for (const file of files) {
    if (file.delete) {
      // A null sha in a tree entry deletes the path.
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = await call(fetchImpl, token, `${base}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: file.content, encoding: file.encoding })
    });
    if (typeof blob?.sha !== 'string') {
      throw fail('GitHub returned an unexpected response shape', 'github');
    }
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await call(fetchImpl, token, `${base}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree })
  });
  if (typeof newTree?.sha !== 'string') {
    throw fail('GitHub returned an unexpected response shape', 'github');
  }

  const commit = await call(fetchImpl, token, `${base}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha], author })
  });
  if (typeof commit?.sha !== 'string') {
    throw fail('GitHub returned an unexpected response shape', 'github');
  }

  await call(fetchImpl, token, `${base}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false })
  });

  return { sha: commit.sha, url: `https://github.com/${owner}/${repo}/commit/${commit.sha}` };
}

/* Whether a path already exists on the branch. This is what makes "create"
   and "update" mean something: without it, a new post silently overwrites an
   existing one whose title happens to slugify the same way. Encode each path
   segment separately to handle special characters that break query strings. */
export async function pathExists({ token, owner, repo, branch, path, fetchImpl = fetch }) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`${API}/repos/${owner}/${repo}/contents/${encodedPath}`);
  url.searchParams.set('ref', branch);
  const response = await fetchImpl(String(url), {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'nyc-fintech-women-admin'
    }
  });
  if (response.status === 404) return false;
  if (response.status === 401 || response.status === 403) {
    throw fail('GitHub rejected the credential', 'auth');
  }
  if (!response.ok) throw fail(`GitHub returned ${response.status}`, 'github');
  return true;
}

/* The file's decoded text, or null if it does not exist. Reused by
   api/unpublish.js to answer two questions with one request: whether there
   is anything at this path to unpublish at all, and -- by parsing what comes
   back -- what the live post's own coverPath actually is, which the client's
   copy cannot be trusted for (an unsaved edit or a stale draft could differ
   from what was actually published). */
export async function getFileContent({ token, owner, repo, branch, path, fetchImpl = fetch }) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`${API}/repos/${owner}/${repo}/contents/${encodedPath}`);
  url.searchParams.set('ref', branch);
  const response = await fetchImpl(String(url), {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'nyc-fintech-women-admin'
    }
  });
  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403) {
    throw fail('GitHub rejected the credential', 'auth');
  }
  if (!response.ok) throw fail(`GitHub returned ${response.status}`, 'github');
  const json = await response.json();
  if (typeof json?.content !== 'string') {
    throw fail('GitHub returned an unexpected response shape', 'github');
  }
  // The Contents API wraps its base64 at 60 characters with embedded
  // newlines; Buffer.from ignores characters outside the base64 alphabet,
  // so this decodes correctly without stripping them first.
  return Buffer.from(json.content, 'base64').toString('utf8');
}

/* One retry, and only for a moved branch. Another author publishing at the
   same moment is the expected cause; commitFiles re-reads the head each time
   and never force-updates the ref, so retrying cannot clobber their commit. */
export async function commitWithRetry(options) {
  try {
    return await commitFiles(options);
  } catch (error) {
    if (error.code !== 'stale_head') throw error;
    return commitFiles(options);
  }
}
