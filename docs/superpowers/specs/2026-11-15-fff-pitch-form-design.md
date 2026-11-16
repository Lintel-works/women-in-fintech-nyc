# Fintech Female Fridays pitch form — design

Date: 2026-11-15
Size: small change

## Intent, and the why

Fintech Female Fridays publishes an interview every Friday and has 262 of them.
There is no way for anyone outside the team to put a woman forward. Joining the
community and nominating for Inspiring FinTech Females both have public forms;
being featured on a Friday is reachable only by knowing someone. This form
closes that gap.

It collects a **pitch**, not an interview. Someone on the team reads it and
decides whether to book the interview; the interview itself happens as it does
today and is written up in `/admin`.

## Goals

- A woman can be put forward for a Friday feature by anyone, including herself.
- The team gets the pitch somewhere they already look (the shared inbox), with
  enough to decide without a reply: who she is, what she does, why her.
- Replying to the notification reaches the **person who pitched**, never the
  woman being pitched.
- A durable record beyond the inbox, so a missed email is not a lost pitch.

## Non-goals

- Not the interview. No Friday question set, no draft post, nothing reaching
  the editor. If that is wanted later it is a separate, larger piece of work.
- No mailing-list subscription. Someone pitching a colleague has not asked to
  join anything.
- No accounts, no login, no file or photograph upload.
- No change to how posts are written or published.

## Anti-goals

Things that would make this a failure even if it technically worked:

- A notification whose Reply goes to the woman being pitched, telling her she
  was nominated before anyone decided anything.
- A submission that is accepted, thanked, and discarded — the failure that
  `api/form.js` exists to prevent, and which the co-founder form suffered for
  months before it.
- A form that only accepts self-pitches, closing off "you should talk to my
  colleague", which is plausibly how many of the 262 were found.

## Constraints

- `api/form.js` serves every public form and is discriminated by `kind`. The new
  form is a `kind`, not a new endpoint.
- Notification email is plain text, never HTML: the body is untrusted input
  from the open internet, and plain text removes the injection category rather
  than defending against it.
- The spreadsheet is written through an Apps Script with a `TABS` allowlist. A
  new tab does not write until that script is updated and redeployed, and that
  script is still on a personal Google account mid-move to the organisation's.
  A sheet failure is logged and must never fail the submission.
- Published FFF posts occupy `fff-*.html` at the site root, so the new page must
  not use that prefix or it risks colliding with a post slug.
- House style: ES modules, async/await, 2-space indent, comments that say WHY.
  Tests are `node --test` under `tools/`.

## Approaches

**A — mirror the IFF nomination form (chosen).** Two blocks: who is pitching,
and who they are pitching. Reply-to is the pitcher. A "this is me" checkbox
copies the pitcher's details into the subject fields so self-pitches and
third-party pitches share one form and one code path.

*Trade-off:* a few more fields on screen than a self-only form. Chosen because
it handles both cases for almost no extra cost, and because the reply-to
problem it solves is one this codebase has already reasoned about explicitly —
`lib/form-schema.mjs` carries a comment about exactly this hazard on the IFF
nomination kind.

**B — self-pitch only.** One person, fewest fields, no reply-to problem at all.
Rejected: it closes off third-party pitches, which works against the main
reason for building this.

**C — a "who is this about?" toggle** that shows or hides the subject block.
Fewest fields visible, but the most client-side state to get wrong, for a form
submitted a few times a week. Rejected as complexity without a return.

## The shape, as decided

**Kind:** `fff-pitch`, added to `FORM_KINDS` in `lib/form-schema.mjs`.

| Field | Required | Notes |
|---|---|---|
| `pitcherFirstName`, `pitcherLastName` | yes | |
| `pitcherEmail` | yes | `replyToField` — the reply goes here |
| `isSelf` | no | "Yes" when the checkbox was ticked; recorded so the reader knows |
| `nomineeFirstName`, `nomineeLastName` | yes | |
| `nomineeEmail` | no | Optional for the same reason as IFF: someone can know a woman's work well enough to pitch her without holding her address, and refusing over it loses the pitch |
| `nomineeTitle`, `nomineeCompany`, `nomineeLinkedin` | no | |
| `relationship` | no | How the pitcher knows her |
| `why` | yes | Why she belongs on a Friday (max 2000) |
| `oneLine` | yes | Her in one sentence (max 300) |

No `subscriber` key: this kind never puts anyone on a mailing list.

**Where it lands:** notification email to the team (works on deploy), plus a
`FFF Pitches` tab added to `SHEETS` in `lib/nomination-sheet.mjs`. Until the
Apps Script allowlist is updated the row will not write; that failure is logged
with enough to re-enter it by hand and never blocks the submission, so the sheet
starts working the moment the script is updated, with no further deploy.

**The page:** `src/suggest-a-friday.html`, built from `nominate.html` — same
structure, client-side validation, honeypot, fill-timer, and success panel.
Deliberately not `fff-*.html`, to stay out of the published-post namespace.

**Links in:** a CTA band at the foot of `fintech-female-fridays.html`, mirroring
the nominate band on the IFF page, and a footer link under "Events".

## Calls I made rather than asking

- Page filename `suggest-a-friday.html`. Rename freely; nothing depends on it
  but the two links.
- `relationship` included as an optional field — it is what a reader will want
  to know next after "why her", and it is cheap.
- The success panel says a human reads every pitch and will be in touch only if
  it is a fit, rather than promising a reply to everyone.

## Left to the builder

- Exact page copy and the field labels, following the voice of `nominate.html`.
- Whether the "this is me" checkbox hides the subject-name fields or merely
  pre-fills them. Pre-filling is simpler and is the default unless it reads
  badly once built.
- Column order on the sheet tab.
