import { platform } from './platform.js';

/**
 * A refused location, in plain words, with steps for this phone (spec §17 rule 3). Live mode keeps
 * its time reminders, and the user can say where they are (§17 rule 2: "a manual place").
 * @param {'ios' | 'android' | 'desktop'} where @returns {{ title: string, body: string }}
 */
export function gpsProblem(where) {
  const steps = where === 'ios'
    ? 'On iPhone: open Settings → Privacy & Security → Location Services, turn it on, and set Safari Websites (or annai, once it is on your Home Screen) to While Using the App.'
    : where === 'android'
      ? 'On Android: tap the icon left of the address (in the installed app: hold the annai icon, then App info → Permissions) and allow Location.'
      : "Allow location for this site in your browser's site settings.";
  return {
    title: "annai can't see where you are",
    body: `Location isn't allowed, so live mode has only its time reminders. ${steps} Then turn live mode off and on again. Or tell annai where you are: Live → Where are you?`,
  };
}

/**
 * Shows that card once when live mode's GPS is refused; again only if it worked in between.
 * @param {{ live: { on: boolean, gps: string, onChange: (fn: () => void) => () => void }, notices: { card: (c: any) => unknown }, where?: 'ios' | 'android' | 'desktop' }} c
 */
export function tellGps({ live, notices, where = platform() }) {
  let told = false;
  return live.onChange(() => {
    if (live.on && live.gps === 'denied') {
      if (!told) notices.card({ tone: 'warn', ...gpsProblem(where) });
      told = true;
    } else if (live.gps === 'ok') told = false;
  });
}
