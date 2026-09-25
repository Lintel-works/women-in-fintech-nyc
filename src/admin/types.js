/* NYC Fintech Women — admin: page-type and block-type registries.
 *
 * Adding a new page type = one entry in TYPES. Adding a new block type = one
 * entry in BLOCK_FIELDS (form) and one in the renderer's BLOCK_RENDERERS
 * (output). Nothing else changes.
 */

/* ------------------------------------------------------------ FFF fields */

const FFF_FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true,
    placeholder: 'Shira Amrany', help: 'Drives the slug and the filename.' },
  { key: 'slug', label: 'Slug', type: 'text', required: true, mono: true,
    prefix: 'fff-', suffix: '.html',
    help: 'Auto-filled from the name. Edit it and it stops following. The file downloads as <code>&lt;slug&gt;.html</code>; the build adds the <code>fff-</code> prefix. Letters, digits and hyphens only.' },
  { key: 'title', label: 'Post title', type: 'text', required: true,
    placeholder: 'FinTech Female Fridays: Meet Shira Amrany',
    help: 'Leave blank to use “FinTech Female Fridays: Meet {name}”.' },
  { key: 'tag', label: 'Tag / category', type: 'text',
    placeholder: 'Fintech Female Fridays',
    help: 'The uppercase chip above the headline and on the cards.' },
  { key: 'role', label: 'Title / role', type: 'text',
    placeholder: 'Data & Analytics Lead' },
  { key: 'company', label: 'Company', type: 'text', placeholder: 'Indagari' },
  { key: 'linkedin', label: 'LinkedIn URL', type: 'url',
    placeholder: 'https://www.linkedin.com/in/…' },
  { key: 'author', label: 'Interviewed by', type: 'text',
    placeholder: 'Manvir Singh' },
  { key: 'date', label: 'Publish date', type: 'text', placeholder: 'Jul 10',
    help: 'Displayed as typed, matching the existing cards.' },
  { key: 'isoDate', label: 'ISO date', type: 'date',
    help: 'Machine-readable date for SEO only. Not displayed.' },
  { key: 'readTime', label: 'Read time', type: 'text', placeholder: '4 min' },
  { key: 'gradient', label: 'Card gradient', type: 'select',
    options: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'],
    help: 'The duotone wash over the cover on the listing and homepage cards.' },
  { key: 'intro', label: 'Intro / hook', type: 'textarea', rows: 6, required: true,
    placeholder: 'The opening paragraph that runs above the interview…',
    help: 'Also the default source for the card excerpt and meta description.' },
  { key: 'excerpt', label: 'Card excerpt', type: 'textarea', rows: 3,
    help: 'Optional. Blank = first ~240 characters of the intro.' },
  { key: 'metaDescription', label: 'Meta description', type: 'textarea', rows: 2,
    maxlength: 200,
    help: 'Optional. Blank = first ~155 characters of the intro.' },
  { key: 'ogTitle', label: 'Social (OG) title', type: 'text',
    help: 'Optional. Blank = post title.' },
  { key: 'ogImage', label: 'Social (OG) image', type: 'text',
    help: 'Optional. Blank = the cover image. Emitted as an absolute URL.' }
];

/* --------------------------------------------------- Jobs & Happenings fields */

/* No name, role, company or linkedin: those describe an interviewee. The
   title is required and has no fallback -- a news post cannot borrow the FFF
   "Meet {name}" default, so a blank one is refused at download rather than
   published as an empty headline. */
