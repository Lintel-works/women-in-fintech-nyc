/* Derive tools/fff-manifest.json: one entry per archived Fintech Female
 * Fridays post, holding the fields tools/import-wix-post.mjs cannot read off
 * the page itself.
 *
 *   node tools/fff-manifest.mjs            rewrite the manifest
 *   node tools/fff-manifest.mjs --dry-run  print the summary, write nothing
 *
 * Why a manifest at all. The importer needs a name, a role and a company for
 * every post. The archive carries none of them as fields -- they exist only
 * inside the page title, and the titles are not one shape. Three are common:
 *
 *   FinTech Female Fridays: Meet Ali Faivus, VP of Revenue at Turnkey
 *   FinTech Female Fridays: Nikki Cross, Director of Data Science, Mission Lane
 *   FinTech Female Fridays: Meet Head of Solutions Jane Tran
 *
 * The third inverts the order and drops the comma, and about ninety posts are
 * written that way. No rule reads all three reliably, and a wrong guess puts
 * an invented name on a live page. So this tool derives what it can, states
 * how confident it is, and leaves the rest for a person: every entry carries a
 * `review` list naming what could not be settled mechanically. The file is
 * committed, so the human corrections are reviewable and the import stays
 * reproducible -- the same standard tools/import-wix-post.mjs already holds.
 *
 * This writes identity fields only. Prose (intro, excerpt, body) is derived at
 * import time from the archived page, so it is never restated here and cannot
 * drift from the source.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { slugify } from '../lib/slug.mjs';
import { decodeEntities, toSourceText } from './import-wix-post.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = flag('archive', path.join(os.homedir(), 'Desktop/Projects/wix-archive-nycfintechwomen'));
const DRY_RUN = process.argv.includes('--dry-run');
const MANIFEST = path.join(ROOT, 'tools/fff-manifest.json');
const OVERRIDES = path.join(ROOT, 'tools/fff-overrides.json');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/* The card gradients, cycled so neighbouring cards in the grid never repeat.
   src/posts/ already uses g1-g7 and the seven committed posts hold one each. */
export const GRADIENTS = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'];

/* Words that belong to a job title, not to a person. A candidate name holding
   any of these is a title fragment the split got wrong -- "Meet Head of
   Solutions Jane Tran" splits to "Head of Solutions Jane Tran" before this
   catches it. Lowercased on both sides, matched whole-word. */
const TITLE_WORDS = new Set([
  'ceo', 'cto', 'coo', 'cfo', 'cmo', 'cpo', 'cro', 'cio', 'evp', 'svp', 'vp',
  'avp', 'gp', 'md', 'founder', 'co-founder', 'cofounder', 'chair', 'chairman',
  'president', 'partner', 'principal', 'director', 'head', 'chief', 'officer',
  'manager', 'lead', 'investor', 'analyst', 'associate', 'counsel', 'engineer',
  'developer', 'strategist', 'advisor', 'adviser', 'consultant', 'executive',
  'specialist', 'architect', 'scientist', 'recruiter', 'attorney', 'student',
  'intern', 'board', 'member', 'team', 'committee', 'steering', 'senior',
  'junior', 'global', 'regional', 'general', 'managing', 'operating', 'venture',
  'product', 'marketing', 'sales', 'growth', 'revenue', 'payments', 'banking',
  'compliance', 'legal', 'risk', 'data', 'science', 'technology', 'engineering',
  'operations', 'strategy', 'business', 'development', 'partnerships', 'client',
  'customer', 'success', 'communications', 'content', 'design', 'research',
  'innovation', 'solutions', 'services', 'capital', 'ventures', 'fund', 'bank',
  'co-founders', 'founders', 'coach', 'account', 'accounts', 'underwriting',
  'abundance', 'advocacy', 'trading', 'budget', 'literacy', 'software',
  'blockchain', 'cloud', 'quantitative', 'enterprise', 'regulatory',
  /* The series name itself. Two posts are titled "FinTech Female Fridays:
     FinTech Female Fridays: ..." and one "FinTech Female Fridays: The NYC
     FinTech Women Team", so the words that name the series or the organisation
     must never be mistaken for a person. */
  'fintech', 'female', 'fridays', 'nyc', 'women',
  'of', 'at', 'and', 'the', 'for', 'to', 'in', 'on', 'a', 'an', '&'
]);

