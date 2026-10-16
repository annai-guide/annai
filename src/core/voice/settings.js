/**
 * Settings → Voice (spec §10), with their defaults, from the app settings' "voice" entry.
 * @typedef {{ pauseMs: number, browserVoice: string, rate: number }} VoiceSettings
 *   pauseMs: the pause that ends a sentence (§10.2); browserVoice: the system voice's id ('' for the browser's choice); rate: its speed
 */
export const VOICE_DEFAULTS = Object.freeze({ pauseMs: 700, browserVoice: '', rate: 1 });

/** @param {Record<string, any>} app the app settings @returns {VoiceSettings} */
export function voiceSettings(app) {
  const v = app?.voice ?? {};
  const within = (/** @type {unknown} */ x, /** @type {number} */ lo, /** @type {number} */ hi, /** @type {number} */ d) => (typeof x === 'number' && x >= lo && x <= hi ? x : d);
  return {
    pauseMs: within(v.pauseMs, 300, 3000, VOICE_DEFAULTS.pauseMs),
    browserVoice: typeof v.browserVoice === 'string' ? v.browserVoice : VOICE_DEFAULTS.browserVoice,
    rate: within(v.rate, 0.5, 2, VOICE_DEFAULTS.rate),
  };
}
