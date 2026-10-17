/** The most of a server's answer annai reads as JSON: 8 MiB. */
export const ANSWER_MAX = 8 * 1024 * 1024;

/**
 * A server's answer, as JSON. Whatever is wrong with it (an error status, cut off, too large, not
 * JSON) is the server's doing, so it is a plain Error that says so: a TypeError or SyntaxError would
 * count as a bug in the plugin that asked (spec §5.5), and three of those turn the plugin off.
 * A stopped request stays an AbortError.
 * @param {Response} res @param {string} where the server, as the user knows it ("en.wikipedia.org")
 * @param {number} [max] the most characters read
 * @returns {Promise<any>}
 */
export async function answerJSON(res, where, max = ANSWER_MAX) {
  if (!res.ok) throw Object.assign(new Error(`${where} answered ${res.status}.`), { status: res.status });
  /** @type {string} */
  let text;
  try {
    text = await res.text();
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
    throw new Error(`${where}'s answer was cut off.`);
  }
  if (text.length > max) throw new Error(`${where} sent more than annai reads (${Math.round(max / 1_048_576)} MB).`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${where} sent an answer annai can't read.`);
  }
}