/* The titles that own a company, so "X of Y" names an employer. "CEO of Frich"
   does; "Head of Underwriting Solutions" and "Director of Data Science" do not
   -- there the "of" phrase completes the job, and splitting it invents an
   employer called "Underwriting Solutions". Seniority alone cannot tell them
   apart, which is why this is a list of the specific titles rather than a
   rule about capitalisation. */
const OWNS_COMPANY = /\b(ceo|cto|coo|cfo|cmo|cpo|cro|cio|founder|co-founder|cofounder|president|chair|chairman|owner|gp|md)$/i;

/* A person's name, as it appears in a title: two to four words, each opening
   with a capital, none of them a job-title word. Initials ("Anastasia S.
   Tarpeh-Ellis") and hyphenated surnames count as words. Two words is the
   floor because every single-word candidate in this archive turned out to be
   a company ("Petal", "MarketAxess") rather than a person. */
function looksLikeName(candidate) {
  const text = String(candidate || '').trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((word) => {
    const bare = word.replace(/[.,]/g, '').toLowerCase();
    if (!bare) return false;
    if (TITLE_WORDS.has(bare)) return false;
    return /^[A-Z]/.test(word);
  });
}

/* The title with the series prefix removed. One post predates the "FinTech"
   spelling and is titled "Female Fridays: ...", so both are stripped. */
function stripSeries(title) {
  return title.replace(/^\s*(fintech\s+)?female\s+fridays\s*:\s*/i, '').trim();
}

/* Split a role phrase into role and company. Wix wrote the join three ways --
   "VP of Revenue at Turnkey", "Co-Founder & CEO of Frich", "Director of Data
   Science, Mission Lane" -- and they disagree about which separator means
   "company". " at " always does. A comma does when one is present. " of " only
   does when it is the last one and nothing else split the phrase, because
   "Head of Legal" is a role in full and "of Frich" is a company. */
function splitRole(phrase) {
  /* "Meet the CEO at the Rudin Group" -- Wix wrote the article into a handful
     of titles, and it belongs to the sentence, not the job. */
  const text = String(phrase || '')
    .trim()
    .replace(/^the\s+/i, '')
    .replace(/\s+/g, ' ');
  if (!text) return { role: '', company: '', certain: true };

  /* " at " is unambiguous: nothing after it is ever part of the role. */
  const at = text.match(/^(.*?)\s+at\s+(.+)$/i);
  if (at) return { role: at[1].trim(), company: at[2].trim(), certain: true };

  /* " of " is decided before the comma, because "Director of Data Science,
     Mission Lane" has to keep "of Data Science" in the role and take the
     company from the comma. Only an ownership title splits here. */
  const of = text.match(/^(.*)\s+of\s+(.+)$/i);
  if (of && OWNS_COMPANY.test(of[1].trim())) {
    const role = of[1].trim();
    /* A role that still holds a comma came from a title naming two jobs
       ("CEO of Tal Solutions, LLC and Founder of PositivityTech"). The split
       is a guess at which employer is the current one. */
    return { role, company: of[2].trim(), certain: !role.includes(',') };
  }

  const comma = text.lastIndexOf(',');
  if (comma !== -1) {
    const role = text.slice(0, comma).trim();
    /* One comma separates a role from a company. Two or more means the title
       is a list, and which comma is the company boundary is a reading, not a
       rule -- "Vice President, Quantitative Research, Two Sigma" splits at the
       last, "Head of Accounts, Client Strategy, The Ricciardi Group" does too,
       but "Product Manager, Lukka, Inc." does not. */
    return { role, company: text.slice(comma + 1).trim(), certain: !role.includes(',') };
  }

  /* No separator at all -- "Executive Coach & Leadership Advisor". That is a
     role in full and the title simply names no company. */
  return { role: text, company: '', certain: true };
}

/* Name, role and company out of one title, with the reasons a person still
   has to look. Two orders appear: the name first and comma-separated, or the
   name last with the role ahead of it and no comma at all. */
