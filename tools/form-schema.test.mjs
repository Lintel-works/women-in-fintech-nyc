import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSubmission, renderText, FORM_KINDS } from '../lib/form-schema.mjs';

const good = () => ({
  name: 'Jane Doe',
  email: 'jane@example.com',
  role: 'Product Lead',
  chapter: 'New York',
  vision: 'A tool for reconciling payouts.',
  skills: ['Product', 'Go-to-market'],
  looking: 'An engineer who has shipped payments before.',
  stage: 'Just an idea',
  commitment: 'Exploring on the side'
});

test('a complete submission is accepted and carries a reply-to', () => {
  const r = validateSubmission('co-founder', good());
  assert.equal(r.ok, true);
  assert.equal(r.replyTo, 'jane@example.com');
  assert.equal(r.fields.name, 'Jane Doe');
  assert.deepEqual(r.fields.skills, ['Product', 'Go-to-market']);
});

test('an unknown form kind is refused', () => {
  assert.equal(validateSubmission('not-a-form', good()).ok, false);
  assert.equal(validateSubmission('', good()).ok, false);
  assert.equal(validateSubmission(null, good()).ok, false);
});

test('every required field is actually required', () => {
  for (const key of ['name', 'email', 'role', 'vision', 'looking']) {
    const body = good();
    delete body[key];
    const r = validateSubmission('co-founder', body);
    assert.equal(r.ok, false, `${key} was accepted as missing`);
    assert.match(r.message, /required/i);
  }
});

test('optional fields may be absent', () => {
  const body = good();
  for (const key of ['chapter', 'skills', 'stage', 'commitment']) delete body[key];
  const r = validateSubmission('co-founder', body);
  assert.equal(r.ok, true);
  assert.equal(r.fields.chapter, undefined);
  assert.equal(r.fields.skills, undefined);
});

test('whitespace-only is treated as missing, not as a value', () => {
  const r = validateSubmission('co-founder', { ...good(), name: '   \t  ' });
  assert.equal(r.ok, false);
  assert.match(r.message, /name/i);
});

test('a bad email is refused', () => {
  for (const email of ['jane', 'jane@', '@example.com', 'jane example.com', 'jane@example']) {
    const r = validateSubmission('co-founder', { ...good(), email });
    assert.equal(r.ok, false, `accepted ${email}`);
  }
});

test('over-long values are refused, not silently truncated', () => {
  const r = validateSubmission('co-founder', { ...good(), vision: 'x'.repeat(2001) });
  assert.equal(r.ok, false);
  assert.match(r.message, /too long/i);
  // and the boundary is inclusive
  assert.equal(validateSubmission('co-founder', { ...good(), vision: 'x'.repeat(2000) }).ok, true);
});

/* The Subject header is the one place a newline is an injection rather than
   formatting. A textarea can legitimately contain newlines, so the body must
   keep them -- only the subject is flattened. */
test('a newline in the name cannot break the subject header', () => {
  const r = validateSubmission('co-founder', {
    ...good(),
    name: 'Jane\r\nBcc: attacker@example.com'
  });
  assert.equal(r.ok, true);
  assert.ok(!r.subject.includes('\n'), 'subject contains a newline');
  assert.ok(!r.subject.includes('\r'), 'subject contains a carriage return');
});

test('newlines inside a long answer are preserved in the body', () => {
  const r = validateSubmission('co-founder', { ...good(), vision: 'line one\nline two' });
  assert.equal(r.ok, true);
  assert.match(r.text, /line one\nline two/);
});

/* U+2028 published fine and made a post unopenable once already. It has no
   business in a form value either. */
test('control characters and line separators are stripped', () => {
  const r = validateSubmission('co-founder', {
    ...good(),
    role: 'Product Lead\u0000\u0007'
  });
  assert.equal(r.ok, true);
  assert.equal(r.fields.role, 'ProductLead');
});

test('a skills list longer than the cap is refused', () => {
  const r = validateSubmission('co-founder', { ...good(), skills: new Array(13).fill('x') });
  assert.equal(r.ok, false);
});

test('a non-array skills value is ignored rather than throwing', () => {
  for (const skills of ['Product', 42, {}, null]) {
    const r = validateSubmission('co-founder', { ...good(), skills });
    assert.equal(r.ok, true, `threw or refused on ${JSON.stringify(skills)}`);
    assert.equal(r.fields.skills, undefined);
  }
});

