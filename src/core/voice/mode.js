/**
 * Voice mode (spec §10.5): Auto, On or Off, always one tap away. Auto turns voice on when moving
 * fast (driving or riding), or when headphones or car audio are connected, and off on the phone's
 * speaker. Where annai can't tell what audio is connected, Auto follows the user's last explicit
 * choice in that situation: the activity (still, walking, moving fast, or unknown).
 * @typedef {'auto' | 'on' | 'off'} VoiceSetting
 * @typedef {'still' | 'walking' | 'moving-fast' | 'unknown'} Activity
 * @typedef {'car' | 'headphones' | 'speaker' | 'unknown'} Route
 * @typedef {{ setting: VoiceSetting, on: boolean, why: string }} VoiceMode  why: a few words for the chip and the now block
 */

/** @param {{ setting: VoiceSetting, activity: string, route: Route, lastChoices: Record<string, 'on' | 'off'> }} c @returns {VoiceMode} */
export function voiceMode({ setting, activity, route, lastChoices }) {
  if (setting === 'on') return { setting, on: true, why: 'on' };
  if (setting === 'off') return { setting, on: false, why: 'off' };
  if (activity === 'moving-fast') return { setting, on: true, why: 'moving' };
  if (route === 'car') return { setting, on: true, why: 'car audio' };
  if (route === 'headphones') return { setting, on: true, why: 'headphones' };
  if (route === 'speaker') return { setting, on: false, why: 'phone speaker' };
  const last = lastChoices[activity];
  return last ? { setting, on: last === 'on', why: 'your last choice' } : { setting, on: false, why: 'not sure' };
}

/** Names that are a car. */
const CAR = /\b(car|carplay|android auto|hands-?free|uconnect|sync|bmw|audi|mercedes|toyota|honda|ford|kia|hyundai|lexus|nissan|mazda|subaru|volvo|tesla|vw|volkswagen|jeep|chevrolet|chevy|gmc|porsche|mini|skoda|renault|peugeot|citroen|fiat)\b/i;
/** Names that are the phone's (or computer's) own. */
const OWN = /\b(iphone|ipad|built-in|internal|speaker|speakerphone|receiver|earpiece|default|communications)\b/i;
/** Names that are worn: headphones, earbuds, a headset. */
const WORN = /\b(airpods|earpods|beats|head(phones?|set)|ear(buds?|phones?)|buds|wired)\b/i;

/**
 * What audio the phone is using, from the names of its audio devices (spec §10.5): the one input in use, while the microphone is
 * open, else those present. A name nobody listed is unknown, never headphones (the iPhone trace, 2026-10-22: "headphones" on the
 * phone's own speaker). Browsers name devices only after the microphone was allowed: without names, annai can't tell.
 * @param {{ kind: string, label: string }[]} devices @returns {Route}
 */
export function routeOf(devices) {
  const named = devices.filter((d) => (d.kind === 'audioinput' || d.kind === 'audiooutput') && d.label);
  if (!named.length) return 'unknown';
  const others = named.filter((d) => !OWN.test(d.label));
  if (others.some((d) => CAR.test(d.label))) return 'car';
  if (others.some((d) => WORN.test(d.label))) return 'headphones';
  return others.length ? 'unknown' : 'speaker';
}

/**
 * What the voice chip adds for Koe while voice is on (the user, 2026-10-22: "how koe work or in which mode it is"), from Halves' way:
 * the list that talks; when Classic stands in for a chosen Realtime, why, in reason (kept on one line); Koe down; Classic chosen
 * but empty, when Shiori is one. note: the menu's sentence. Nothing with voice off, no Koe model, or a way worked out with voice off.
 * @param {{ mode: string, using: string, why: string, koe: boolean, split: boolean, path: string | null } | null} way @param {boolean} on
 * @returns {{ text: string, reason?: string, note: string }}
 */
export function koeWords(way, on) {
  if (!way?.koe || !on || way.why === 'voice off') return { text: '', note: '' };
  if (way.using === 'realtime') return { text: ' · Realtime', note: '' };
  const realtime = way.mode === 'realtime';
  if (!way.path && way.split) {
    return realtime && way.why !== 'none' ? { text: ` · Realtime ${way.why === 'off' ? 'off' : 'resting'}`, note: 'Shiori answers directly until it can.' }
      : { text: ' · Classic unavailable', note: "Koe · Classic can't answer now. Shiori answers directly until it can." };
  }
  if (!way.split) return { text: ' · Classic', reason: '(no model)', note: 'Koe · Classic has no model, so Shiori answers as one. Add one in Settings → Models.' };
  if (!realtime || !way.why) return { text: ' · Classic', note: '' };
  return {
    none: { text: ' · Classic', reason: '(no Realtime model)', note: 'Realtime has no model: add one under Koe · Realtime in Settings → Models. Classic talks meanwhile.' },
    resting: { text: ' · Classic', reason: '(Realtime resting)', note: 'Realtime is resting after a failure. Classic talks until it can.' },
  }[way.why] ?? { text: ' · Classic', reason: '(Realtime off)', note: "Realtime's live voice is switched off, or its plugin isn't running. Classic talks meanwhile." };
}

/** The chip's words: "Voice auto · off", "Voice on · car audio", "Voice on", "Voice off". @param {VoiceMode} m */
export function chipText(m) {
  if (m.setting === 'auto') return m.on ? `Voice on · ${m.why}` : 'Voice auto · off';
  return m.on ? 'Voice on' : 'Voice off';
}