/* A phrase left hanging on a joining word, which means the title it came from
   was cut off: one post is titled "... Managing Member, Director of Philanthropy
   at" and stops there. Nothing downstream can recover the missing half. */
function danglesOpen(text) {
  return /\b(at|of|and|for|the|&)$/i.test(String(text || '').trim()) || /,$/.test(String(text || '').trim());
}

export function readTitle(title) {
  const review = [];
  const rest = stripSeries(title);
  const afterMeet = rest.replace(/^meet\s+/i, '').trim();
  const hadMeet = afterMeet !== rest;

  const comma = afterMeet.indexOf(',');
  if (comma !== -1) {
    const before = afterMeet.slice(0, comma).trim();
    const after = afterMeet.slice(comma + 1).trim();

    /* The comma form runs both ways. "Ali Faivus, VP of Revenue at Turnkey"
       names the person first; "Chief Revenue Officer at Pinwheel, Lauren
       Crossett" names the role first. Which is which is settled by where the
       name-shaped half is, and only when exactly one half is name-shaped --
       if both look like names the title is genuinely ambiguous and a person
       has to read it. */
    const beforeIsName = looksLikeName(before);
    const afterIsName = looksLikeName(after);
    if (afterIsName && !beforeIsName) {
      const { role, company, certain } = splitRole(before);
      if (!certain || danglesOpen(role) || danglesOpen(company)) review.push('role');
      return { name: after, role, company, review };
    }

    const { role, company, certain } = splitRole(after);
    if (!beforeIsName) review.push('name');
    if (!certain || danglesOpen(role) || danglesOpen(company)) review.push('role');
    return { name: before, role, company, review };
  }

  /* No comma. Either the whole remainder is the name ("Meet Shira Amrany"),
     or the role runs ahead of it ("Meet Head of Solutions Jane Tran"). The
     trailing words are tried longest-first so "Laura McKiernan Boylan" wins
     over "McKiernan Boylan". */
  const words = afterMeet.split(/\s+/).filter(Boolean);
  for (let take = Math.min(4, words.length); take >= 2; take--) {
    const candidate = words.slice(words.length - take).join(' ');
    if (!looksLikeName(candidate)) continue;
    const lead = words.slice(0, words.length - take).join(' ');
    /* A bare "Meet Shira Amrany" carries no role at all. Anything ahead of the
       name is one, and splits the same way as any other role phrase. */
    const { role, company, certain } = lead
      ? splitRole(lead)
      : { role: '', company: '', certain: true };
    if (!certain || danglesOpen(role) || danglesOpen(company)) review.push('role');
    return { name: candidate, role, company, review };
  }

  /* Nothing name-shaped. These are the posts about a company or a group --
     "Petal", "Team DailyPay", "NYC FinTech Women Steering Committee" -- which
     are real posts in the category and still have to be imported. */
  review.push('name', 'role');
  return { name: afterMeet, role: '', company: '', review: [...new Set(review)] };
}

function meta(html, re) {
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* The New York date, which is the date the post went out. Matches the rule
   tools/import-wix-post.mjs applies to the same stamp -- see the comment
   there: datePublished is UTC and the posts publish in the evening, so the
   UTC date is a day ahead for every reader the site has. */
function newYorkDate(published) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
    .formatToParts(new Date(published))
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return {
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    displayDate: `${MONTHS[Number(parts.month) - 1]} ${Number(parts.day)}`
  };
}

export function readPost(file, html) {
  const title = toSourceText(meta(html, /<title>([^<]*)<\/title>/));
  const { name, role, company, review } = readTitle(title);
  const published = meta(html, /"datePublished":"([^"]+)"/);
  const { isoDate } = newYorkDate(published);
  return { file, title, name, role, company, isoDate, review: [...review] };
}

