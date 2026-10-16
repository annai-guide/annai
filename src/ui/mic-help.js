import { platform } from './platform.js';

/**
 * What went wrong with the microphone, in plain words, with steps for this phone (spec §17 rule 3).
 * @param {unknown} e @param {'ios' | 'android' | 'desktop'} [where] @returns {{ title: string, body: string }}
 */
export function micProblem(e, where = platform()) {
  const name = /** @type {any} */ (e)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    const steps = where === 'ios'
      ? 'On iPhone: open Settings → Apps → Safari → Microphone, choose Ask or Allow, then come back and try again.'
      : where === 'android'
        ? 'On Android: tap the icon left of the address (in the installed app: hold the annai icon, then App info → Permissions), allow the microphone, then try again.'
        : "Allow the microphone for this site in your browser's site settings, then try again.";
    return { title: "annai can't use the microphone", body: `It wasn't allowed. ${steps}` };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { title: 'No microphone found', body: 'This device has no microphone annai can use. Connect one, or type to Shiori instead.' };
  if (name === 'NotReadableError' || name === 'AbortError') return { title: 'The microphone is busy', body: 'Another app is using it, such as a call or a voice recorder. Close it, then try again.' };
  return { title: "The microphone didn't start", body: `${String(/** @type {any} */ (e)?.message ?? e).replace(/\.$/, '')}. Try again; if it keeps happening, restart annai.` };
}
