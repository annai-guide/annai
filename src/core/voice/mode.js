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
const OWN = /\b(iphone|ipad|built-in|internal|speakerphone|earpiece|default|communications)\b/i;

/**
 * What audio the phone is using, from the names of its audio devices (spec §10.5). Browsers name
 * devices only after the microphone was allowed: without names, annai can't tell.
 * @param {{ kind: string, label: string }[]} devices @returns {Route}
 */
export function routeOf(devices) {
  const named = devices.filter((d) => (d.kind === 'audioinput' || d.kind === 'audiooutput') && d.label);
  if (!named.length) return 'unknown';
  const others = named.filter((d) => !OWN.test(d.label));
  if (others.some((d) => CAR.test(d.label))) return 'car';
  return others.length ? 'headphones' : 'speaker';
}

/** The chip's words: "Voice auto · off", "Voice on · car audio", "Voice on", "Voice off". @param {VoiceMode} m */
export function chipText(m) {
  if (m.setting === 'auto') return m.on ? `Voice on · ${m.why}` : 'Voice auto · off';
  return m.on ? 'Voice on' : 'Voice off';
}
