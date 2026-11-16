# FFF Pitch Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone put a woman forward for a Fintech Female Fridays feature, with the pitch reaching the team's inbox and a spreadsheet tab.

**Architecture:** A new `fff-pitch` kind in the existing public-form pipeline. `api/form.js` is untouched: it already validates by kind, emails, and records. The work is one schema entry, one sheet tab, one page built from `nominate.html`, and two links.

**Tech Stack:** Eleventy 3 (Nunjucks + plain HTML), ES modules on Node 22, `node --test`, Vercel serverless functions.

**Spec:** `docs/superpowers/specs/2026-11-15-fff-pitch-form-design.md`

## Global Constraints

- Reply-to is the **pitcher**, never the woman pitched (`replyToField: 'pitcherEmail'`).
- This kind has **no** `subscriber` key: it must never put anyone on a mailing list.
- Notification email is plain text only — never HTML.
- The page filename must not start with `fff-`: published posts occupy `fff-*.html` at the site root.
- ES modules, async/await, 2-space indent, comments that say WHY.
- A sheet failure must never fail a submission.

## Review Focus

These are implied by the spec but owned by no task's happy path. Each has its test added to the task that owns the code.

1. A pitch submitted with the "this is me" box ticked must still carry the pitcher's email as reply-to — Task 1.
2. A missing `nomineeEmail` must be accepted, not refused — it is optional on purpose — Task 1.
3. An over-long `why` must be refused with a readable message, not truncated — Task 1.
4. A `fff-pitch` row must land in the documented column order, with a missing optional answer as an empty cell rather than `null` — Task 2.
5. `subscriberOf` must return `null` for this kind even if a caller posts `subscribe: 'Yes'` directly to the endpoint — Task 1.

---

### Task 1: The `fff-pitch` form kind

**Files:**
- Modify: `lib/form-schema.mjs` (add an entry to `FORM_KINDS`)
- Test: `tools/form-schema.test.mjs`

**Interfaces:**
- Consumes: `validateSubmission(kind, body)`, `renderText(kind, fields)`, `FORM_KINDS` — all exported already.
- Produces: `FORM_KINDS['fff-pitch']`, with `subject: 'FFF pitch'`, `subjectFields: ['nomineeFirstName', 'nomineeLastName']`, `replyToField: 'pitcherEmail'`, and no `subscriber` key.

Fields, in this order (`TEXT` unless noted):

| key | required | max |
|---|---|---|
| `pitcherFirstName` | yes | 120 |
| `pitcherLastName` | yes | 120 |
| `pitcherEmail` | yes | 200, `email: true` |
| `isSelf` | no | 10 |
| `nomineeFirstName` | yes | 120 |
| `nomineeLastName` | yes | 120 |
| `nomineeEmail` | no | 200, `email: true` |
| `nomineeTitle` | no | 160 |
| `nomineeCompany` | no | 160 |
| `nomineeLinkedin` | no | 300 |
| `relationship` | no | 160 |
| `why` | yes | 2000 |
| `oneLine` | yes | 300 |

- [ ] **Step 1: Write the failing tests** in `tools/form-schema.test.mjs`

```js
const pitch = () => ({
  pitcherFirstName: 'Jane', pitcherLastName: 'Doe', pitcherEmail: 'jane@example.com',
  nomineeFirstName: 'Ada', nomineeLastName: 'Rivera',
  why: 'She rebuilt the settlement pipeline and mentors three juniors.',
  oneLine: 'The engineer every payments team wishes they had.'
});

test('a complete pitch is accepted and replies to the pitcher, not the nominee', () => {
  const r = validateSubmission('fff-pitch', { ...pitch(), nomineeEmail: 'ada@example.com' });
  assert.equal(r.ok, true);
  assert.equal(r.replyTo, 'jane@example.com');
  assert.match(r.subject, /^FFF pitch — Ada Rivera$/);
});

test('a pitch without the nominee email is accepted', () => {
  assert.equal(validateSubmission('fff-pitch', pitch()).ok, true);
});

test('a self-pitch still replies to the pitcher', () => {
  const r = validateSubmission('fff-pitch', { ...pitch(), isSelf: 'Yes' });
  assert.equal(r.replyTo, 'jane@example.com');
  assert.equal(r.fields.isSelf, 'Yes');
});

test('a pitch never subscribes anyone, even when asked directly', () => {
  const r = validateSubmission('fff-pitch', { ...pitch(), subscribe: 'Yes' });
  assert.equal(r.subscriber, null);
});

test('an over-long why is refused rather than truncated', () => {
  const r = validateSubmission('fff-pitch', { ...pitch(), why: 'x'.repeat(2001) });
  assert.equal(r.ok, false);
  assert.match(r.message, /too long/i);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tools/form-schema.test.mjs`
Expected: FAIL — "That form is not one this site knows about."

- [ ] **Step 3: Add the `'fff-pitch'` entry to `FORM_KINDS`** in `lib/form-schema.mjs`

Follow the `nomination` entry directly above it; it already solves the same reply-to hazard. Add a comment saying why there is no `subscriber` key, so nobody adds one later.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS, with the five new tests included.

- [ ] **Step 5: Commit**

```bash
git add lib/form-schema.mjs tools/form-schema.test.mjs
git commit -F <message file>
```

---

### Task 2: The `FFF Pitches` sheet tab