const POST_FIELDS = [
  { key: 'title', label: 'Post title', type: 'text', required: true,
    placeholder: 'October in review: three sold-out nights',
    help: 'Required. Drives the slug and the filename.' },
  { key: 'slug', label: 'Slug', type: 'text', required: true, mono: true,
    prefix: 'post-', suffix: '.html',
    help: 'Auto-filled from the title. Edit it and it stops following. The file downloads as <code>&lt;slug&gt;.html</code>; the build adds the <code>post-</code> prefix. Letters, digits and hyphens only.' },
  { key: 'tag', label: 'Tag / category', type: 'text',
    placeholder: 'Event recap',
    help: 'The uppercase chip above the headline and on the card. Blank = “Jobs &amp; Happenings”.' },
  { key: 'author', label: 'Written by', type: 'text',
    placeholder: 'Manvir Singh' },
  { key: 'date', label: 'Publish date', type: 'text', placeholder: 'Oct 14',
    help: 'Displayed as typed, matching the existing cards.' },
  { key: 'isoDate', label: 'ISO date', type: 'date',
    help: 'Machine-readable date. Also what orders the listing page.' },
  { key: 'readTime', label: 'Read time', type: 'text', placeholder: '4 min' },
  { key: 'gradient', label: 'Card gradient', type: 'select',
    options: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'],
    help: 'The duotone wash over the cover on the listing card.' },
  { key: 'intro', label: 'Intro / hook', type: 'textarea', rows: 6, required: true,
    placeholder: 'The opening paragraph…',
    help: 'Also the default source for the card excerpt and meta description.' },
  { key: 'excerpt', label: 'Card excerpt', type: 'textarea', rows: 3,
    help: 'Optional. Blank = first ~240 characters of the intro.' },
  { key: 'metaDescription', label: 'Meta description', type: 'textarea', rows: 2,
    maxlength: 200,
    help: 'Optional. Blank = first ~155 characters of the intro.' },
  { key: 'ogTitle', label: 'Social (OG) title', type: 'text',
    help: 'Optional. Blank = post title.' },
  { key: 'ogImage', label: 'Social (OG) image', type: 'text',
    help: 'Optional. Blank = the cover image. Emitted as an absolute URL.' }
];

/* ------------------------------------------------------------ block form */

const BLOCK_LABELS = {
  qa: 'Q & A',
  heading: 'Heading',
  paragraph: 'Paragraph',
  quote: 'Pull quote',
  image: 'Image',
  list: 'List'
};

const BLOCK_FIELDS = {
  qa: [
    { key: 'q', label: 'Question', control: 'textarea', rows: 2 },
    { key: 'a', label: 'Answer', control: 'textarea', rows: 6 }
  ],
  heading: [
    { key: 'text', label: 'Heading', control: 'text' }
  ],
  paragraph: [
    { key: 'text', label: 'Text', control: 'textarea', rows: 6,
      help: 'Blank line = new paragraph.' }
  ],
  quote: [
    { key: 'text', label: 'Quote', control: 'textarea', rows: 3 },
    { key: 'attrib', label: 'Attribution', control: 'text' }
  ],
  image: [
    { key: 'src', label: 'Path', control: 'text', placeholder: 'images/…' },
    { key: 'alt', label: 'Alt text', control: 'text' },
    { key: 'caption', label: 'Caption', control: 'text' }
  ],
  list: [
    { key: 'items', label: 'Items (one per line)', control: 'lines', rows: 5 },
    { key: 'ordered', label: 'Numbered', control: 'checkbox' }
  ]
};

export function blankBlock(type) {
  var block = { type: type, id: 'b' + Math.random().toString(36).slice(2, 9) };
  (BLOCK_FIELDS[type] || []).forEach(function (field) {
    if (field.control === 'checkbox') block[field.key] = false;
    else if (field.control === 'lines') block[field.key] = [];
    else block[field.key] = '';
  });
  return block;
}

/* ------------------------------------------------------------- page type */

/* Both types take the same blocks. A recap that quotes a speaker has the same
   need for `qa` as an interview does. */
const ALL_BLOCKS = ['qa', 'heading', 'paragraph', 'quote', 'image', 'list'];

/* Form fields only. A type's identity -- its label, URL prefix, listing page,
   card badge and partials -- lives in lib/post-types.mjs, which editor.js
   merges in. This file stays free of that import so it can be loaded from Node
   by the test that checks the two registries have the same types. */
export const TYPES = {
  fff: { fields: FFF_FIELDS, blocks: ALL_BLOCKS },
  post: { fields: POST_FIELDS, blocks: ALL_BLOCKS }
};

export { BLOCK_LABELS, BLOCK_FIELDS };
