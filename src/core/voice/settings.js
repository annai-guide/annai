/**
 * Settings → Voice (spec §10), with their defaults, from the app settings' "voice" entry.
 * @typedef {{ mode: 'on' | 'off', pauseMs: number, silenceSeconds: number, firstWordsSeconds: number, keepClips: boolean, browserVoice: string, rate: number,
 *   closeAfterSeconds: number, bargeIn: boolean }} VoiceSettings
 *   mode: voice On or Off (§10.5; a saved 'auto', or anything else, reads as Off); pauseMs: the pause that ends a sentence (§10.2); silenceSeconds: how long speak listens for an
 *   answer (§7.1); firstWordsSeconds: how long her first words may take with voice on (§9.6); keepClips: keep what the microphone heard
 *   (§10.2); browserVoice: the system voice's id ('' for automatic: one on this phone when there is one, §11.7); rate: its speed;
 *   closeAfterSeconds: the quiet spell that closes a live session (K5,
 *   decision 12); bargeIn: speaking cuts a live Koe off (decision 13) with headphones or car audio only (§10.4), a tap always does
 */
export const VOICE_DEFAULTS = Object.freeze({ mode: 'off', pauseMs: 700, silenceSeconds: 20, firstWordsSeconds: 15, keepClips: false, browserVoice: '', rate: 1, closeAfterSeconds: 30, bargeIn: true });

/** @param {Record<string, any>} app the app settings @returns {VoiceSettings} */
export function voiceSettings(app) {
  const v = app?.voice ?? {};
  const within = (/** @type {unknown} */ x, /** @type {number} */ lo, /** @type {number} */ hi, /** @type {number} */ d) => (typeof x === 'number' && x >= lo && x <= hi ? x : d);
  return {
    mode: v.mode === 'on' ? 'on' : 'off',
    pauseMs: within(v.pauseMs, 300, 3000, VOICE_DEFAULTS.pauseMs),
    silenceSeconds: within(v.silenceSeconds, 2, 60, VOICE_DEFAULTS.silenceSeconds),
    firstWordsSeconds: within(v.firstWordsSeconds, 5, 120, VOICE_DEFAULTS.firstWordsSeconds),
    keepClips: v.keepClips === true,
    browserVoice: typeof v.browserVoice === 'string' ? v.browserVoice : VOICE_DEFAULTS.browserVoice,
    rate: within(v.rate, 0.5, 2, VOICE_DEFAULTS.rate),
    closeAfterSeconds: within(v.closeAfterSeconds, 10, 300, VOICE_DEFAULTS.closeAfterSeconds),
    bargeIn: v.bargeIn !== false,
  };
}
