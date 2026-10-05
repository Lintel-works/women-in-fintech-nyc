import test from 'node:test';
import assert from 'node:assert/strict';
import { readElements, splitIntro, toBlocks } from './import-wix-post.mjs';

/* The importer reads Ricos markup, which marks structure by inline style
   rather than by element. Every rule here was written against a specific
   failure found while migrating the full 261-post archive -- the seven posts
   the tool was first built for did not exercise any of them. */

const para = (text, style = '') => `<p data-ricos-paragraph="true"${style}>${text}</p>`;
const question = (text) => para(`<strong>${text}</strong>`);
const image = (id) => `<figure data-hook="figure-IMAGE"><wow-image id="${id}"></wow-image></figure>`;

test('a body that opens on a question has no intro rather than failing', () => {
  /* Eighty-one of the archived posts start straight on the first interview
     question. splitIntro used to throw "intro did not match og:description"
     for every one of them, which is how two thirds of the archive stayed
     unmigrated. */
  const elements = readElements(question('How did you get into fintech?') + para('By accident.'));
  const { intro, rest } = splitIntro(elements, 'How did you get into fintech? By accident.');
  assert.equal(intro, '');
  assert.equal(rest.length, 2);
  assert.equal(rest[0].kind, 'question');
});

test('a body that opens on prose still has to match og:description', () => {
  /* The empty-intro path must not become a way for a genuine misread to pass
     silently: prose that does not match og:description is still an error. */
  const elements = readElements(para('An intro that the og tag knows nothing about.'));
  assert.throws(
    () => splitIntro(elements, 'Something else entirely, with no words in common.'),
    /intro did not match og:description/
  );
});

test('an answer is read past a photograph set between question and reply', () => {
  /* A qa block holds two strings and cannot nest an image, so the scan reads
     through it. Stopping at it left 118 questions across 62 posts with an
     empty answer, and dropped their answers out as loose prose. */
  const region = question('What changed?') + image('a.jpg') + para('Everything changed.');
  const blocks = toBlocks(splitIntro(readElements(region), 'What changed? Everything changed.').rest,
    ['images/a.jpg'], 'Someone');
  const qa = blocks.find((b) => b.type === 'qa');
  assert.ok(qa, 'expected a qa block');
  assert.equal(qa.a, 'Everything changed.');
  assert.ok(blocks.some((b) => b.type === 'image'), 'the photograph must survive');
});

test('one question stored as two paragraphs is read as one question', () => {
  /* "...that can give to" / "other women in FinTech?" is one question Wix
     split. Left apart, the first took no answer and the second took it all. */
  const region =
    question('What is one piece of advice you would give to') +
    question('other women in FinTech?') +
    para('Ask for what you want.');
  const elements = readElements(region);
  const questions = elements.filter((el) => el.kind === 'question');
  assert.equal(questions.length, 1, `expected the halves to merge, got ${questions.length}`);
  assert.match(questions[0].text, /advice you would give to other women in FinTech\?$/);
});

test('a question nobody answered becomes a heading, not an empty exchange', () => {
  /* Rendering it as a qa emits <div class="qa-a"></div> -- a gap on the page
     where an answer should be. */
  const region = question('Favourite reads:') + '<ul><li>One book</li><li>Another</li></ul>';
  const blocks = toBlocks(splitIntro(readElements(region), 'Favourite reads:').rest, [], 'Someone');
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[0].text, 'Favourite reads:');
  assert.ok(!blocks.some((b) => b.type === 'qa' && !b.a.trim()), 'no empty answers');
});

test('a link does not make a paragraph a question', () => {
  /* #1155CC is the colour Wix gives questions in the handful of posts that
     colour them -- and also the default colour of every hyperlink. Reading
     blue as "question" without checking whether the document colours anything
     turned ordinary prose into unanswered questions across dozens of posts. */
  const withLink = para('She joined <a href="https://x.com" style="color:#1155CC">Acme</a> last year.');
  assert.equal(readElements(withLink)[0].kind, 'paragraph');
});

test('a post that colours its answers black still reads blue as a question', () => {
  /* The rule exists for Adina Fischer's post, which sets the questions in the
     link blue and leaves the answers explicitly black. That must keep working. */
  const region =
    para('<span style="color:#1155CC">What drew you to fintech?</span>') +
    para('<span style="color: rgb(0, 0, 0)">The people.</span>');
  const elements = readElements(region);
  assert.equal(elements[0].kind, 'question');
  assert.equal(elements[1].kind, 'paragraph');
});

/* The cases below all come from a review of the completed migration, and each
   one was reproduced in shipped output before it was fixed. */

test('one black run does not turn every linked paragraph into a question', () => {
  /* The document-level gate was too coarse: a single explicitly-black run
     anywhere re-enabled the blue rule for the whole post, so ordinary prose
     whose only #1155CC was a hyperlink came back as a question. It shipped --
     Klaudette Christensen's entire bio was published as an interview question
     and her post lost its intro. */
  const region =
    para('<span style="color: rgb(0, 0, 0)">Hometown: Turin</span>') +
    para('She joined <a href="https://x.com" style="color:#1155CC">Acme</a> last year.');
  const elements = readElements(region);
  assert.equal(elements[1].kind, 'paragraph');
});

test('a lead still matches an og:description Wix truncated with an ellipsis', () => {
  /* Wix ends some og:description values with "..." -- three characters that
     are not in the body, where the comparison tolerates two. */
  const elements = readElements(para('Patricia Yun is Head of Digital Commerce at TD Bank. She has been in financial services for over ten years.'));
  const { intro } = splitIntro(elements, 'Patricia Yun is Head of Digital Commerce at TD Bank. She...');
  assert.match(intro, /^Patricia Yun is Head of Digital Commerce/);
});

test('a bio set inside a heading element is prose, not a heading', () => {
  /* One author put a 228-character bio in an <h5>. Every real heading in the
     archive is a short section label, so length is what separates them. */
  const long = 'Maya has a background in Finance, Accounting, and Marketing and is a Certified Chartered Accountant, and she spent the first ten years of her career in corporate strategy.';
  const [el] = readElements(`<h5 data-ricos-heading="x">${long}</h5>`);
  assert.equal(el.kind, 'paragraph');
});

test('a recovered heading paragraph does not glue itself to the line above', () => {
  const region =
    para('<strong>Current location</strong>: New York') +
    `<h5 data-ricos-heading="x">Maya has a background in Finance, Accounting and Marketing, and is a Certified Chartered Accountant with ten years of experience.</h5>`;
  const elements = readElements(region);
  assert.equal(elements.length, 2, 'the two must stay separate');
  assert.match(elements[0].text, /New York$/);
});

test('two adjacent bold labels stay two elements', () => {
  /* Merging questions must not run two separate labels together: the result
     became one garbled heading. */
  const elements = readElements(question('Favourite reads') + question('Best advice'));
  assert.equal(elements.length, 2);
});

test('unanswered prose becomes a paragraph while an unanswered question becomes a heading', () => {
  const prose = 'She has a background in finance and accounting and spent ten years in corporate strategy across several consumer companies.';
  const proseBlocks = toBlocks(readElements(question(prose)), [], 'Someone');
  assert.equal(proseBlocks[0].type, 'paragraph', 'a bold bio is prose, not an <h2>');

  const askBlocks = toBlocks(readElements(question('What keeps you motivated?')), [], 'Someone');
  assert.equal(askBlocks[0].type, 'heading');
});