**Files:**
- Modify: `lib/nomination-sheet.mjs` (a `FFF_PITCH_COLUMNS` array and a `SHEETS` entry)
- Test: `tools/nomination-sheet.test.mjs`

**Interfaces:**
- Consumes: `sheetFor(kind)`, `headerFor(kind)`, `rowFor(fields, at, kind)` — exported already. Columns are `[label, (fields) => value]` pairs; header and row are derived from the one declaration so they cannot drift.
- Produces: `SHEETS['fff-pitch'] = { tab: 'FFF Pitches', columns: FFF_PITCH_COLUMNS }`.

Column order: Submitted at, Pitcher first name, Pitcher last name, Pitcher email, Pitching herself, Nominee first name, Nominee last name, Nominee email, Nominee title, Nominee company, Nominee LinkedIn, How they know her, Why her, In one sentence.

- [ ] **Step 1: Write the failing tests** in `tools/nomination-sheet.test.mjs`

```js
test('an fff-pitch row lands in the documented column order', () => {
  const row = rowFor({ pitcherFirstName: 'Jane', nomineeFirstName: 'Ada', why: 'Because.' }, AT, 'fff-pitch');
  assert.equal(headerFor('fff-pitch').length, row.length);
  assert.equal(row[headerFor('fff-pitch').indexOf('Pitcher first name')], 'Jane');
  assert.equal(row[headerFor('fff-pitch').indexOf('Why her')], 'Because.');
});

test('a missing optional pitch answer becomes an empty cell, not null', () => {
  const row = rowFor({ pitcherFirstName: 'Jane' }, AT, 'fff-pitch');
  assert.ok(row.every((cell) => cell !== null && cell !== undefined));
});

test('fff-pitch writes its own tab', () => {
  assert.equal(sheetFor('fff-pitch').tab, 'FFF Pitches');
});
```

Reuse the file's existing `AT` constant (or its local equivalent) rather than inventing a timestamp.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tools/nomination-sheet.test.mjs`
Expected: FAIL — `No sheet is configured for "fff-pitch"`.

- [ ] **Step 3: Add `FFF_PITCH_COLUMNS` and the `SHEETS` entry** in `lib/nomination-sheet.mjs`

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Add the tab to the Apps Script allowlist** in `docs/iff-nominations.gs`

Add `'FFF Pitches'` to its `TABS`. Note in the commit body that the deployed script must be updated separately before rows will write, and that until then the failure is logged and the submission still succeeds.

- [ ] **Step 6: Commit**

```bash
git add lib/nomination-sheet.mjs tools/nomination-sheet.test.mjs docs/iff-nominations.gs
git commit -F <message file>
```

---

### Task 3: The page and its links

**Files:**
- Create: `src/suggest-a-friday.html`
- Modify: `src/fintech-female-fridays.html` (CTA band before the footer)
- Modify: `src/_data/nav.json` (footer link under the "Events" column)

**Interfaces:**
- Consumes: `POST /api/form` with `kind: 'fff-pitch'` and the Task 1 field names; `{{ site.membershipUrl }}` resolves via the `resolveUrl` filter in `eleventy.config.js`.
- Produces: the page at `/suggest-a-friday.html`.

Build `src/suggest-a-friday.html` from `src/nominate.html`, keeping its structure verbatim: hero, aside, form card, success panel, and the client script with its `website` honeypot, `elapsedMs` timer, per-field validation and `fetch('/api/form')` call. Change only the fields, the copy, and `kind`.

The "this is me" checkbox copies `pitcherFirstName`/`pitcherLastName` into the nominee name inputs on change and leaves them editable.

- [ ] **Step 1: Create the page and wire the two links**

- [ ] **Step 2: Build and verify what the build produced**

Run: `CLERK_PUBLISHABLE_KEY=pk_test_x CLERK_FRONTEND_API_URL=https://x.clerk.accounts.dev npx eleventy`
Expected: `_site/suggest-a-friday.html` exists; `grep -c 'suggest-a-friday.html' _site/fintech-female-fridays.html` ≥ 1; the footer link resolves to a real path, not `{membershipUrl}`-style placeholder text.

- [ ] **Step 3: Submit the form against the local server**

Run `npx eleventy --serve` with the same two env vars, open `/suggest-a-friday.html`, and submit a complete pitch. Expect the inline error panel, not the success panel: the dev server has no `/api/form`. This proves the client-side validation and the submit path, not delivery.

Then prove the server half directly against the deployed endpoint's validator:

Run: `node --input-type=module -e "import {validateSubmission} from './lib/form-schema.mjs'; const r = validateSubmission('fff-pitch', {/* the body the page posts */}); console.log(r.ok, r.replyTo, r.subject);"`
Expected: `true`, the pitcher's address, `FFF pitch — <nominee>`.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/suggest-a-friday.html src/fintech-female-fridays.html src/_data/nav.json
git commit -F <message file>
```

---

### Task 4: Verify end to end on a deployment

- [ ] **Step 1: Open a PR and let it deploy**
- [ ] **Step 2: Submit one real pitch through the deployed page**

Expected: the success panel; a plain-text notification in the team inbox whose Reply addresses the pitcher; and either a row on `FFF Pitches` or, if the Apps Script is not yet updated, a logged `tab_not_allowed` with the submission still succeeding.

- [ ] **Step 3: Confirm the log line names no free text**

Run: `vercel logs <deployment url> --json | grep fff-pitch`
Expected: kind and address only — never the body.
