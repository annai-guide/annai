/**
 * Audio formats (spec §10; Koe and Kokoro design, "Audio formats"): named by file kind, as
 * providers name what they take. Speech travels in the smallest format both sides handle,
 * chosen by codec in annai's order (Opus, then AAC, MP3, FLAC, WAV last), and within a codec
 * by the receiver's own order. 'opus' is OpenAI's name for Ogg Opus.
 */
export const FORMATS = /** @type {Record<string, string>} */ ({
  ogg: 'audio/ogg', webm: 'audio/webm', opus: 'audio/ogg', mp4: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav',
});
export const CODEC_ORDER = [['ogg', 'webm', 'opus'], ['mp4', 'aac'], ['mp3'], ['flac'], ['wav']];

/** @param {string} format */
export const mediaTypeOf = (format) => FORMATS[format] ?? 'application/octet-stream';
/** The file kind of a media type, or null. @param {string} type */
export function formatOf(type) {
  const t = String(type).split(';')[0].trim().toLowerCase().replace('/x-wav', '/wav');
  return Object.keys(FORMATS).find((f) => FORMATS[f] === t) ?? null;
}
/** Where a format's codec stands in annai's order: 0 is the smallest. @param {string} format */
export const rankOf = (format) => {
  const i = CODEC_ORDER.findIndex((g) => g.includes(format));
  return i < 0 ? Infinity : i;
};

/** The first of wants, by codec in annai's order, that has holds in the same kind of file. @param {string[]} wants @param {string[]} has */
function pick(wants, has) {
  const types = new Set(has.map(mediaTypeOf));
  for (const group of CODEC_ORDER) {
    const hit = wants.find((f) => group.includes(f) && types.has(mediaTypeOf(f)));
    if (hit) return hit;
  }
  return null;
}

/**
 * What to send: the smallest format the receiver accepts and the device makes. annai always makes
 * WAV itself, the last resort. @param {string[]} accepts the receiver's, its preferred first @param {string[]} makes
 * @returns {string | null} in the receiver's name; null when it takes nothing annai can make
 */
export const pickFormat = (accepts, makes) => pick(accepts, [...makes, 'wav']);

/** What to ask a voice for: the smallest format it offers that the device plays. @param {string[]} offers @param {string[]} plays */
export const pickOut = (offers, plays) => pick(offers, plays);

/** Whether a provider's refusal (a bad request) is about the audio's format: then WAV is sent instead. @param {string} message */
export const formatRefused = (message) => /audio|format|codec|wav|mp3|ogg|webm|m4a|mp4|flac|aac/i.test(message);
