import { t } from './l10n.js';
import { size } from './intl.js';

/**
 * What was wrong with reaching a server or with its answer, as data (an error carries it as said): where is the server as the user knows
 * it; info, the browser's own words for a request it couldn't make. The log and a model read the error's English message; a screen shows
 * its shown words, made here, and a hold or a pack's failure keeps said (backup.js, pack/download.js): the one vocabulary for servers.
 * @typedef {{ code: 'status', where: string, status: number } | { code: 'unreadable' | 'cut', where: string } | { code: 'too-much', where: string, mb: number }
 *   | { code: 'unreachable', where: string, info?: string }} AnswerSaid
 */

/** The codes answerWords knows. */
export const ANSWER_CODES = new Set(['status', 'unreadable', 'cut', 'too-much', 'unreachable']);

/** An answer's problem in the screens' words, from its data. @param {AnswerSaid} s */
export function answerWords(s) {
  const { where } = s;
  if (s.code === 'unreachable') return s.info ? t`annai couldn't reach ${where} (${s.info}). Is the device offline?` : t`annai couldn't reach ${where}. Is the device offline?`;
  if (s.code === 'status') return t`${where} answered ${s.status}.`;
  if (s.code === 'unreadable') return t`${where} sent an answer annai can't read.`;
  if (s.code === 'too-much') return t`${where} sent more than annai reads (${size(s.mb * 1_048_576)}).`;
  return t`${where}'s answer was cut off.`;
}

/** An error by the shown rule: message in annai's English, said its data, shown its words. @param {string} en @param {AnswerSaid} said */
const fault = (en, said) => Object.assign(new Error(en), { said, shown: answerWords(said) });

/** The most of a server's answer annai reads as JSON: 8 MiB. */
export const ANSWER_MAX = 8 * 1024 * 1024;

/**
 * A server's answer, as JSON, read no further than max (answerBytes). Whatever is wrong with it (an
 * error status, cut off, too large, not JSON) is the server's doing, so it is a plain Error that says
 * so: a TypeError or SyntaxError would count as a bug in the plugin that asked (spec §5.5), and three
 * of those turn the plugin off. A stopped request stays an AbortError.
 * @param {Response} res @param {string} where the server, as the user knows it ("en.wikipedia.org")
 * @param {number} [max] the most bytes read
 * @returns {Promise<any>}
 */
export async function answerJSON(res, where, max = ANSWER_MAX) {
  const bytes = await answerBytes(res, where, max);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw fault(/* en */ `${where} sent an answer annai can't read.`, { code: 'unreadable', where });
  }
}

/**
 * A server's answer, as bytes, read no further than max. Whatever is wrong with it (an error status,
 * cut off, too large) is a plain Error that says so; a stopped request stays an AbortError.
 * @param {Response} res @param {string} where the server, as the user knows it @param {number} [max] the most bytes read
 * @returns {Promise<Uint8Array>}
 */
export async function answerBytes(res, where, max = ANSWER_MAX) {
  if (!res.ok) throw Object.assign(fault(/* en */ `${where} answered ${res.status}.`, { code: 'status', where, status: res.status }), { status: res.status });
  const mb = Math.max(1, Math.round(max / 1_048_576));
  const tooMuch = () => fault(/* en */ `${where} sent more than annai reads (${mb} MB).`, { code: 'too-much', where, mb });
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
    throw fault(/* en */ `${where}'s answer was cut off.`, { code: 'cut', where });
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
