import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readTitle } from './fff-manifest.mjs';
import { slugify } from '../lib/slug.mjs';

/* The Wix titles are the only place a profile's name, role and company are
   recorded, and they are not one shape -- the name leads in some and trails in
   others, and "of" means an employer in "CEO of Frich" but not in "Head of
   Underwriting Solutions". readTitle() has to tell those apart, because a
   wrong answer puts an invented name or a non-existent employer on a live
   page. Each case below is a real title from the archive. */

const cases = [
  {
    why: 'name first, employer after "at"',
    title: 'FinTech Female Fridays: Meet Ali Faivus, VP of Revenue at Turnkey',
    name: 'Ali Faivus',
    role: 'VP of Revenue',
    company: 'Turnkey'
  },
  {
    why: 'role first, name after the comma',
    title: 'FinTech Female Fridays: Meet Chief Revenue Officer at Pinwheel, Lauren Crossett',
    name: 'Lauren Crossett',
    role: 'Chief Revenue Officer',
    company: 'Pinwheel'
  },
  {
    why: '"of" after an ownership title names the company',
    title: 'FinTech Female Fridays: Meet Kim Snyder, CEO of KlariVis',
    name: 'Kim Snyder',
    role: 'CEO',
    company: 'KlariVis'
  },
  {
    why: '"of" after "Head" completes the role and names no company',
    title: 'FinTech Female Fridays: Meet Head of Underwriting Solutions, Laura McKiernan Boylan',
    name: 'Laura McKiernan Boylan',
    role: 'Head of Underwriting Solutions',
    company: ''
  },
  {
    why: 'role first with no comma at all',
    title: 'FinTech Female Fridays: Meet Head of Solutions Jane Tran',
    name: 'Jane Tran',
    role: 'Head of Solutions',
    company: ''
  },
  {
    why: 'a bare name carries no role',
    title: 'FinTech Female Fridays: Meet Shira Amrany',
    name: 'Shira Amrany',
    role: '',
    company: ''
  },
  {
    why: 'the article belongs to the sentence, not the job',
    title: 'FinTech Female Fridays: Meet the General Counsel at Climb Credit, Alecia Chen',
    name: 'Alecia Chen',
    role: 'General Counsel',
    company: 'Climb Credit'
  },
  {
    why: 'an older title with no "Meet" still reads name-first',
    title: 'FinTech Female Fridays: Nikki Cross, Director of Data Science, Mission Lane',
    name: 'Nikki Cross',
    role: 'Director of Data Science',
    company: 'Mission Lane'
  }
];

for (const c of cases) {
  test(`readTitle: ${c.why}`, () => {
    const got = readTitle(c.title);
    assert.equal(got.name, c.name);
    assert.equal(got.role, c.role);
    assert.equal(got.company, c.company);
    assert.deepEqual(got.review, [], `expected no review flags, got ${got.review.join(',')}`);
  });
}

/* The other half of the job: saying so when it cannot tell. A silently wrong
   answer is the failure this whole manifest exists to prevent, so these titles
   must come back flagged rather than confidently misread. */
const flagged = [
  {
    why: 'a title listing three comma-separated facts is ambiguous',
    title: 'FinTech Female Fridays: Barbara Zhan, Vice President, Quantitative Research, Two Sigma',
    flag: 'role'
  },
  {
    why: 'a source title that stops mid-phrase cannot name an employer',
    title: 'FinTech Female Fridays: Meet Danita Harris, Managing Member, Director of Philanthropy at',
    flag: 'role'
  },
  {
    why: 'a post about a company is not a person',
    title: 'FinTech Female Fridays: Petal',
    flag: 'name'
  },
  {
    why: 'a name split away from its role is not a name',
    title: 'FinTech Female Fridays: Meet Team Lead, Account Management, Joanne Liu',
    flag: 'name'
  },
  {
    why: 'the series name must never be read as a person',
    title: 'FinTech Female Fridays, Meet Chief Marketing Officer, Karen Voci',
    flag: 'name'
  }
];

for (const c of flagged) {
  test(`readTitle flags for review: ${c.why}`, () => {
    const got = readTitle(c.title);
    assert.ok(
      got.review.includes(c.flag),
      `expected a "${c.flag}" flag for ${JSON.stringify(c.title)}, got [${got.review.join(',')}] ` +
        `with name="${got.name}" role="${got.role}" company="${got.company}"`
    );
  });
}

/* The committed manifest is what the importer actually reads, so its state is
   worth pinning directly: regenerating it after an archive change, or editing
   tools/fff-overrides.json, must not leave an unreviewed entry or two posts
   racing for one filename. */
const MANIFEST = path.join(import.meta.dirname, 'fff-manifest.json');

test('every manifest entry is settled and uniquely addressed', () => {
  const entries = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert.ok(entries.length > 0, 'the manifest is empty');

  const unreviewed = entries.filter((e) => e.review.length).map((e) => e.file);
  assert.deepEqual(unreviewed, [], `entries still needing review: ${unreviewed.join(', ')}`);

  for (const entry of entries) {
    assert.ok(entry.name.trim(), `${entry.file} has no name`);
    assert.ok(entry.slug.trim(), `${entry.file} has no slug`);
    assert.equal(entry.slug, slugify(entry.slug), `${entry.file} has a slug slugify would rewrite`);
  }

  const slugs = entries.map((e) => e.slug);
  const duplicates = slugs.filter((slug, i) => slugs.indexOf(slug) !== i);
  assert.deepEqual(duplicates, [], `two posts share a slug: ${duplicates.join(', ')}`);
});
