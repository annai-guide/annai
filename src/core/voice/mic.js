import { t } from '../l10n.js';
import { sentences } from '../intl.js';

/**
 * What went wrong with the microphone, in plain words, with steps for this phone (spec §17 rule 3): title and body for the
 * user's card, in the screens' language; plain, the title as a model reads it, in annai's English.
 * @param {unknown} e @param {'ios' | 'android' | 'desktop'} where @returns {{ title: string, body: string, plain: string }}
 */
export function micProblem(e, where) {
  const name = /** @type {any} */ (e)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    const steps = where === 'ios'
      ? t`On iPhone: open Settings → Apps → Safari → Microphone, choose Ask or Allow, then come back and try again.`
      : where === 'android'
        ? t`On Android: tap the icon left of the address (in the installed app: hold the annai icon, then App info → Permissions), allow the microphone, then try again.`
        : t`Allow the microphone for this site in your browser's site settings, then try again.`;
    return { title: t`annai can't use the microphone`, body: sentences(t`It wasn't allowed.`, steps), plain: /* en */ "annai can't use the microphone" };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { title: t`No microphone found`, body: t`This device has no microphone annai can use. Connect one, or type to Shiori instead.`, plain: /* en */ 'No microphone found' };
  if (name === 'NotReadableError' || name === 'AbortError') return { title: t`The microphone is busy`, body: t`Another app is using it, such as a call or a voice recorder. Close it, then try again.`, plain: /* en */ 'The microphone is busy' };
  // What the browser or the voice plugin said, as a sentence of its own, then annai's.
  const said = String(/** @type {any} */ (e)?.message ?? e).trim();
  return { title: t`The microphone didn't start`, body: sentences(/[.!?。！？]$/u.test(said) ? said : `${said}.`, t`Try again; if it keeps happening, restart annai.`), plain: /* en */ "The microphone didn't start" };
}
