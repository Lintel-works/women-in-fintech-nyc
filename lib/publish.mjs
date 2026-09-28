/* Turns a validated payload into the exact bytes of a post file -- and proves
 * they will render before anybody commits them.
 *
 * The render gate is the point of this module. A post that throws in the
 * renderer would fail the Vercel build, and a failed build leaves the previous
 * deployment serving: the site stays up, the post never appears, and nobody is
 * watching the build log to notice. Rendering here turns that silence into a
 * message the author reads while they are still looking at the screen.
 */
import { validatePublish } from './publish-validate.mjs';
import { serializePost } from './post-file.mjs';
import { buildPostView } from './render-blocks.mjs';

export function preparePublish(payload) {
  const valid = validatePublish(payload);
  if (!valid.ok) return valid;

  try {
    buildPostView(valid.post);
  } catch (error) {
    return { ok: false, message: `This post cannot be shown on the site yet: ${error.message}` };
  }

  return {
    ok: true,
    path: valid.path,
    slug: valid.slug,
    type: valid.type,
    text: serializePost(valid.post)
  };
}
