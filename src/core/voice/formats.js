/**
 * Audio formats by file kind, as providers name them (spec §10.6). The smallest is chosen by codec in
 * annai's order, then by the receiver's own. 'opus' is OpenAI's name for Ogg Opus.
 */
export const FORMATS = /** @type {Record<string, string>} */ ({
  ogg: 'audio/ogg', webm: 'audio/webm', opus: 'audio/ogg', mp4: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav',
});
export const CODEC_ORDER = [['ogg', 'webm', 'opus'], ['mp4', 'aac'], ['mp3'], ['flac'], ['wav']];

/** @param {string} format */
export const mediaTypeOf = (format) => FORMATS[format] ?? 'application/octet-stream';
/** @param {string} type @returns {string | null} */
export function formatOf(type) {
  const t = String(type).split(';')[0].trim().toLowerCase().replace('/x-wav', '/wav');
  return Object.keys(FORMATS).find((f) => FORMATS[f] === t) ?? null;
}
/** @param {string} format */
export const rankOf = (format) => {
  const i = CODEC_ORDER.findIndex((g) => g.includes(format));
  return i < 0 ? Infinity : i;
};

/** @param {string[]} wants @param {string[]} has */
function pick(wants, has) {
  const types = new Set(has.map(mediaTypeOf));
  for (const group of CODEC_ORDER) {
    const hit = wants.find((f) => group.includes(f) && types.has(mediaTypeOf(f)));
    if (hit) return hit;
  }
  return null;
}

/** What to send: the receiver's name for the smallest format it takes and the phone makes (WAV always). @param {string[]} accepts @param {string[]} makes */
export const pickFormat = (accepts, makes) => pick(accepts, [...makes, 'wav']);
/** What to ask a voice for: the smallest it offers that the phone plays. @param {string[]} offers @param {string[]} plays */
export const pickOut = (offers, plays) => pick(offers, plays);

/** Whether a chat model's bad request is about its audio: then it gets WAV. @param {string} message */
export const formatRefused = (message) => /audio|format|codec|wav|mp3|ogg|webm|m4a|mp4|flac|aac/i.test(message);
