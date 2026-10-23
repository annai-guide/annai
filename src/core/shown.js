/**
 * What the Conversation and the dock show (spec §2 principle 4, §16.1), from the app settings' "shiori" entry. Both are on until the
 * user switches one off, in Settings → Voice ("Show what she says") and Settings → Shiori ("Show what Koe and Kokoro tell each other").
 * @typedef {{ showWords: boolean, showHalves: boolean }} ShownSettings
 *   showWords: her spoken lines show their words in the conversation, and the dock's bubble shows them while she speaks; off, a spoken
 *   line folds behind "Show what she said" and there is no bubble. showHalves: what the halves tell each other shows in the conversation
 * @param {Record<string, any> | undefined} app the app settings @returns {ShownSettings}
 */
export function shownSettings(app) {
  const s = app?.shiori ?? {};
  return { showWords: s.showWords !== false, showHalves: s.showHalves !== false };
}