function main() {
  const dir = path.join(ARCHIVE, 'html/post');
  if (!fs.existsSync(dir)) {
    console.error(`No archive at ${dir}. Pass --archive <path>.`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => /female-fridays/i.test(f) && f.endsWith('.html'))
    .sort();

  const entries = files.map((file) => readPost(file, fs.readFileSync(path.join(dir, file), 'utf8')));

  /* The human half of the manifest. Twenty-seven titles cannot be read
     mechanically -- two people in one post, a name wrapped in a nickname, a
     source title that stops mid-phrase -- so a person settles those and the
     answer lives here, keyed by the archived filename. Applying it clears the
     entry's review flags: an override IS the review. Keeping the corrections
     in their own small file rather than hand-editing the generated manifest
     is what makes this tool safe to re-run, and it keeps the editorial
     decisions readable on their own instead of buried in 261 entries. */
  const overrides = fs.existsSync(OVERRIDES) ? JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')) : {};
  /* Keys opening with "_" are notes to the reader -- the file's own header and
     each entry's "_why" -- not filenames. */
  const unused = new Set(Object.keys(overrides).filter((key) => !key.startsWith('_')));
  for (const entry of entries) {
    const fix = overrides[entry.file];
    if (!fix) continue;
    unused.delete(entry.file);
    for (const key of ['name', 'role', 'company', 'slug']) {
      if (Object.hasOwn(fix, key)) entry[key] = fix[key];
    }
    /* Remembered so the collision pass below cannot quietly rewrite a slug a
       person chose deliberately. */
    if (Object.hasOwn(fix, 'slug')) entry.slugFromOverride = true;
    entry.review = [];
    entry.reviewed = true;
  }
  /* An override naming a file the archive no longer holds is a stale
     correction, and silently ignoring it would let the manifest drift. */
  for (const file of unused) console.warn(`  ! override for unknown file: ${file}`);

  /* Newest first, the order the listing page renders and the order the
     gradients cycle in, so the sequence on the page is the sequence here. */
  entries.sort((a, b) => (a.isoDate < b.isoDate ? 1 : a.isoDate > b.isoDate ? -1 : a.file < b.file ? -1 : 1));

  /* The slug is slugify(name), because that is what the editor and the publish
     endpoint both compute for a post typed by hand -- tools/slug.test.mjs
     round-trips every committed post through it. Two women in this archive
     were interviewed twice, so the same name yields the same filename and one
     post would overwrite the other. A repeat is suffixed with its year and
     flagged: which of the two keeps the bare slug is an editorial call. */
  /* Slugs, in two passes. A slug stated in tools/fff-overrides.json is an
     editorial decision and is reserved first, so a derived slug can never take
     it and the collision rule can never rewrite it. */
  const seen = new Map();
  for (const entry of entries) {
    if (!entry.slugFromOverride) continue;
    if (seen.has(entry.slug)) {
      console.warn(`  ! two overrides claim the slug "${entry.slug}": ${entry.file}`);
      entry.review.push('slug');
    }
    seen.set(entry.slug, 1);
  }

  for (const entry of entries) {
    if (entry.slugFromOverride) continue;
    const base = slugify(entry.name);
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    if (count === 1) {
      entry.slug = base;
      continue;
    }
    entry.slug = `${base}-${entry.isoDate.slice(0, 4)}`;
    /* Only an unreviewed collision needs a person: once an override has been
       written for this post, the year suffix is the decision that was made. */
    if (!entry.reviewed) entry.review.push('slug');
  }

  /* A working note, not part of the manifest's contract. */
  for (const entry of entries) delete entry.slugFromOverride;

  entries.forEach((entry, i) => {
    entry.gradient = GRADIENTS[i % GRADIENTS.length];
  });

  const needsReview = entries.filter((e) => e.review.length);
  const byReason = {};
  for (const entry of needsReview) {
    for (const reason of entry.review) byReason[reason] = (byReason[reason] || 0) + 1;
  }

  console.log(`${entries.length} posts, ${entries.length - needsReview.length} fully derived`);
  console.log(`needs review: ${needsReview.length}`);
  for (const [reason, n] of Object.entries(byReason).sort()) console.log(`  ${reason}: ${n}`);

  if (DRY_RUN) {
    console.log('\n--- sample of entries needing review:');
    for (const entry of needsReview.slice(0, 20)) {
      console.log(`  [${entry.review.join(',')}] ${entry.title}`);
      console.log(`      name="${entry.name}" role="${entry.role}" company="${entry.company}"`);
    }
    return;
  }

  fs.writeFileSync(MANIFEST, JSON.stringify(entries, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(ROOT, MANIFEST)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
