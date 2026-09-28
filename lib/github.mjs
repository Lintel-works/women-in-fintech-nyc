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
  const headSha = head.object.sha;
  const headCommit = await call(fetchImpl, token, `${base}/git/commits/${headSha}`);
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
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await call(fetchImpl, token, `${base}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree })
  });

  const commit = await call(fetchImpl, token, `${base}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha], author })
  });

  await call(fetchImpl, token, `${base}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false })
  });

  return { sha: commit.sha, url: `https://github.com/${owner}/${repo}/commit/${commit.sha}` };
}

/* Whether a path already exists on the branch. This is what makes "create"
   and "update" mean something: without it, a new post silently overwrites an
   existing one whose title happens to slugify the same way. */
export async function pathExists({ token, owner, repo, branch, path, fetchImpl = fetch }) {
  const response = await fetchImpl(
    `${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'nyc-fintech-women-admin'
      }
    }
  );
  if (response.status === 404) return false;
  if (response.status === 401 || response.status === 403) {
    throw fail('GitHub rejected the credential', 'auth');
  }
  if (!response.ok) throw fail(`GitHub returned ${response.status}`, 'github');
  return true;
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