test('unknown keys are dropped, not rejected', () => {
  const r = validateSubmission('co-founder', { ...good(), surpriseField: 'x', website: 'spam' });
  assert.equal(r.ok, true);
  assert.equal(r.fields.surpriseField, undefined);
  assert.equal(r.fields.website, undefined);
});

test('hostile input types do not throw', () => {
  for (const body of [null, undefined, 'a string', 42, []]) {
    const r = validateSubmission('co-founder', body);
    assert.equal(typeof r.ok, 'boolean');
  }
});

test('the rendered body names every supplied field and omits absent ones', () => {
  const r = validateSubmission('co-founder', good());
  assert.match(r.text, /^Name:\nJane Doe$/m);
  assert.match(r.text, /^What they bring:\nProduct, Go-to-market$/m);
  const body = good();
  delete body.stage;
  assert.ok(!renderText('co-founder', validateSubmission('co-founder', body).fields).includes('Stage:'));
});

test('the co-founder schema matches the fields the page actually posts', () => {
  // If the page gains a field, this fails until the schema learns about it --
  // which is the point. The list mirrors src/co-founder-matching.html.
  assert.deepEqual(
    FORM_KINDS['co-founder'].fields.map((f) => f.key),
    ['name', 'email', 'role', 'chapter', 'vision', 'skills', 'looking', 'stage', 'commitment']
  );
});

/* ---------------------------------------------------------- membership form */

const member = () => ({
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  jobTitle: 'Engineer',
  experience: '10 - 15 years',
  company: 'Analytical Engines',
  companyType: 'Early Stage Startup',
  status: 'Employed',
  role: 'Engineering',
  city: 'New York City',
  madeHire: 'Yes (Wonderful!)',
  foundJob: 'No (If you\'re looking for talent, we know some amazing women)',
  heardFrom: 'Word of mouth',
  support: ['Networking Opportunities', 'Job Search'],
  speaking: 'Happy to speak on engineering panels.',
  testimonial: 'The best room in fintech.',
  subscribe: 'Yes',
  comments: 'See you at the next one.'
});

test('a complete membership submission is accepted', () => {
  const r = validateSubmission('membership', member());
  assert.equal(r.ok, true);
  assert.equal(r.replyTo, 'ada@example.com');
});

test('the membership subject carries both name fields, not "undefined"', () => {
  const r = validateSubmission('membership', member());
  assert.equal(r.subject, 'Membership — Ada Lovelace');
  assert.ok(!r.subject.includes('undefined'));
});

test('membership requires first name, last name and email', () => {
  for (const key of ['firstName', 'lastName', 'email']) {
    const body = member();
    delete body[key];
    const r = validateSubmission('membership', body);
    assert.equal(r.ok, false, `${key} should be required`);
  }
});

test('membership requires at least one support option', () => {
  const body = member();
  body.support = [];
  const r = validateSubmission('membership', body);
  assert.equal(r.ok, false);
  assert.match(r.message, /at least one/i);
});

test('an absent support list is refused the same way an empty one is', () => {
  const body = member();
  delete body.support;
  assert.equal(validateSubmission('membership', body).ok, false);
});

test('the optional membership fields may all be absent', () => {
  const r = validateSubmission('membership', {
    firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com',
    support: ['Mentorship Support']
  });
  assert.equal(r.ok, true);
});

test('every membership answer reaches the email body', () => {
  const body = member();
  const text = renderText('membership', validateSubmission('membership', body).fields);
  for (const label of ['First name', 'Last name', 'Email', 'Job title', 'Testimonial', 'Comments']) {
    assert.ok(text.includes(label + ':'), `${label} missing from the email`);
  }
  assert.ok(text.includes('Networking Opportunities, Job Search'), 'support list not joined');
});

test('the co-founder subject is unchanged by the subjectFields default', () => {
  assert.equal(validateSubmission('co-founder', good()).subject, 'Co-founder matching — Jane Doe');
});

test('both form kinds are registered', () => {
  assert.deepEqual(Object.keys(FORM_KINDS).sort(), ['co-founder', 'membership']);
});
