/* Regression check: compare built pages against a git baseline.
 *
 *   node tools/snapshot.mjs                 # compare _site/ (or repo root) to tag
 *   node tools/snapshot.mjs --from _site    # explicit build dir
 *   node tools/snapshot.mjs --self-test     # prove the harness detects a change
 *
 * Baseline comes from `git show <tag>:<file>` so no duplicate copies are
 * committed. Exits non-zero on any difference.
 *
 * The default tag is a parentless commit holding just the built pages: they
 * are generated into _site/ now, which is gitignored, so there is no ordinary
 * commit to compare against. Re-baseline by tagging a new one -- see README.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalize } from './htmlcanon.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? fallback : args[i + 1];
};

const TAG = flag('tag', 'baseline-2026-10-05b');
const SELF_TEST = args.includes('--self-test');

function baselineFiles(tag) {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', tag], { encoding: 'utf8' });
  return out.split('\n').filter((f) => /^[^/]+\.html$/.test(f)).sort();
}

function baselineContent(tag, file) {
  return execFileSync('git', ['show', `${tag}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/* Prefer the build output when it exists; fall back to the working tree so the
   harness is runnable before a build step exists. */
function resolveFrom() {
  const explicit = flag('from', null);
  if (explicit) return explicit;
  return fs.existsSync('_site') ? '_site' : '.';
}

function compare(from, tag, mutate) {
  const files = baselineFiles(tag);
  let same = 0;
  const diffs = [];
  const missing = [];

  for (const file of files) {
    const current = path.join(from, file);
    if (!fs.existsSync(current)) { missing.push(file); continue; }

    let a = canonicalize(baselineContent(tag, file));
    let b = canonicalize(fs.readFileSync(current, 'utf8'));
    if (mutate) b = mutate(b, file);

    if (a === b) { same++; continue; }

    // Report the first differing line so the failure is actionable.
    const al = a.split('\n'), bl = b.split('\n');
    let line = 0;
    while (line < Math.max(al.length, bl.length) && al[line] === bl[line]) line++;
    diffs.push({
      file,
      line: line + 1,
      baseline: (al[line] || '(end of file)').slice(0, 160),
      current: (bl[line] || '(end of file)').slice(0, 160)
    });
  }

  return { files, same, diffs, missing };
}

const from = resolveFrom();
console.log(`baseline: ${TAG}\ncomparing: ${from}/\n`);

if (SELF_TEST) {
  // A harness that has never reported a difference is not a harness. Inject a
  // one-character change into one page and require it to be caught.
  let injected = false;
  const result = compare(from, TAG, (html, file) => {
    if (!injected && file === 'events.html') { injected = true; return html.replace('Events', 'Evemts'); }
    return html;
  });
  const caught = result.diffs.some((d) => d.file === 'events.html');
  console.log(caught
    ? 'SELF-TEST PASS — a single injected character was detected in events.html'
    : 'SELF-TEST FAIL — the harness did not notice an injected change');
  process.exit(caught ? 0 : 1);
}

const { files, same, diffs, missing } = compare(from, TAG);

for (const d of diffs) {
  console.log(`DIFF  ${d.file}  (first difference at canonical line ${d.line})`);
  console.log(`  baseline: ${d.baseline}`);
  console.log(`  current : ${d.current}\n`);
}
for (const f of missing) console.log(`MISSING  ${f} — not found in ${from}/`);

console.log(`${same}/${files.length} identical, ${diffs.length} changed, ${missing.length} missing`);
process.exit(diffs.length || missing.length ? 1 : 0);
