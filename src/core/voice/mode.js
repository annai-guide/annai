/**
 * Voice (spec §10.5): one tap on or off. With the setting off, voice is on for the exchange a tap on Shiori starts, and while driving (GPS on).
 * @typedef {'on' | 'off'} VoiceSetting
 * @typedef {'car' | 'headphones' | 'speaker' | 'unknown'} Route
 * @typedef {{ setting: VoiceSetting, on: boolean, why: 'on' | 'off' | 'tapped' | 'driving' }} VoiceMode
 */
import { t } from '../l10n.js';

/**
 * @param {{ setting: VoiceSetting, driving?: boolean, tapped?: boolean }} c
 *   driving: moving fast, or a moment after (a light, a queue); tapped: a tap on Shiori holds voice on until that exchange ends
 * @returns {VoiceMode}
 */
export function voiceMode({ setting, driving = false, tapped = false }) {
  if (setting === 'on') return { setting, on: true, why: 'on' };
  if (tapped) return { setting, on: true, why: 'tapped' };
  if (driving) return { setting, on: true, why: 'driving' };
  return { setting, on: false, why: 'off' };
}

/** Why voice is on with the setting off, for the now block (the models' English), else nothing. @param {VoiceMode} [m] */
export function voiceWhy(m) {
  /* en */
  return m?.why === 'driving' ? 'while driving' : m?.why === 'tapped' ? 'the user tapped Shiori, for this exchange' : '';
}

/** Names that are a car. */
const CAR = /\b(car|carplay|android auto|hands-?free|uconnect|sync|bmw|audi|mercedes|toyota|honda|ford|kia|hyundai|lexus|nissan|mazda|subaru|volvo|tesla|vw|volkswagen|jeep|chevrolet|chevy|gmc|porsche|mini|skoda|renault|peugeot|citroen|fiat)\b/i;
/** Names that are the phone's (or computer's) own. */
const OWN = /\b(iphone|ipad|built-in|internal|speaker|speakerphone|receiver|earpiece|default|communications)\b/i;
/** Names that are worn: headphones, earbuds, a headset. */
const WORN = /\b(airpods|earpods|beats|head(phones?|set)|ear(buds?|phones?)|buds|wired)\b/i;

/**
 * What audio the phone is using, from the names of its audio devices (spec §10.4): whether speaking may cut a live Koe off, and the Trace's
 * voice.route. It never turns voice on or off. The one input in use, while the microphone is open, else those present. A name nobody listed
 * is unknown, never headphones (an iPhone's own speaker read as headphones). Browsers name devices only after the microphone was allowed.
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
 * The voice chip's words (spec §10.5): "Voice on" or "Voice off", and "Voice on · driving" while driving is why it's on. No other reason shows.
 * @param {VoiceMode} m
 */
export function chipText(m) {
  if (!m.on) return t`Voice off`;
  return m.why === 'driving' ? t`Voice on · driving` : t`Voice on`;
}

/** The note when voice turned itself off, saying why; for a device, the input that went, if it had a name. @param {'drive' | 'device'} why @param {string} [name] */
export function offNote(why, name = '') {
  if (why === 'drive') return t`Voice off: you stopped driving`;
  return name ? t`Voice off: ${name} disconnected` : t`Voice off: the microphone disconnected`;
}
