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

/**
 * A server's answer, as bytes, read no further than max. Whatever is wrong with it (an error status,
 * cut off, too large) is a plain Error that says so; a stopped request stays an AbortError.
 * @param {Response} res @param {string} where the server, as the user knows it @param {number} [max] the most bytes read
 * @returns {Promise<Uint8Array>}
 */
export async function answerBytes(res, where, max = ANSWER_MAX) {
  if (!res.ok) throw Object.assign(new Error(`${where} answered ${res.status}.`), { status: res.status });
  const tooMuch = () => new Error(`${where} sent more than annai reads (${Math.max(1, Math.round(max / 1_048_576))} MB).`);
  if (Number(res.headers.get('content-length')) > max) {
    res.body?.cancel().catch(() => {});
    throw tooMuch();
  }
  /** @type {Uint8Array[]} */
  const chunks = [];
  let n = 0;
  let over = false;
  try {
    const reader = res.body?.getReader();
    for (;;) {
      const step = reader ? await reader.read() : { done: true, value: undefined };
      if (step.done || !step.value) break;
      n += step.value.byteLength;
      if (n > max) {
        over = true;
        await reader?.cancel().catch(() => {});
        break;
      }
      chunks.push(step.value);
    }
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
    throw new Error(`${where}'s answer was cut off.`);
  }
  if (over) throw tooMuch();
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
