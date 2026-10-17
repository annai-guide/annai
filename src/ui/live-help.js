import { platform, isStandalone } from './platform.js';

/**
 * A refused location, in plain words, with steps for this phone (spec §17 rule 3). Live mode keeps
 * its time reminders, and the user can say where they are (§17 rule 2: "a manual place").
 * On iPhone, "Don't Allow" in a Safari tab is Safari's setting for this site; annai on the Home
 * Screen uses Safari's location setting for websites. Location Services must be on for either.
 * @param {'ios' | 'android' | 'desktop'} where @param {boolean} [installed] annai runs from the Home Screen
 * @returns {{ title: string, body: string }}
 */
export function gpsProblem(where, installed = false) {
  const services = 'Location Services must be on: Settings → Privacy & Security → Location Services.';
  const steps = where === 'ios'
    ? installed
      ? `On iPhone: Settings → Privacy & Security → Location Services → Safari Websites → While Using the App, and Settings → Apps → Safari → Location → Allow. ${services}`
      : `On iPhone: tap aA in the address bar, then Website Settings → Location → Allow (or Settings → Apps → Safari → Location → Allow). ${services}`
    : where === 'android'
      ? 'On Android: tap the icon left of the address (in the installed app: hold the annai icon, then App info → Permissions) and allow Location.'
      : "Allow location for this site in your browser's site settings.";
  return {
    title: "annai can't see where you are",
    body: `Location isn't allowed, so live mode has only its time reminders. ${steps} Then turn live mode off and on again. Or tell annai where you are: Live → Where are you?`,
  };
}

/** Whether the card was shown, kept in this browser across starts (where storage is blocked, until the page closes). */
const KEY = 'annai.locationRefusedTold';
let session = false;
const kept = {
  told: () => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return session;
    }
  },
  /** @param {boolean} v */
  set: (v) => {
    session = v;
    try {
      if (v) localStorage.setItem(KEY, '1');
      else localStorage.removeItem(KEY);
    } catch {
      // storage blocked: this session remembers
    }
  },
};

/**
 * Shows that card once when live mode's GPS is refused, not again at each start while it stays
 * refused; again only once something changed: location worked, or live mode was turned off.
 * @param {{ live: { on: boolean, gps: string, onChange: (fn: () => void) => () => void }, notices: { card: (c: any) => unknown }, where?: 'ios' | 'android' | 'desktop', installed?: boolean,
 *   memo?: { told: () => boolean, set: (v: boolean) => void } }} c  memo: where it is remembered (this browser's storage)
 */
export function tellGps({ live, notices, where = platform(), installed = where === 'ios' && isStandalone(), memo = kept }) {
  return live.onChange(() => {
    if (live.on && live.gps === 'denied') {
      if (!memo.told()) notices.card({ tone: 'warn', ...gpsProblem(where, installed) });
      memo.set(true);
    } else if ((live.gps === 'ok' || !live.on) && memo.told()) memo.set(false);
  });
}
